'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
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

function sortedRounds(per_round: { round_stage: string; points: number }[]) {
  return [...per_round].sort(
    (a, b) =>
      ROUND_STAGE_ORDER.indexOf(a.round_stage as RoundStage) -
      ROUND_STAGE_ORDER.indexOf(b.round_stage as RoundStage)
  );
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

  useEffect(() => {
    setLoading(true);
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
                if (res.ok) {
                  const json = await res.json();
                  setNarrative(json.narrative);
                }
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
          <div className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-neutral-800 bg-black">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-neutral-300">Rank</th>
                  <th className="px-4 py-3 text-left font-medium text-neutral-300">Team</th>
                  <th className="px-4 py-3 text-right font-medium text-neutral-300">Total</th>
                  <th className="px-4 py-3 text-right font-medium text-neutral-300 hidden sm:table-cell">Active</th>
                  <th className="px-4 py-3 text-right font-medium text-neutral-300 hidden md:table-cell">Best Game</th>
                  <th className="px-4 py-3 text-left font-medium text-neutral-300 hidden lg:table-cell">Per Round</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-neutral-800">
                {data.standings.map((entry, i) => {
                  const rank = i + 1;
                  const rounds = sortedRounds(entry.per_round);
                  return (
                    <tr key={entry.user_id} className={rank === 1 ? 'bg-yellow-400/10' : ''}>
                      <td className="px-4 py-3 font-medium text-neutral-300">
                        {getRankLabel(rank)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/league/${league_id}/roster/${entry.user_id}`}
                          className="font-medium text-yellow-400 hover:underline"
                        >
                          {entry.display_name}
                        </Link>
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
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="flex flex-wrap gap-2">
                          {rounds.map((r) => (
                            <span key={r.round_stage} className="text-xs text-neutral-500">
                              {ROUND_LABELS[r.round_stage] ?? r.round_stage}: {r.points}
                            </span>
                          ))}
                          {rounds.length === 0 && (
                            <span className="text-xs text-neutral-500">—</span>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
