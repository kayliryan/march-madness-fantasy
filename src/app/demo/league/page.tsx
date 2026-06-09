'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { supabase } from '@/lib/supabase/client';

const DEMO_LEAGUE_ID = process.env.NEXT_PUBLIC_DEMO_LEAGUE_ID ?? '00000000-demo-0000-0000-000000000001';
const ROUND_LABELS: Record<string, string> = {
  play_in: 'Play-In', r64: 'R64', r32: 'R32', s16: 'S16', e8: 'E8', f4: 'F4', championship: 'Champ',
};
const ROUNDS_IN_ORDER = ['play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship'];

interface Standing {
  user_id: string;
  display_name: string;
  total_points: number;
  active_player_count: number;
  per_round: Record<string, number>;
}

interface RosterSlot {
  slot_key: string;
  slot_position: string;
  is_bench: boolean;
  is_active: boolean;
  player_name: string;
  team_name: string;
  team_seed: number;
  avg_ppg: number;
  points_total: number;
}

export default function DemoLeaguePage() {
  const [standings, setStandings] = useState<Standing[]>([]);
  const [selectedUser, setSelectedUser] = useState<string | null>(null);
  const [roster, setRoster] = useState<RosterSlot[]>([]);
  const [loading, setLoading] = useState(true);
  const [rosterLoading, setRosterLoading] = useState(false);

  useEffect(() => {
    async function load() {
      // Ensure an anonymous session exists — users table RLS requires auth.uid() is not null
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        const { data: anonData } = await supabase.auth.signInAnonymously();
        if (anonData.user) {
          // Fire-and-forget: attach demo_viewer claim so write RLS blocks mutations
          fetch('/api/demo/session', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ user_id: anonData.user.id }),
          }).catch(() => {});
        }
      }

      // Query leaderboard_snapshots for demo league — readable via is_demo=true RLS
      const { data: snapshots } = await supabase
        .from('leaderboard_snapshots')
        .select('user_id, total_points, active_player_count')
        .eq('league_id', DEMO_LEAGUE_ID)
        .order('total_points', { ascending: false });

      if (!snapshots?.length) { setLoading(false); return; }

      const userIds = snapshots.map((s) => s.user_id);

      // Load user display names
      const { data: users } = await supabase
        .from('users')
        .select('id, display_name')
        .in('id', userIds);
      const nameMap = Object.fromEntries((users ?? []).map((u) => [u.id, u.display_name]));

      // Load per-round points from scoring_events
      const { data: events } = await supabase
        .from('scoring_events')
        .select('user_id, round_stage, points_credited')
        .eq('league_id', DEMO_LEAGUE_ID);

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
  }, []);

  async function loadRoster(userId: string) {
    setRosterLoading(true);
    setSelectedUser(userId);

    const { data: slots } = await supabase
      .from('roster_slots')
      .select('slot_key, slot_position, is_bench, is_active, players(name, avg_ppg, teams(name, seed))')
      .eq('league_id', DEMO_LEAGUE_ID)
      .eq('user_id', userId)
      .order('is_bench')
      .order('slot_key');

    const { data: events } = await supabase
      .from('scoring_events')
      .select('player_id, points_credited')
      .eq('league_id', DEMO_LEAGUE_ID)
      .eq('user_id', userId);

    const pointsByPlayer: Record<string, number> = {};
    for (const e of (events ?? [])) {
      pointsByPlayer[e.player_id] = (pointsByPlayer[e.player_id] ?? 0) + e.points_credited;
    }

    type SlotRaw = {
      slot_key: string; slot_position: string; is_bench: boolean; is_active: boolean;
      players: { name: string; avg_ppg: number; id?: string; teams: { name: string; seed: number } | { name: string; seed: number }[] | null } | null;
    };

    setRoster((slots ?? []).map((s: unknown) => {
      const slot = s as SlotRaw;
      const p = slot.players;
      const team = Array.isArray(p?.teams) ? p?.teams[0] : p?.teams;
      return {
        slot_key: slot.slot_key,
        slot_position: slot.slot_position,
        is_bench: slot.is_bench,
        is_active: slot.is_active,
        player_name: p?.name ?? '—',
        team_name: team?.name ?? '—',
        team_seed: team?.seed ?? 0,
        avg_ppg: p?.avg_ppg ?? 0,
        points_total: 0, // scoring events don't have player_id in this query
      };
    }));

    setRosterLoading(false);
  }

  const activeRounds = ROUNDS_IN_ORDER.filter((r) =>
    standings.some((s) => (s.per_round[r] ?? 0) > 0)
  );

  const selectedStanding = standings.find((s) => s.user_id === selectedUser);

  return (
    <div className="min-h-screen bg-gray-50 px-4 py-8">
      <div className="mx-auto max-w-4xl">
        {/* Header */}
        <div className="mb-6">
          <div className="flex items-center justify-between">
            <div>
              <span className="inline-flex items-center rounded-full bg-indigo-100 px-2.5 py-0.5 text-xs font-medium text-indigo-700 mb-2">
                Demo League
              </span>
              <h1 className="text-2xl font-bold text-gray-900">March Madness Fantasy 2026</h1>
              <p className="mt-1 text-sm text-gray-500">Read-only demo — data through Elite Eight</p>
            </div>
            <Link
              href="/demo/draft"
              className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700"
            >
              Try Mock Draft
            </Link>
          </div>
        </div>

        {loading ? (
          <p className="text-gray-500">Loading standings…</p>
        ) : standings.length === 0 ? (
          <div className="rounded-lg border border-gray-200 bg-white p-8 text-center">
            <p className="text-gray-500">Demo data not loaded yet.</p>
            <p className="mt-1 text-sm text-gray-400">Run <code className="font-mono text-xs bg-gray-100 px-1 rounded">npx tsx --env-file=.env.local scripts/seed-demo-league.ts</code></p>
          </div>
        ) : (
          <div className="space-y-6">
            {/* Standings table */}
            <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
              <table className="min-w-full divide-y divide-gray-200">
                <thead className="bg-gray-50">
                  <tr>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Rank</th>
                    <th className="px-4 py-3 text-left text-xs font-medium uppercase tracking-wide text-gray-500">Manager</th>
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Total Pts</th>
                    {activeRounds.map((r) => (
                      <th key={r} className="px-3 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500 hidden sm:table-cell">
                        {ROUND_LABELS[r]}
                      </th>
                    ))}
                    <th className="px-4 py-3 text-right text-xs font-medium uppercase tracking-wide text-gray-500">Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {standings.map((s, i) => (
                    <tr
                      key={s.user_id}
                      className={`cursor-pointer hover:bg-gray-50 transition-colors ${selectedUser === s.user_id ? 'bg-indigo-50' : ''}`}
                      onClick={() => loadRoster(s.user_id)}
                    >
                      <td className="px-4 py-3 text-sm font-semibold text-gray-500">{i + 1}</td>
                      <td className="px-4 py-3 text-sm font-medium text-gray-900">{s.display_name}</td>
                      <td className="px-4 py-3 text-right text-sm font-bold text-gray-900">{s.total_points.toFixed(1)}</td>
                      {activeRounds.map((r) => (
                        <td key={r} className="px-3 py-3 text-right text-sm text-gray-500 hidden sm:table-cell">
                          {(s.per_round[r] ?? 0).toFixed(1)}
                        </td>
                      ))}
                      <td className="px-4 py-3 text-right text-sm text-gray-500">{s.active_player_count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            {/* Roster panel */}
            {selectedUser && (
              <div className="rounded-lg border border-gray-200 bg-white p-5 shadow-sm">
                <h2 className="mb-4 text-sm font-semibold text-gray-700">
                  {selectedStanding?.display_name}&apos;s Roster
                  <span className="ml-2 text-xs font-normal text-gray-400">(click a manager to view roster)</span>
                </h2>

                {rosterLoading ? (
                  <p className="text-sm text-gray-400">Loading…</p>
                ) : (
                  <div className="space-y-4">
                    {(['Starters', 'Bench'] as const).map((label) => {
                      const isBench = label === 'Bench';
                      const slots = roster.filter((s) => s.is_bench === isBench);
                      return (
                        <div key={label}>
                          <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-400">{label}</h3>
                          <div className="space-y-1">
                            {slots.map((s) => (
                              <div key={s.slot_key} className="flex items-center justify-between rounded-md border border-gray-100 px-3 py-2">
                                <div className="flex items-center gap-3">
                                  <span className="w-6 text-center text-xs font-medium text-gray-400">{s.slot_position}</span>
                                  <span className="text-sm font-medium text-gray-900">{s.player_name}</span>
                                  <span className="text-xs text-gray-400">{s.team_name} #{s.team_seed}</span>
                                </div>
                                <div className="flex items-center gap-3">
                                  <span className="text-xs text-gray-400">{s.avg_ppg} PPG</span>
                                  {!s.is_active && (
                                    <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-xs text-red-600">Elim</span>
                                  )}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            )}

            {/* CTA */}
            <div className="rounded-lg border border-indigo-100 bg-indigo-50 p-5">
              <p className="text-sm font-medium text-indigo-900">Ready to play for real?</p>
              <p className="mt-1 text-sm text-indigo-700">Create a league, invite friends, and draft your own team before the tournament starts.</p>
              <div className="mt-3 flex gap-3">
                <Link href="/auth/signup" className="rounded-md bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
                  Create account
                </Link>
                <Link href="/demo/draft" className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-indigo-600 border border-indigo-200 hover:bg-indigo-50">
                  Try mock draft
                </Link>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
