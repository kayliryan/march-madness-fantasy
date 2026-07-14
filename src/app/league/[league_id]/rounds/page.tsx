'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
import { TeamBadge } from '@/components/TeamBadge';
import { ROUND_LABELS } from '@/lib/constants/rounds';

interface RoundEntry {
  user_id: string;
  display_name: string;
  player_id: string;
  player_name: string;
  team_name: string | null;
  team_seed: number | null;
  position: string;
  points: number;
  is_bench: boolean;
}

interface RoundsResponse {
  rounds: { round_stage: string; entries: RoundEntry[] }[];
}

export default function RoundsPage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [data, setData] = useState<RoundsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [roundIdx, setRoundIdx] = useState<number | null>(null);

  useEffect(() => {
    fetch(`/api/league/${league_id}/rounds`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load rounds');
        return res.json();
      })
      .then((json) => {
        if (json) setData(json as RoundsResponse);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading rounds…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'Rounds not found.'}</p>
        </div>
      </div>
    );
  }

  const lastIdx = data.rounds.length - 1;
  if (roundIdx === null && lastIdx >= 0) {
    setRoundIdx(lastIdx);
  }
  const idx = roundIdx ?? lastIdx;
  const visibleRounds = data.rounds.slice(0, idx + 1);

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />
      <div className="mx-auto max-w-4xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-white">Round-by-Round</h1>

        {data.rounds.length === 0 ? (
          <p className="py-12 text-center text-neutral-500">No scoring yet — tournament hasn&apos;t started.</p>
        ) : (
          <>
            <div className="mb-6 flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setRoundIdx((v) => Math.max(0, (v ?? lastIdx) - 1))}
                disabled={idx <= 0}
                className="rounded border border-neutral-800 px-2 py-1 text-xs font-bold text-neutral-400 hover:border-yellow-400/50 hover:text-yellow-400 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Previous round"
              >
                ◀
              </button>
              {data.rounds.map((round, i) => (
                <button
                  key={round.round_stage}
                  type="button"
                  onClick={() => setRoundIdx(i)}
                  className={`rounded px-2 py-1 text-[10px] font-bold uppercase tracking-wide transition-colors ${
                    i === idx
                      ? 'border border-yellow-400 bg-yellow-400/20 text-yellow-400'
                      : 'border border-neutral-800 text-neutral-500 hover:border-yellow-400/40 hover:text-yellow-400'
                  }`}
                >
                  {ROUND_LABELS[round.round_stage] ?? round.round_stage}
                </button>
              ))}
              <button
                type="button"
                onClick={() => setRoundIdx((v) => Math.min(lastIdx, (v ?? lastIdx) + 1))}
                disabled={idx >= lastIdx}
                className="rounded border border-neutral-800 px-2 py-1 text-xs font-bold text-neutral-400 hover:border-yellow-400/50 hover:text-yellow-400 disabled:cursor-not-allowed disabled:opacity-30"
                aria-label="Next round"
              >
                ▶
              </button>
              {idx < lastIdx && (
                <span className="ml-1 text-[11px] text-neutral-500">
                  Viewing through {ROUND_LABELS[data.rounds[idx].round_stage] ?? data.rounds[idx].round_stage} — {lastIdx - idx} more round{lastIdx - idx === 1 ? '' : 's'} already played beyond here.
                </span>
              )}
            </div>

          <div className="flex flex-col gap-6">
            {visibleRounds.map((round) => (
              <div key={round.round_stage} className="overflow-hidden rounded-lg border border-neutral-800 bg-neutral-900 shadow-sm">
                <div className="border-b border-neutral-800 bg-black px-4 py-3">
                  <h2 className="text-base font-semibold text-white">
                    {ROUND_LABELS[round.round_stage] ?? round.round_stage}
                  </h2>
                </div>
                <table className="w-full text-sm">
                  <thead className="border-b border-neutral-800">
                    <tr>
                      <th className="px-4 py-2 text-left font-medium text-neutral-300">Player</th>
                      <th className="px-4 py-2 text-left font-medium text-neutral-300 hidden sm:table-cell">Team</th>
                      <th className="px-4 py-2 text-left font-medium text-neutral-300">Owner</th>
                      <th className="px-4 py-2 text-right font-medium text-neutral-300">Points</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-neutral-800">
                    {round.entries.map((entry) => (
                      <tr key={`${entry.user_id}-${entry.player_id}`}>
                        <td className="px-4 py-2">
                          <span className="font-medium text-white">{entry.player_name}</span>
                          <span className="ml-1 text-xs text-neutral-500">{entry.position}</span>
                        </td>
                        <td className="px-4 py-2 hidden sm:table-cell">
                          {entry.team_name && entry.team_seed !== null ? (
                            <TeamBadge team={{ id: '', name: entry.team_name, seed: entry.team_seed, region: '' }} />
                          ) : (
                            <span className="text-neutral-500">—</span>
                          )}
                        </td>
                        <td className="px-4 py-2">
                          <Link href={`/league/${league_id}/roster/${entry.user_id}`} className="text-yellow-400 hover:underline">
                            {entry.display_name}
                          </Link>
                          {entry.is_bench && (
                            <span className="ml-2 rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">bench</span>
                          )}
                        </td>
                        <td className="px-4 py-2 text-right font-semibold text-yellow-400 tabular-nums">
                          {entry.points}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          </>
        )}
      </div>
    </div>
  );
}
