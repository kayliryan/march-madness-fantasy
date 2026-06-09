'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
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

const ROUND_LABELS: Record<string, string> = {
  play_in: 'Play-In',
  r64: 'R64',
  r32: 'R32',
  s16: 'S16',
  e8: 'E8',
  f4: 'F4',
  championship: 'Champ',
};

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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading leaderboard…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-red-500">{error ?? 'Leaderboard not found.'}</p>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {data.scores_updating && (
        <div className="bg-yellow-50 border-b border-yellow-200 px-4 py-2 text-center text-sm text-yellow-800">
          Scores are updating…
        </div>
      )}

      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6 flex items-start justify-between gap-4">
          <h1 className="text-2xl font-bold text-gray-900">Leaderboard</h1>
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
            className="rounded-md bg-indigo-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-700 disabled:opacity-50 shrink-0"
          >
            {narrativeLoading ? 'Generating…' : 'AI Recap'}
          </button>
        </div>

        {narrative && (
          <div className="mb-6 rounded-lg border border-indigo-100 bg-indigo-50 px-4 py-3 text-sm text-indigo-900 leading-relaxed">
            {narrative}
          </div>
        )}

        {data.standings.length === 0 ? (
          <p className="text-center text-gray-400 mt-12">No scores yet — check back after the tournament starts.</p>
        ) : (
          <div className="overflow-hidden rounded-lg border border-gray-200 bg-white shadow-sm">
            <table className="w-full text-sm">
              <thead className="border-b border-gray-200 bg-gray-50">
                <tr>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Rank</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600">Team</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600">Total</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 hidden sm:table-cell">Active</th>
                  <th className="px-4 py-3 text-right font-medium text-gray-600 hidden md:table-cell">Best Game</th>
                  <th className="px-4 py-3 text-left font-medium text-gray-600 hidden lg:table-cell">Per Round</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {data.standings.map((entry, i) => {
                  const rank = i + 1;
                  const rounds = sortedRounds(entry.per_round);
                  return (
                    <tr key={entry.user_id} className={rank === 1 ? 'bg-indigo-50' : ''}>
                      <td className="px-4 py-3 font-medium text-gray-700">
                        {getRankLabel(rank)}
                      </td>
                      <td className="px-4 py-3">
                        <Link
                          href={`/league/${league_id}/roster/${entry.user_id}`}
                          className="font-medium text-indigo-600 hover:underline"
                        >
                          {entry.display_name}
                        </Link>
                      </td>
                      <td className="px-4 py-3 text-right font-semibold text-gray-900 tabular-nums">
                        {entry.total_points}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 tabular-nums hidden sm:table-cell">
                        {entry.active_player_count}
                      </td>
                      <td className="px-4 py-3 text-right text-gray-600 tabular-nums hidden md:table-cell">
                        {entry.highest_single_game_points}
                      </td>
                      <td className="px-4 py-3 hidden lg:table-cell">
                        <div className="flex flex-wrap gap-2">
                          {rounds.map((r) => (
                            <span key={r.round_stage} className="text-xs text-gray-500">
                              {ROUND_LABELS[r.round_stage] ?? r.round_stage}: {r.points}
                            </span>
                          ))}
                          {rounds.length === 0 && (
                            <span className="text-xs text-gray-400">—</span>
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
