'use client';

import { Fragment, useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';
import { useDemoSession } from '@/lib/context/DemoSessionContext';
import { ROUND_LABELS } from '@/lib/constants/rounds';
import { groupAndMergeSlots } from '@/lib/utils/mergePlayerRounds';
import { playedRoundStages } from '@/lib/utils/roundVisibility';
import { RoundCellBadge } from '@/components/RoundCellBadge';
import { InjuryBadge } from '@/components/InjuryBadge';

const DEMO_LEAGUE_ID = process.env.NEXT_PUBLIC_DEMO_LEAGUE_ID ?? '00000000-0000-0000-0000-000000000001';

interface Standing {
  user_id: string;
  display_name: string;
  total_points: number;
  per_round: Record<string, number>;
}

// Per-slot data fetched when expanding a user row.
interface SlotDetail {
  slot_key: string;
  player_id: string;
  slot_position: string;
  is_bench: boolean;
  is_active: boolean;
  player_name: string;
  team_name: string;
  team_seed: number;
  injury_status: 'active' | 'day_to_day' | 'out' | null;
  injury_note: string | null;
  injury_updated_at: string | null;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
  // Credited points (from scoring_events — count toward user total)
  counted_pts: Record<string, number>;
  // Raw game points (from game_scores — actual player performance regardless of bench/elim)
  raw_pts: Record<string, number>;
}

function getRankLabel(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export default function DemoLeaguePage() {
  const [standings, setStandings] = useState<Standing[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<'standings' | 'rounds'>('standings');
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [slotCache, setSlotCache] = useState<Map<string, SlotDetail[]>>(new Map());
  const [slotLoading, setSlotLoading] = useState<Set<string>>(new Set());
  const [leagueSeason, setLeagueSeason] = useState<number | null>(null);
  const [archivedSeasonCount, setArchivedSeasonCount] = useState(0);
  const [leagueMissing, setLeagueMissing] = useState(false);
  const { setDemoSession } = useDemoSession();

  useEffect(() => {
    async function load() {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        const { data: anonData } = await supabase.auth.signInAnonymously();
        if (anonData.user && anonData.session) {
          fetch('/api/demo/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: anonData.user.id }),
          }).catch(() => {});
          const { session } = anonData;
          const expires_at = session.expires_at
            ? new Date(session.expires_at * 1000).toISOString()
            : new Date(Date.now() + session.expires_in * 1000).toISOString();
          setDemoSession({ access_token: session.access_token, expires_at });
        }
      }

      // Gate on the league row itself existing before doing anything else — if
      // NEXT_PUBLIC_DEMO_LEAGUE_ID is unset (falls back to a dummy UUID above),
      // misconfigured, or the row was cleaned up, there's nothing to show. This
      // is distinct from "league exists but has no scores yet" (handled below).
      const { data: league, error: leagueError } = await supabase
        .from('leagues')
        .select('season')
        .eq('id', DEMO_LEAGUE_ID)
        .maybeSingle();

      if (leagueError || !league) {
        setLeagueMissing(true);
        setLoading(false);
        return;
      }

      if (league.season) {
        setLeagueSeason(league.season);
      }

      // Once the league gate passes, these three reads are independent — the
      // archived-season count needs only league.season, the standings snapshots
      // and the scoring events need only the league id. Run them together instead
      // of as three sequential round-trips. Both tables are readable anonymously
      // for demo leagues (is_demo RLS).
      //
      // Season indicator: the demo seeder creates a prior-season completed
      // draft_sessions stub (seedDemoData.ts step 11) specifically to prove
      // multi-season support — surface it as an "archived seasons" count.
      const [{ count: archivedCount }, { data: snapshots }, { data: events }] = await Promise.all([
        league.season
          ? supabase
              .from('draft_sessions')
              .select('id', { count: 'exact', head: true })
              .eq('league_id', DEMO_LEAGUE_ID)
              .lt('season', league.season)
          : Promise.resolve({ count: 0 }),
        supabase
          .from('leaderboard_snapshots')
          .select('user_id, total_points')
          .eq('league_id', DEMO_LEAGUE_ID)
          .order('total_points', { ascending: false }),
        supabase
          .from('scoring_events')
          .select('user_id, round_stage, points_credited')
          .eq('league_id', DEMO_LEAGUE_ID),
      ]);

      if (league.season) {
        setArchivedSeasonCount(archivedCount ?? 0);
      }

      if (!snapshots?.length) { setLoading(false); return; }

      const userIds = snapshots.map((s) => s.user_id);
      const { data: users } = await supabase.from('users').select('id, display_name').in('id', userIds);
      const nameMap = Object.fromEntries((users ?? []).map((u) => [u.id, u.display_name]));

      const perRoundMap: Record<string, Record<string, number>> = {};
      for (const e of (events ?? [])) {
        perRoundMap[e.user_id] ??= {};
        perRoundMap[e.user_id][e.round_stage] = (perRoundMap[e.user_id][e.round_stage] ?? 0) + e.points_credited;
      }

      setStandings(snapshots.map((s, i) => ({
        ...s,
        display_name: nameMap[s.user_id] ?? `Player ${i + 1}`,
        per_round: perRoundMap[s.user_id] ?? {},
      })));
      setLoading(false);
    }
    load();
  }, [setDemoSession]);

  async function toggleExpand(user_id: string) {
    if (expandedUsers.has(user_id)) {
      setExpandedUsers((prev) => { const next = new Set(prev); next.delete(user_id); return next; });
      return;
    }
    setExpandedUsers((prev) => new Set(prev).add(user_id));
    if (slotCache.has(user_id)) return;

    setSlotLoading((prev) => new Set(prev).add(user_id));
    try {
      // 1. Roster slots with lifecycle fields
      type SlotRaw = {
        id: string; slot_key: string; slot_position: string; is_bench: boolean; is_active: boolean;
        player_id: string; acquired_at_round_stage: string; released_at_round_stage: string | null;
        players: {
          name: string;
          injury_status: 'active' | 'day_to_day' | 'out' | null;
          injury_note: string | null;
          injury_updated_at: string | null;
          teams: { name: string; seed: number } | { name: string; seed: number }[] | null;
        } | null;
      };
      const { data: slots } = await supabase
        .from('roster_slots')
        .select('id, slot_key, slot_position, is_bench, is_active, player_id, acquired_at_round_stage, released_at_round_stage, players(name, injury_status, injury_note, injury_updated_at, teams(name, seed))')
        .eq('league_id', DEMO_LEAGUE_ID)
        .eq('user_id', user_id)
        .order('is_bench')
        .order('slot_key');

      if (!slots?.length) {
        setSlotCache((prev) => new Map(prev).set(user_id, []));
        return;
      }

      const typedSlots = slots as unknown as SlotRaw[];
      const playerIds = [...new Set(typedSlots.map((s) => s.player_id))];

      // Both remaining reads only depend on the roster slots already fetched — the
      // credited-points lookup keys off user_id, the raw game scores off playerIds —
      // and neither depends on the other, so fetch them concurrently.
      //
      // 2. Credited points (scoring_events) for this user — attributed to the specific
      // roster_slot row that earned them (a bench stint and a later promoted starter
      // stint for the same player are different rows with different totals; keying by
      // player_id alone would show the same combined total on both).
      // 3. Raw game points (game_scores) for all player_ids — includes bench and elimination rounds
      const [{ data: events }, { data: gameScores }] = await Promise.all([
        supabase
          .from('scoring_events')
          .select('player_id, roster_slot_id, round_stage, points_credited')
          .eq('league_id', DEMO_LEAGUE_ID)
          .eq('user_id', user_id),
        supabase
          .from('game_scores')
          .select('player_id, round_stage, points')
          .in('player_id', playerIds),
      ]);

      const countedBySlot: Record<string, Record<string, number>> = {};
      const countedByPlayerFallback: Record<string, Record<string, number>> = {};
      for (const e of (events ?? [])) {
        if (e.roster_slot_id) {
          countedBySlot[e.roster_slot_id] ??= {};
          countedBySlot[e.roster_slot_id][e.round_stage] = (countedBySlot[e.roster_slot_id][e.round_stage] ?? 0) + e.points_credited;
        } else {
          countedByPlayerFallback[e.player_id] ??= {};
          countedByPlayerFallback[e.player_id][e.round_stage] = (countedByPlayerFallback[e.player_id][e.round_stage] ?? 0) + e.points_credited;
        }
      }
      const slotCountByPlayer: Record<string, number> = {};
      for (const s of typedSlots) slotCountByPlayer[s.player_id] = (slotCountByPlayer[s.player_id] ?? 0) + 1;

      const rawMap: Record<string, Record<string, number>> = {};
      for (const gs of (gameScores ?? [])) {
        rawMap[gs.player_id] ??= {};
        rawMap[gs.player_id][gs.round_stage] = (rawMap[gs.player_id][gs.round_stage] ?? 0) + gs.points;
      }

      const mapped: SlotDetail[] = typedSlots.map((s) => {
        const p = s.players;
        const team = Array.isArray(p?.teams) ? p?.teams[0] : p?.teams;
        const counted_pts = countedBySlot[s.id] ?? (
          slotCountByPlayer[s.player_id] === 1 ? countedByPlayerFallback[s.player_id] ?? {} : {}
        );
        return {
          slot_key: s.slot_key,
          player_id: s.player_id,
          slot_position: s.slot_position,
          is_bench: s.is_bench,
          is_active: s.is_active,
          player_name: p?.name ?? '—',
          team_name: team?.name ?? '—',
          team_seed: team?.seed ?? 0,
          injury_status: p?.injury_status ?? null,
          injury_note: p?.injury_note ?? null,
          injury_updated_at: p?.injury_updated_at ?? null,
          acquired_at_round_stage: s.acquired_at_round_stage,
          released_at_round_stage: s.released_at_round_stage,
          counted_pts,
          raw_pts: rawMap[s.player_id] ?? {},
        };
      });
      setSlotCache((prev) => new Map(prev).set(user_id, mapped));
    } finally {
      setSlotLoading((prev) => { const next = new Set(prev); next.delete(user_id); return next; });
    }
  }

  // Rounds where any user has a scoring_events row — used to decide which round
  // columns to show. Presence, not value — see playedRoundStages() for why: a
  // `> 0` filter here previously made a round vanish entirely whenever every
  // league member's starters happened to score zero that round.
  const visibleRounds = playedRoundStages(standings.map((s) => s.per_round));

  return (
    <div className="min-h-screen bg-black text-white" style={{ fontFamily: 'system-ui, sans-serif' }}>
      {/* Nav */}
      <nav className="flex items-center justify-between border-b border-neutral-900 px-6 py-4 sm:px-10">
        <Link href="/" className="text-sm font-black uppercase tracking-widest text-yellow-400">
          March Madness Fantasy
        </Link>
        <div className="flex items-center gap-3">
          <Link href="/auth/login" className="text-sm font-medium text-neutral-400 hover:text-white">Sign in</Link>
          <Link
            href="/auth/signup"
            className="rounded bg-yellow-400 px-4 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300"
          >
            Get started
          </Link>
        </div>
      </nav>

      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-1">
          <Link href="/" className="text-sm text-yellow-400 hover:underline">← Back to home</Link>
        </div>

        <div className="mb-6 flex items-start justify-between gap-4">
          <div>
            <span className="mb-2 inline-block rounded-full border border-yellow-400/30 bg-yellow-400/10 px-2.5 py-0.5 text-xs font-medium text-yellow-400">
              Demo League · Read-only
            </span>
            <h1 className="text-2xl font-bold text-white">March Madness Fantasy 2026</h1>
            <p className="mt-1 text-sm text-neutral-500">
              Full tournament season snapshot
              {leagueSeason !== null && archivedSeasonCount > 0 && (
                <span className="text-neutral-600">
                  {' '}· Season {leagueSeason} · {archivedSeasonCount} archived season{archivedSeasonCount === 1 ? '' : 's'}
                </span>
              )}
            </p>
          </div>
          <Link
            href="/demo/draft"
            className="shrink-0 rounded border border-neutral-700 bg-neutral-900 px-4 py-2 text-sm font-semibold text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400"
          >
            Try Mock Draft
          </Link>
        </div>

        {loading ? (
          <div className="py-20 text-center text-neutral-500">Loading standings…</div>
        ) : leagueMissing ? (
          <div className="mx-auto max-w-sm rounded-lg border border-neutral-800 bg-neutral-900 p-10 text-center">
            <p className="font-medium text-neutral-300">The demo season isn&apos;t available right now.</p>
            <div className="mt-5 flex justify-center gap-3">
              <Link
                href="/"
                className="rounded border border-neutral-700 px-4 py-2 text-sm font-medium text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400"
              >
                Back home
              </Link>
              <Link
                href="/demo/draft"
                className="rounded bg-yellow-400 px-4 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300"
              >
                Try Mock Draft
              </Link>
            </div>
          </div>
        ) : standings.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-10 text-center">
            <p className="font-medium text-neutral-300">Demo data not loaded yet.</p>
            <p className="mt-2 text-sm text-neutral-500">
              Run{' '}
              <code className="rounded bg-neutral-800 px-1 font-mono text-xs">
                npx tsx --env-file=.env.local scripts/seed-demo-league.ts
              </code>
            </p>
          </div>
        ) : (
          <>
            <div className="mb-4 flex gap-2">
              {(['standings', 'rounds'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                    view === v
                      ? 'bg-yellow-400 text-black'
                      : 'border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400'
                  }`}
                >
                  {v === 'standings' ? 'Standings' : 'Round by Round'}
                </button>
              ))}
            </div>

            {view === 'standings' ? (
              <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-800 bg-black">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Rank</th>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Manager</th>
                      <th className="px-4 py-3 text-right font-medium text-neutral-300">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {standings.map((entry, i) => {
                      const rank = i + 1;
                      return (
                        <tr key={entry.user_id} className={rank === 1 ? 'bg-yellow-400/10' : ''}>
                          <td className="px-4 py-3 font-medium text-neutral-300">{getRankLabel(rank)}</td>
                          <td className="px-4 py-3 font-medium text-white">{entry.display_name}</td>
                          <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">
                            {Math.round(entry.total_points)}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-800 bg-black">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Manager</th>
                      {visibleRounds.map((r) => (
                        <th key={r} className="px-3 py-3 text-right font-medium text-neutral-300 whitespace-nowrap">
                          {ROUND_LABELS[r] ?? r}
                        </th>
                      ))}
                      <th className="px-4 py-3 text-right font-medium text-neutral-300">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {standings.map((entry, i) => {
                      const rank = i + 1;
                      const isExpanded = expandedUsers.has(entry.user_id);
                      const isLoadingSlots = slotLoading.has(entry.user_id);
                      const slots = slotCache.get(entry.user_id) ?? [];
                      return (
                        <Fragment key={entry.user_id}>
                          <tr className={rank === 1 ? 'bg-yellow-400/10' : ''}>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={() => toggleExpand(entry.user_id)}
                                className="flex items-center gap-1.5 text-left font-medium text-yellow-400 hover:underline"
                              >
                                <span className="w-2 shrink-0 text-xs text-neutral-500">
                                  {isExpanded ? '▼' : '▶'}
                                </span>
                                {entry.display_name}
                              </button>
                            </td>
                            {visibleRounds.map((r) => (
                              <td key={r} className="px-3 py-3 text-right text-neutral-300 tabular-nums">
                                {Math.round(entry.per_round[r] ?? 0)}
                              </td>
                            ))}
                            <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">
                              {Math.round(entry.total_points)}
                            </td>
                          </tr>

                          {isExpanded && isLoadingSlots && (
                            <tr className="bg-neutral-950">
                              <td
                                colSpan={visibleRounds.length + 2}
                                className="px-10 py-2 text-xs italic text-neutral-500"
                              >
                                Loading players…
                              </td>
                            </tr>
                          )}

                          {isExpanded && !isLoadingSlots && slots.length > 0 && (
                            <tr className="bg-neutral-950">
                              <td colSpan={visibleRounds.length + 2} className="px-0 pb-2">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-neutral-800">
                                      <th className="py-2 pl-10 pr-3 text-left font-bold text-white">Player</th>
                                      {visibleRounds.map((r) => (
                                        <th key={r} className="px-2 py-2 text-right font-bold text-white whitespace-nowrap">
                                          {ROUND_LABELS[r] ?? r}
                                        </th>
                                      ))}
                                      <th className="py-2 pl-3 pr-4 text-right font-bold text-white">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {/* One merged row per player — a bench-promoted player has two
                                        historical roster_slots rows (released bench stint + starter
                                        stint); groupAndMergeSlots collapses them, preferring
                                        counted > raw > elim > null per round. */}
                                    {groupAndMergeSlots(slots, visibleRounds).map((row) => (
                                      <tr key={row.player_id} className="border-b border-neutral-900 last:border-0">
                                        <td className="py-2 pl-10 pr-3">
                                          <span className={row.is_active ? 'font-medium text-neutral-300' : 'font-medium text-neutral-600'}>
                                            {row.latest.player_name}
                                          </span>
                                          <span className="ml-1 text-neutral-500">- {row.latest.team_name}</span>
                                          <span className="ml-1.5 text-neutral-600">{row.latest.slot_position}</span>
                                          {row.is_bench && (
                                            <span className="ml-1.5 rounded bg-neutral-800 px-1 py-0.5 text-neutral-500">B</span>
                                          )}
                                          {row.promoted_at_round_stage && (
                                            <span
                                              className="ml-1.5 rounded bg-yellow-400/10 px-1 py-0.5 text-yellow-500/90"
                                              title="Promoted from the bench when a starter's team was eliminated"
                                            >
                                              ↑ {ROUND_LABELS[row.promoted_at_round_stage] ?? row.promoted_at_round_stage}
                                            </span>
                                          )}
                                          {row.is_active && (
                                            <span className="ml-1.5 inline-block align-middle">
                                              <InjuryBadge
                                                status={row.latest.injury_status}
                                                note={row.latest.injury_note}
                                                updatedAt={row.latest.injury_updated_at}
                                              />
                                            </span>
                                          )}
                                        </td>
                                        {visibleRounds.map((stage) => (
                                          <td key={stage} className="px-2 py-2 text-right tabular-nums">
                                            <RoundCellBadge cell={row.cells[stage] ?? null} />
                                          </td>
                                        ))}
                                        <td className="py-2 pl-3 pr-4 text-right font-medium tabular-nums text-neutral-400">
                                          {Math.round(row.total)}
                                        </td>
                                      </tr>
                                    ))}
                                  </tbody>
                                </table>
                              </td>
                            </tr>
                          )}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}

        {/* CTA */}
        <div className="mt-10 rounded-lg border border-yellow-400/20 bg-yellow-400/5 p-6 text-center">
          <p className="font-semibold text-white">Ready to play for real?</p>
          <p className="mt-1 text-sm text-neutral-400">
            Create a league, invite friends, and draft your own team before the tournament.
          </p>
          <div className="mt-4 flex justify-center gap-3">
            <Link
              href="/auth/signup"
              className="rounded bg-yellow-400 px-5 py-2 text-sm font-black uppercase tracking-wide text-black hover:bg-yellow-300"
            >
              Create account
            </Link>
            <Link
              href="/"
              className="rounded border border-neutral-700 px-5 py-2 text-sm font-medium text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400"
            >
              Try as Commissioner
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
