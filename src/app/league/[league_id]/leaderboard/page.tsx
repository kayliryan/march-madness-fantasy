'use client';

import { Fragment, useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import { supabase } from '@/lib/supabase/client';
import { ROUND_STAGE_ORDER, ROUND_LABELS } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';

interface StandingEntry {
  user_id: string;
  display_name: string;
  total_points: number;
  active_player_count: number;
  per_round: { round_stage: string; points: number }[];
  highest_single_game_points: number;
}

interface LeaderboardResponse {
  standings: StandingEntry[];
  scores_updating: boolean;
}

interface RosterSlotForRounds {
  id: string;
  player_id: string;
  player: { name: string; position: string; teams: { name: string; seed: number } | null } | null;
  per_round: { round_stage: string; points: number }[];
  total_points: number;
  is_bench: boolean;
  is_active: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
}

const ROUND_COLUMNS = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];

function roundPointsMap(per_round: { round_stage: string; points: number }[]) {
  const map = new Map<string, number>();
  for (const r of per_round) map.set(r.round_stage, r.points);
  return map;
}

type RoundCell =
  | { kind: 'counted'; value: number }    // credited to user total
  | { kind: 'raw'; value: number }        // played but not credited (bench or elim round)
  | { kind: 'elim' }                      // team no longer playing
  | null;

function getRoundContent(
  stage: RoundStage,
  countedPoints: Map<string, number>,
  rawPoints: Map<string, number>,
  slot: Pick<RosterSlotForRounds, 'is_bench' | 'acquired_at_round_stage' | 'released_at_round_stage'>,
): RoundCell {
  const stageIdx = ROUND_STAGE_ORDER.indexOf(stage);
  const acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
  const relIdx = slot.released_at_round_stage
    ? ROUND_STAGE_ORDER.indexOf(slot.released_at_round_stage as RoundStage)
    : ROUND_STAGE_ORDER.length;

  if (stageIdx < acqIdx) return null;

  if (slot.is_bench) {
    const inBenchPeriod = stageIdx < relIdx || (slot.released_at_round_stage !== null && stageIdx === relIdx);
    if (!inBenchPeriod) return null;
    const pts = rawPoints.get(stage);
    return pts !== undefined ? { kind: 'raw', value: pts } : null;
  }

  // Active player — in scoring window
  if (stageIdx < relIdx) {
    const pts = countedPoints.get(stage);
    return pts !== undefined ? { kind: 'counted', value: pts } : null;
  }

  // Elimination round — team played (and lost); show raw game score
  if (stageIdx === relIdx && slot.released_at_round_stage !== null) {
    const pts = rawPoints.get(stage);
    return pts !== undefined ? { kind: 'raw', value: pts } : null;
  }

  // After elimination
  return { kind: 'elim' };
}

function getRankLabel(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export default function LeaderboardPage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [data, setData] = useState<LeaderboardResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);
  const [view, setView] = useState<'standings' | 'rounds'>('standings');
  const [expandedUsers, setExpandedUsers] = useState<Set<string>>(new Set());
  const [rosterCache, setRosterCache] = useState<Map<string, RosterSlotForRounds[]>>(new Map());
  const [rawScoresCache, setRawScoresCache] = useState<Map<string, Map<string, Map<string, number>>>>(new Map());
  const [rosterLoading, setRosterLoading] = useState<Set<string>>(new Set());

  async function toggleExpand(user_id: string) {
    if (expandedUsers.has(user_id)) {
      setExpandedUsers((prev) => { const next = new Set(prev); next.delete(user_id); return next; });
      return;
    }
    setExpandedUsers((prev) => new Set(prev).add(user_id));
    if (!rosterCache.has(user_id)) {
      setRosterLoading((prev) => new Set(prev).add(user_id));
      try {
        const res = await fetch(`/api/league/${league_id}/roster/${user_id}`);
        if (res.ok) {
          const json = await res.json();
          const slots: RosterSlotForRounds[] = [
            ...(json.active_starters ?? []),
            ...(json.active_bench ?? []),
            ...(json.released_starters ?? []),
            ...(json.released_bench ?? []),
          ];
          setRosterCache((prev) => new Map(prev).set(user_id, slots));

          // Fetch raw game_scores for all player_ids so we can show bench/elim round pts
          const playerIds = [...new Set(slots.map((s) => s.player_id).filter(Boolean))];
          if (playerIds.length > 0) {
            const { data: gs } = await supabase
              .from('game_scores')
              .select('player_id, round_stage, points')
              .in('player_id', playerIds);
            const rawMap = new Map<string, Map<string, number>>();
            for (const g of (gs ?? [])) {
              if (!rawMap.has(g.player_id)) rawMap.set(g.player_id, new Map());
              rawMap.get(g.player_id)!.set(g.round_stage, g.points);
            }
            setRawScoresCache((prev) => new Map(prev).set(user_id, rawMap));
          }
        }
      } finally {
        setRosterLoading((prev) => { const next = new Set(prev); next.delete(user_id); return next; });
      }
    }
  }

  useEffect(() => {
    fetch(`/api/league/${league_id}/leaderboard`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load leaderboard');
        return res.json();
      })
      .then((json) => {
        if (json) setData(json as LeaderboardResponse);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading leaderboard…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'Leaderboard not found.'}</p>
        </div>
      </div>
    );
  }

  // Rounds with any scored points — used to restrict displayed columns to played rounds only.
  const playedRounds = new Set<string>();
  for (const entry of data.standings) {
    for (const r of entry.per_round) playedRounds.add(r.round_stage);
  }
  const activeColumns = ROUND_COLUMNS.filter((s) => playedRounds.has(s));

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />

      {data.scores_updating && (
        <div className="border-b border-yellow-400/30 bg-yellow-400/10 px-4 py-2 text-center text-sm text-yellow-300">
          Scores are updating…
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-1">
          <a href="/leagues" className="text-sm text-yellow-400 hover:underline">← My Leagues</a>
        </div>
        <div className="mb-6 flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-white">Leaderboard</h1>
          <button
            onClick={async () => {
              setNarrativeLoading(true);
              setNarrative(null);
              try {
                const res = await fetch('/api/ai/standings-narrator', {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ league_id }),
                });
                const json = await res.json();
                setNarrative(res.ok ? json.narrative : (json.error ?? 'Could not generate a recap right now. Try again.'));
              } finally {
                setNarrativeLoading(false);
              }
            }}
            disabled={narrativeLoading}
            className="rounded-md bg-yellow-400 px-3 py-1.5 text-sm font-medium text-black hover:bg-yellow-300 disabled:opacity-50 shrink-0"
          >
            {narrativeLoading ? 'Generating…' : 'AI Recap'}
          </button>
        </div>

        {narrative && (
          <div className="mb-6 rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-100 leading-relaxed">
            {narrative}
          </div>
        )}

        {data.standings.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-10 text-center shadow-sm">
            <p className="font-medium text-neutral-300">No standings yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              Standings appear here once the draft is complete and tournament games begin.
            </p>
            <a href={`/commissioner/${league_id}`} className="mt-4 inline-block text-sm text-yellow-400 hover:underline">
              Go to Commissioner Tools →
            </a>
          </div>
        ) : (
          <>
            <div className="mb-4 flex gap-2">
              <button
                type="button"
                onClick={() => setView('standings')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  view === 'standings'
                    ? 'bg-yellow-400 text-black'
                    : 'border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400'
                }`}
              >
                Standings
              </button>
              <button
                type="button"
                onClick={() => setView('rounds')}
                className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                  view === 'rounds'
                    ? 'bg-yellow-400 text-black'
                    : 'border border-neutral-800 bg-neutral-900 text-neutral-300 hover:border-yellow-400/40 hover:text-yellow-400'
                }`}
              >
                Round by Round
              </button>
            </div>

            {view === 'standings' ? (
              <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-800 bg-black">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Rank</th>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Team</th>
                      <th className="px-4 py-3 text-right font-medium text-neutral-300">Total</th>
                      <th className="px-4 py-3 text-right font-medium text-neutral-300 hidden sm:table-cell">Active</th>
                      <th className="px-4 py-3 text-right font-medium text-neutral-300 hidden md:table-cell">Best Game</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {data.standings.map((entry, i) => {
                      const rank = i + 1;
                      const isExpanded = expandedUsers.has(entry.user_id);
                      const isLoadingRoster = rosterLoading.has(entry.user_id);
                      const slots = rosterCache.get(entry.user_id) ?? [];
                      return (
                        <Fragment key={entry.user_id}>
                          <tr className={rank === 1 ? 'bg-yellow-400/10' : ''}>
                            <td className="px-4 py-3 font-medium text-neutral-300">
                              {getRankLabel(rank)}
                            </td>
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
                            <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">
                              {entry.total_points}
                            </td>
                            <td className="px-4 py-3 text-right text-neutral-300 tabular-nums hidden sm:table-cell">
                              {entry.active_player_count}
                            </td>
                            <td className="px-4 py-3 text-right text-neutral-300 tabular-nums hidden md:table-cell">
                              {entry.highest_single_game_points}
                            </td>
                          </tr>
                          {isExpanded && isLoadingRoster && (
                            <tr className="bg-neutral-950">
                              <td colSpan={5} className="px-10 py-2 text-xs italic text-neutral-500">
                                Loading players…
                              </td>
                            </tr>
                          )}
                          {isExpanded && !isLoadingRoster && slots.length > 0 && (
                            <tr className="border-b border-neutral-800 bg-neutral-950">
                              <td />
                              <td colSpan={4} className="px-0 pb-2">
                                <table className="w-full text-xs">
                                  <thead>
                                    <tr className="border-b border-neutral-800">
                                      <th className="py-2 pl-10 pr-3 text-left font-bold text-white">Player</th>
                                      {activeColumns.map((stage) => (
                                        <th key={stage} className="px-2 py-2 text-right font-bold text-white whitespace-nowrap">
                                          {ROUND_LABELS[stage as RoundStage] ?? stage}
                                        </th>
                                      ))}
                                      <th className="py-2 pl-3 pr-4 text-right font-bold text-white">Total</th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {slots.map((slot) => {
                                      const countedPts = roundPointsMap(slot.per_round);
                                      const rawPts = rawScoresCache.get(entry.user_id)?.get(slot.player_id) ?? new Map<string, number>();
                                      return (
                                        <tr key={slot.id} className="border-b border-neutral-900 last:border-0">
                                          <td className="py-2 pl-10 pr-3">
                                            <span className={slot.is_active ? 'font-medium text-neutral-300' : 'font-medium text-neutral-600'}>
                                              {slot.player?.name ?? '—'}
                                              {slot.player?.teams && (
                                                <span className="ml-1 font-normal text-neutral-500">
                                                  - {slot.player.teams.name}
                                                </span>
                                              )}
                                            </span>
                                            <span className="ml-1.5 text-neutral-600">{slot.player?.position}</span>
                                            {slot.is_bench && (
                                              <span className="ml-1.5 rounded bg-neutral-800 px-1 py-0.5 text-neutral-500">B</span>
                                            )}
                                          </td>
                                          {activeColumns.map((stage) => {
                                            const cell = getRoundContent(stage, countedPts, rawPts, slot);
                                            return (
                                              <td key={stage} className="px-2 py-2 text-right tabular-nums">
                                                {cell === null ? (
                                                  <span className="text-neutral-700">—</span>
                                                ) : cell.kind === 'counted' ? (
                                                  <span className="text-neutral-300">{Math.round(cell.value)}</span>
                                                ) : cell.kind === 'raw' ? (
                                                  <span className="text-neutral-600 line-through">{Math.round(cell.value)}</span>
                                                ) : (
                                                  <span className="rounded bg-red-900/30 px-1 py-0.5 text-red-500 text-[10px]">Elim</span>
                                                )}
                                              </td>
                                            );
                                          })}
                                          <td className="py-2 pl-3 pr-4 text-right font-medium tabular-nums text-neutral-400">
                                            {slot.total_points ? Math.round(slot.total_points) : '—'}
                                          </td>
                                        </tr>
                                      );
                                    })}
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
            ) : (
              <div className="overflow-x-auto rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-800 bg-black">
                    <tr>
                      <th className="px-4 py-3 text-left font-medium text-neutral-300">Team</th>
                      {ROUND_COLUMNS.map((stage) => (
                        <th key={stage} className="px-3 py-3 text-right font-medium text-neutral-300 whitespace-nowrap">
                          {ROUND_LABELS[stage] ?? stage}
                        </th>
                      ))}
                      <th className="px-4 py-3 text-right font-medium text-neutral-300">Total</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {data.standings.map((entry, i) => {
                      const rank = i + 1;
                      const points = roundPointsMap(entry.per_round);
                      const isExpanded = expandedUsers.has(entry.user_id);
                      const isLoadingRoster = rosterLoading.has(entry.user_id);
                      const slots = rosterCache.get(entry.user_id) ?? [];
                      return (
                        <Fragment key={entry.user_id}>
                          <tr className={rank === 1 ? 'bg-yellow-400/10' : ''}>
                            <td className="px-4 py-3">
                              <button
                                type="button"
                                onClick={() => toggleExpand(entry.user_id)}
                                className="flex items-center gap-1.5 font-medium text-yellow-400 hover:underline text-left"
                              >
                                <span className="text-xs text-neutral-500 w-2 shrink-0">{isExpanded ? '▼' : '▶'}</span>
                                {entry.display_name}
                              </button>
                            </td>
                            {ROUND_COLUMNS.map((stage) => (
                              <td key={stage} className="px-3 py-3 text-right text-neutral-300 tabular-nums">
                                {points.has(stage) ? points.get(stage) : '—'}
                              </td>
                            ))}
                            <td className="px-4 py-3 text-right font-semibold text-white tabular-nums">
                              {entry.total_points}
                            </td>
                          </tr>
                          {isExpanded && isLoadingRoster && (
                            <tr className="bg-neutral-950">
                              <td colSpan={ROUND_COLUMNS.length + 2} className="px-10 py-2 text-xs italic text-neutral-500">
                                Loading players…
                              </td>
                            </tr>
                          )}
                          {isExpanded && !isLoadingRoster && slots.map((slot) => {
                            const countedPts = roundPointsMap(slot.per_round);
                            const rawPts = rawScoresCache.get(entry.user_id)?.get(slot.player_id) ?? new Map<string, number>();
                            return (
                              <tr key={slot.id} className="bg-neutral-950 border-b border-neutral-900">
                                <td className="py-2 pl-10 pr-4 text-xs">
                                  <span className={slot.is_active ? 'font-medium text-neutral-300' : 'font-medium text-neutral-600'}>
                                    {slot.player?.name ?? '—'}
                                    {slot.player?.teams && (
                                      <span className="ml-1 font-normal text-neutral-500">
                                        - {slot.player.teams.name}
                                      </span>
                                    )}
                                  </span>
                                  <span className="ml-1.5 text-neutral-600">{slot.player?.position}</span>
                                  {slot.is_bench && (
                                    <span className="ml-1.5 rounded bg-neutral-800 px-1 py-0.5 text-neutral-500">B</span>
                                  )}
                                </td>
                                {ROUND_COLUMNS.map((stage) => {
                                  const cell = getRoundContent(stage, countedPts, rawPts, slot);
                                  return (
                                    <td key={stage} className="px-3 py-2 text-right text-xs tabular-nums">
                                      {cell === null ? (
                                        <span className="text-neutral-700">—</span>
                                      ) : cell.kind === 'counted' ? (
                                        <span className="text-neutral-400">{Math.round(cell.value)}</span>
                                      ) : cell.kind === 'raw' ? (
                                        <span className="text-neutral-600 line-through">{Math.round(cell.value)}</span>
                                      ) : (
                                        <span className="rounded bg-red-900/30 px-1 py-0.5 text-red-500 text-[10px]">Elim</span>
                                      )}
                                    </td>
                                  );
                                })}
                                <td className="px-4 py-2 text-right text-xs font-medium text-neutral-400 tabular-nums">
                                  {slot.total_points ? Math.round(slot.total_points) : '—'}
                                </td>
                              </tr>
                            );
                          })}
                        </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
