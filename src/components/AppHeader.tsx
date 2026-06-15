'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import { supabase } from '@/lib/supabase/client';
import type { GetLeagueResponse } from '@/lib/types';

interface AppHeaderProps {
  leagueId?: string;
}

const NAV_LINKS = [
  { href: '/dashboard', label: 'Dashboard' },
  { href: '/leagues', label: 'My Leagues' },
  { href: '/players', label: 'Players' },
];

export default function AppHeader({ leagueId }: AppHeaderProps) {
  const router = useRouter();
  const [displayName, setDisplayName] = useState<string | null>(null);
  const [league, setLeague] = useState<GetLeagueResponse | null>(null);

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      const user = data.user;
      if (!user) return;
      setDisplayName(
        (user.user_metadata?.display_name as string | undefined) ?? user.email ?? 'Account'
      );
    });
  }, []);

  useEffect(() => {
    if (!leagueId) return;
    fetch(`/api/league/${leagueId}`)
      .then((res) => (res.ok ? res.json() : null))
      .then((json) => {
        if (json) setLeague(json as GetLeagueResponse);
      })
      .catch(() => {});
  }, [leagueId]);

  async function handleSignOut() {
    await supabase.auth.signOut();
    router.push('/');
  }

  const isCommissioner =
    league?.current_member.role === 'commissioner' ||
    league?.current_member.role === 'co_commissioner';

  return (
    <header className="border-b border-neutral-800 bg-black">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-3">
        <div className="flex items-center gap-6">
          <a href="/dashboard" className="text-sm font-extrabold tracking-wide text-yellow-400">
            MARCH MADNESS FANTASY
          </a>
          <nav className="hidden items-center gap-4 sm:flex">
            {NAV_LINKS.map((link) => (
              <a
                key={link.href}
                href={link.href === '/players' && leagueId ? `/players?league_id=${leagueId}` : link.href}
                className="text-sm text-neutral-300 hover:text-yellow-400"
              >
                {link.label}
              </a>
            ))}
          </nav>
        </div>
        <div className="flex items-center gap-3">
          {displayName && <span className="hidden text-sm text-neutral-500 sm:inline">{displayName}</span>}
          <button
            onClick={handleSignOut}
            className="text-sm text-neutral-300 hover:text-yellow-400"
          >
            Sign out
          </button>
        </div>
      </div>

      {leagueId && league && (
        <div className="border-t border-neutral-900">
          <div className="mx-auto flex max-w-5xl items-center gap-4 overflow-x-auto px-4 py-2">
            <span className="whitespace-nowrap text-sm font-semibold text-white">
              {league.league.name}
            </span>
            <nav className="flex items-center gap-4">
              <a href={`/league/${leagueId}`} className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400">
                Home
              </a>
              <a href={`/league/${leagueId}/leaderboard`} className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400">
                Leaderboard
              </a>
              <a
                href={`/league/${leagueId}/roster/${league.current_member.user_id}`}
                className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400"
              >
                My Roster
              </a>
              <a href={`/league/${leagueId}/rosters`} className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400">
                All Rosters
              </a>
              <a href={`/league/${leagueId}/rounds`} className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400">
                Rounds
              </a>
              {isCommissioner && (
                <a href={`/commissioner/${leagueId}`} className="whitespace-nowrap text-sm text-neutral-300 hover:text-yellow-400">
                  Commissioner
                </a>
              )}
            </nav>
          </div>
        </div>
      )}
    </header>
  );
}
