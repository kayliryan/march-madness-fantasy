'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import type { League } from '@/lib/types';

export default function Dashboard() {
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/leagues')
      .then((res) => {
        if (res.status === 401) { router.push('/auth/login'); return null; }
        if (!res.ok) throw new Error('Failed');
        return res.json();
      })
      .then((data) => { if (data) setLeagues(data.leagues ?? []); })
      .catch(() => {})
      .finally(() => setLoading(false));
  }, [router]);

  return (
    <div className="min-h-screen bg-black">
      <AppHeader />
      <div className="px-4 py-8">
      <div className="mx-auto max-w-5xl">
        <div className="mb-8 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">Dashboard</h1>
          <Link
            href="/league/create"
            className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-300"
          >
            + New League
          </Link>
        </div>

        {/* My Leagues */}
        <section className="mb-8">
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">My Leagues</h2>
          {loading ? (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {[1, 2].map((n) => (
                <div key={n} className="h-28 animate-pulse rounded-lg bg-neutral-800" />
              ))}
            </div>
          ) : leagues.length === 0 ? (
            <div className="rounded-lg border border-dashed border-neutral-800 bg-neutral-900 p-8 text-center">
              <p className="text-neutral-500">No leagues yet.</p>
              <Link href="/league/create" className="mt-3 inline-block rounded-md bg-yellow-400 px-4 py-2 text-sm font-semibold text-black hover:bg-yellow-300">
                Create your first league
              </Link>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              {leagues.map((league) => (
                <div key={league.id} className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm hover:border-yellow-400/30 transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate font-semibold text-white">{league.name}</p>
                      <p className="text-sm text-neutral-500">Season {league.season}</p>
                    </div>
                  </div>
                  <div className="mt-4 flex gap-2">
                    <Link
                      href={`/league/${league.id}`}
                      className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 py-1.5 text-center text-xs font-medium text-neutral-300 hover:bg-neutral-800"
                    >
                      Home
                    </Link>
                    <Link
                      href={`/league/${league.id}/leaderboard`}
                      className="flex-1 rounded-md border border-neutral-800 bg-neutral-900 py-1.5 text-center text-xs font-medium text-neutral-300 hover:bg-neutral-800"
                    >
                      Standings
                    </Link>
                    <Link
                      href={`/commissioner/${league.id}`}
                      className="flex-1 rounded-md bg-yellow-400 py-1.5 text-center text-xs font-medium text-black hover:bg-yellow-300"
                    >
                      Manage
                    </Link>
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Quick links */}
        <section>
          <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-neutral-500">Explore</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <Link href="/players" className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-sm hover:border-yellow-400/30 transition-colors">
              <p className="font-medium text-white">Player Explorer</p>
              <p className="mt-1 text-sm text-neutral-500">Browse all 356 players by position, team, and PPG.</p>
            </Link>
            <Link href="/demo/league" className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-sm hover:border-yellow-400/30 transition-colors">
              <p className="font-medium text-white">Demo League</p>
              <p className="mt-1 text-sm text-neutral-500">See a completed tournament with real scoring.</p>
            </Link>
            <Link href="/demo/draft" className="rounded-lg border border-neutral-800 bg-neutral-900 p-4 shadow-sm hover:border-yellow-400/30 transition-colors">
              <p className="font-medium text-white">Mock Draft</p>
              <p className="mt-1 text-sm text-neutral-500">Practice against 4 AI opponents with advisor help.</p>
            </Link>
          </div>
        </section>
      </div>
      </div>
    </div>
  );
}
