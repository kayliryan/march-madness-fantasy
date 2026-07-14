'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import { Section, visibleRoundsFor, type RosterSlotEnriched } from '@/components/RosterSlotList';
import { supabase } from '@/lib/supabase/client';
import type { GetLeagueResponse } from '@/lib/types';

interface RosterResponse {
  active_starters: RosterSlotEnriched[];
  active_bench: RosterSlotEnriched[];
  released_starters: RosterSlotEnriched[];
  released_bench: RosterSlotEnriched[];
}

export default function RosterPage() {
  const params = useParams<{ league_id: string; user_id: string }>();
  const { league_id, user_id } = params;

  const [data, setData] = useState<RosterResponse | null>(null);
  const [league, setLeague] = useState<GetLeagueResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isOwnRoster, setIsOwnRoster] = useState(false);

  useEffect(() => {
    let active = true;
    async function checkOwnRoster() {
      const { data: { user } } = await supabase.auth.getUser();
      if (active && user) setIsOwnRoster(user.id === user_id);
    }
    checkOwnRoster();
    return () => { active = false; };
  }, [user_id]);

  useEffect(() => {
    Promise.all([
      fetch(`/api/league/${league_id}/roster/${user_id}`),
      fetch(`/api/league/${league_id}`),
    ])
      .then(([rosterRes, leagueRes]) => {
        if (rosterRes.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!rosterRes.ok) throw new Error('Failed to load roster');
        return Promise.all([
          rosterRes.json(),
          leagueRes.ok ? leagueRes.json() : null,
        ]);
      })
      .then((result) => {
        if (!result) return;
        const [rosterJson, leagueJson] = result;
        setData(rosterJson as RosterResponse);
        if (leagueJson) setLeague(leagueJson as GetLeagueResponse);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id, user_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading roster…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'Roster not found.'}</p>
        </div>
      </div>
    );
  }

  const allSlots = [...data.active_starters, ...data.active_bench, ...data.released_starters, ...data.released_bench];
  const totalPoints = allSlots.reduce((sum, s) => sum + s.total_points, 0);
  const isHistorical = league?.is_historical ?? false;
  const historicalSlots = [...allSlots].sort((a, b) => b.total_points - a.total_points);
  const visibleRounds = visibleRoundsFor(allSlots);

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-1">
          <a href={`/league/${league_id}/leaderboard`} className="text-sm text-yellow-400 hover:underline">← Leaderboard</a>
        </div>
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-bold text-white">Roster</h1>
          <span className="text-lg font-semibold text-yellow-400">{totalPoints} pts total</span>
        </div>

        {isHistorical && (
          <p className="mb-6 rounded-md border border-dashed border-neutral-700 bg-neutral-900 p-3 text-center text-sm text-neutral-500">
            This is a historical season. Showing what was drafted and scored.
          </p>
        )}

        {isOwnRoster && !isHistorical && (
          <div className="mb-6">
            <a href={`/league/${league_id}/bench-order`} className="text-sm text-yellow-400 hover:underline">
              Manage Bench Order →
            </a>
          </div>
        )}

        <div className="flex flex-col gap-5">
          {isHistorical ? (
            <Section title="Roster" slots={historicalSlots} historical visibleRounds={visibleRounds} />
          ) : (
            <>
              <Section title="Active Starters" slots={data.active_starters} visibleRounds={visibleRounds} />
              <Section title="Active Bench" slots={data.active_bench} visibleRounds={visibleRounds} />
              <Section title="Released Starters" slots={data.released_starters} muted visibleRounds={visibleRounds} />
              <Section title="Released Bench" slots={data.released_bench} muted visibleRounds={visibleRounds} />
            </>
          )}
        </div>

        {allSlots.length === 0 && (
          <p className="mt-12 text-center text-neutral-500">No roster yet — draft hasn&apos;t started.</p>
        )}
      </div>
    </div>
  );
}
