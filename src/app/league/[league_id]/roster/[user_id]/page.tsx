'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import { Section, type RosterSlotEnriched } from '@/components/RosterSlotList';

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
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/league/${league_id}/roster/${user_id}`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load roster');
        return res.json();
      })
      .then((json) => {
        if (json) setData(json as RosterResponse);
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

  const totalPoints =
    [...data.active_starters, ...data.active_bench, ...data.released_starters, ...data.released_bench]
      .reduce((sum, s) => sum + s.total_points, 0);

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

        <div className="flex flex-col gap-5">
          <Section title="Active Starters" slots={data.active_starters} />
          <Section title="Active Bench" slots={data.active_bench} />
          <Section title="Released Starters" slots={data.released_starters} muted />
          <Section title="Released Bench" slots={data.released_bench} muted />
        </div>

        {data.active_starters.length === 0 &&
          data.active_bench.length === 0 &&
          data.released_starters.length === 0 &&
          data.released_bench.length === 0 && (
            <p className="mt-12 text-center text-neutral-500">No roster yet — draft hasn&apos;t started.</p>
          )}
      </div>
    </div>
  );
}
