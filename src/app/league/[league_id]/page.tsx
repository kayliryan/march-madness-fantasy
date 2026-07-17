'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
import { formatCountdown } from '@/lib/utils/formatCountdown';
import type { GetLeagueResponse } from '@/lib/types';

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

interface RosterResponse {
  active_starters: { total_points: number }[];
  active_bench: { total_points: number }[];
  released_starters: { total_points: number }[];
  released_bench: { total_points: number }[];
}

function getRankLabel(rank: number): string {
  if (rank === 1) return '🥇';
  if (rank === 2) return '🥈';
  if (rank === 3) return '🥉';
  return `#${rank}`;
}

export default function LeagueHomePage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [league, setLeague] = useState<GetLeagueResponse | null>(null);
  const [leaderboard, setLeaderboard] = useState<LeaderboardResponse | null>(null);
  const [myRoster, setMyRoster] = useState<RosterResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [narrative, setNarrative] = useState<string | null>(null);
  const [narrativeLoading, setNarrativeLoading] = useState(false);

  useEffect(() => {
    fetch(`/api/league/${league_id}`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load league');
        return res.json();
      })
      .then(async (json: GetLeagueResponse | null) => {
        if (!json) return;
        setLeague(json);

        const [lbRes, rosterRes] = await Promise.all([
          fetch(`/api/league/${league_id}/leaderboard`),
          fetch(`/api/league/${league_id}/roster/${json.current_member.user_id}`),
        ]);

        if (lbRes.ok) setLeaderboard(await lbRes.json());
        if (rosterRes.ok) setMyRoster(await rosterRes.json());
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading league…</p>
        </div>
      </div>
    );
  }

  if (error || !league) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'League not found.'}</p>
        </div>
      </div>
    );
  }

  const isCommissioner =
    league.current_member.role === 'commissioner' || league.current_member.role === 'co_commissioner';

  const standings = leaderboard?.standings ?? [];
  const myRank = standings.findIndex((s) => s.user_id === league.current_member.user_id) + 1;
  const top3 = standings.slice(0, 3);
  const showMyRow = myRank > 3;

  const myTeamPoints = myRoster
    ? [...myRoster.active_starters, ...myRoster.active_bench].reduce((sum, s) => sum + s.total_points, 0)
    : null;

  let benchLockInfo: string | null = null;
  if (league.bench_lock_deadline != null) {
    const deadline = new Date(league.bench_lock_deadline);
    benchLockInfo = deadline > new Date()
      ? `Bench order locks ${formatCountdown(deadline)}`
      : 'Bench order locked';
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />

      <div className="mx-auto max-w-4xl px-4 py-8">
        <div className="mb-6">
          <h1 className="text-2xl font-bold text-white">{league.league.name}</h1>
          <p className="mt-1 text-sm text-neutral-500">
            Season {league.league.season} · {league.members.length} member{league.members.length === 1 ? '' : 's'}
          </p>
          {!league.is_historical && benchLockInfo && (
            <p className="mt-1 text-xs text-neutral-500">{benchLockInfo}</p>
          )}
          {league.is_historical && (
            <div className="mt-3 rounded-md border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-400">
              This is a past season — view only.
            </div>
          )}
        </div>

        {!league.is_historical && league.draft_status === null && !league.has_roster_data ? (
          <div className="mb-6 rounded-lg border border-dashed border-neutral-700 bg-neutral-900 p-6 text-center">
            <p className="font-semibold text-white">No draft yet</p>
            <p className="mt-1 text-sm text-neutral-500">
              {isCommissioner
                ? 'Invite members and schedule your draft to get started.'
                : "The commissioner hasn't scheduled a draft yet."}
            </p>
            {isCommissioner && (
              <Link
                href={`/commissioner/${league_id}`}
                className="mt-4 inline-block rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-300"
              >
                Go to Commissioner Tools
              </Link>
            )}
          </div>
        ) : (
        <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2">
          {/* My Team card */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
            <h2 className="mb-1 text-sm font-semibold uppercase tracking-wide text-neutral-500">My Team</h2>
            {myTeamPoints !== null ? (
              <p className="text-3xl font-bold text-yellow-400">{myTeamPoints} pts</p>
            ) : (
              <p className="text-sm text-neutral-500">No roster yet — draft hasn&apos;t started.</p>
            )}
            <Link
              href={`/league/${league_id}/roster/${league.current_member.user_id}`}
              className="mt-3 inline-block text-sm text-yellow-400 hover:underline"
            >
              View My Roster →
            </Link>
          </div>

          {/* Standings snapshot */}
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm">
            <h2 className="mb-2 text-sm font-semibold uppercase tracking-wide text-neutral-500">Standings</h2>
            {standings.length === 0 ? (
              <p className="text-sm text-neutral-500">No standings yet.</p>
            ) : (
              <ul className="flex flex-col gap-1.5">
                {top3.map((entry, i) => (
                  <li key={entry.user_id} className="flex items-center justify-between text-sm">
                    <span className="text-neutral-300">
                      {getRankLabel(i + 1)}{' '}
                      <Link href={`/league/${league_id}/roster/${entry.user_id}`} className="text-white hover:text-yellow-400">
                        {entry.display_name}
                      </Link>
                    </span>
                    <span className="font-semibold text-yellow-400 tabular-nums">{entry.total_points}</span>
                  </li>
                ))}
                {showMyRow && (
                  <li className="flex items-center justify-between border-t border-neutral-800 pt-1.5 text-sm">
                    <span className="text-neutral-300">
                      {getRankLabel(myRank)}{' '}
                      <span className="text-white">{standings[myRank - 1].display_name}</span>
                    </span>
                    <span className="font-semibold text-yellow-400 tabular-nums">{standings[myRank - 1].total_points}</span>
                  </li>
                )}
              </ul>
            )}
            <Link href={`/league/${league_id}/leaderboard`} className="mt-3 inline-block text-sm text-yellow-400 hover:underline">
              Full Leaderboard →
            </Link>
          </div>
        </div>
        )}

        {/* AI Recap */}
        <div className="mb-6">
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
            className="rounded-md bg-yellow-400 px-3 py-1.5 text-sm font-medium text-black hover:bg-yellow-300 disabled:opacity-50"
          >
            {narrativeLoading ? 'Generating…' : 'AI Recap'}
          </button>
          {narrative && (
            <div className="mt-3 rounded-lg border border-yellow-400/30 bg-yellow-400/10 px-4 py-3 text-sm text-yellow-100 leading-relaxed">
              {narrative}
            </div>
          )}
        </div>

        {/* Quick links */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Link href={`/league/${league_id}/leaderboard`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            Leaderboard
          </Link>
          <Link href={`/league/${league_id}/rosters`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            All Rosters
          </Link>
          <Link href={`/league/${league_id}/rounds`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            Round-by-Round
          </Link>
          <Link href={`/players?league_id=${league_id}`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            Player Explorer
          </Link>
          {(league.draft_status === 'scheduled' || league.draft_status === 'live') && (
            <Link href={`/players?league_id=${league_id}&queue=open`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
              My Queue
            </Link>
          )}
          <Link href={`/league/${league_id}/rules`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            League Rules
          </Link>
          <Link href={`/league/${league_id}/bench-order`} className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 text-center text-sm font-medium text-white shadow-sm hover:border-yellow-400/40 hover:text-yellow-400">
            Bench Order
          </Link>
          {isCommissioner && (
            <Link href={`/commissioner/${league_id}`} className="rounded-lg border border-yellow-400/30 bg-yellow-400/10 p-4 text-center text-sm font-medium text-yellow-300 shadow-sm hover:bg-yellow-400/20 sm:col-span-2 lg:col-span-4">
              Commissioner Tools
            </Link>
          )}
        </div>
      </div>
    </div>
  );
}
