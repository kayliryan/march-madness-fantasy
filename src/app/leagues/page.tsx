'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
import type { League } from '@/lib/types';

export default function LeaguesPage() {
  const router = useRouter();
  const [leagues, setLeagues] = useState<League[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/leagues')
      .then((res) => {
        if (res.status === 401) {
          router.push('/auth/login');
          return null;
        }
        if (!res.ok) throw new Error('Failed to load leagues');
        return res.json();
      })
      .then((data) => {
        if (data) setLeagues(data.leagues ?? []);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [router]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading your leagues…</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader />
      <div className="px-4 py-8">
      <div className="mx-auto max-w-3xl">
        <div className="mb-6 flex items-center justify-between">
          <h1 className="text-2xl font-bold text-white">My Leagues</h1>
          <Link
            href="/league/create"
            className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-300"
          >
            Create League
          </Link>
        </div>

        {error && (
          <p className="mb-4 rounded-md bg-yellow-400/10 border border-yellow-400/30 px-4 py-3 text-sm text-red-400">{error}</p>
        )}

        {leagues.length === 0 ? (
          <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-12 text-center shadow-sm">
            <p className="mb-4 text-neutral-500">You haven&apos;t joined any leagues yet.</p>
            <Link
              href="/league/create"
              className="rounded-md bg-yellow-400 px-4 py-2 text-sm font-medium text-black hover:bg-yellow-300"
            >
              Create your first league
            </Link>
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {leagues.map((league) => (
              <div
                key={league.id}
                className="rounded-lg border border-neutral-800 bg-neutral-900 p-5 shadow-sm"
              >
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <h2 className="font-semibold text-white">{league.name}</h2>
                    <p className="text-sm text-neutral-500">Season {league.season}</p>
                  </div>
                  <div className="flex shrink-0 gap-2">
                    <Link
                      href={`/league/${league.id}`}
                      className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
                    >
                      Home
                    </Link>
                    <Link
                      href={`/league/${league.id}/leaderboard`}
                      className="rounded-md border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800"
                    >
                      Leaderboard
                    </Link>
                    <Link
                      href={`/commissioner/${league.id}`}
                      className="rounded-md bg-yellow-400 px-3 py-1.5 text-xs font-medium text-black hover:bg-yellow-300"
                    >
                      Manage
                    </Link>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}

        <p className="mt-6 text-center">
          <Link href="/dashboard" className="text-sm text-yellow-400 hover:underline">
            Back to dashboard
          </Link>
        </p>
      </div>
      </div>
    </div>
  );
}
