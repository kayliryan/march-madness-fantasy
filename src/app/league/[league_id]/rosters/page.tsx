'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import Link from 'next/link';
import AppHeader from '@/components/AppHeader';
import { Section, type RosterSlotEnriched } from '@/components/RosterSlotList';

interface MemberRoster {
  user_id: string;
  display_name: string;
  total_points: number;
  active_starters: RosterSlotEnriched[];
  active_bench: RosterSlotEnriched[];
  released_starters: RosterSlotEnriched[];
  released_bench: RosterSlotEnriched[];
}

interface RostersResponse {
  members: MemberRoster[];
}

export default function AllRostersPage() {
  const params = useParams<{ league_id: string }>();
  const { league_id } = params;

  const [data, setData] = useState<RostersResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setLoading(true);
    fetch(`/api/league/${league_id}/rosters`)
      .then((res) => {
        if (res.status === 401) {
          window.location.href = '/auth/login';
          return null;
        }
        if (!res.ok) throw new Error('Failed to load rosters');
        return res.json();
      })
      .then((json) => {
        if (json) setData(json as RostersResponse);
      })
      .catch((err) => setError(err.message))
      .finally(() => setLoading(false));
  }, [league_id]);

  if (loading) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-neutral-500">Loading rosters…</p>
        </div>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="min-h-screen bg-black">
        <AppHeader leagueId={league_id} />
        <div className="flex items-center justify-center py-24">
          <p className="text-red-400">{error ?? 'Rosters not found.'}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader leagueId={league_id} />
      <div className="mx-auto max-w-3xl px-4 py-8">
        <h1 className="mb-6 text-2xl font-bold text-white">All Rosters</h1>

        <div className="flex flex-col gap-6">
          {data.members.map((member) => (
            <div key={member.user_id}>
              <div className="mb-2 flex items-baseline justify-between">
                <Link
                  href={`/league/${league_id}/roster/${member.user_id}`}
                  className="text-lg font-semibold text-white hover:text-yellow-400"
                >
                  {member.display_name}
                </Link>
                <span className="text-sm font-semibold text-yellow-400">{member.total_points} pts total</span>
              </div>
              <div className="flex flex-col gap-3">
                <Section title="Active Starters" slots={member.active_starters} />
                <Section title="Active Bench" slots={member.active_bench} />
                <Section title="Released Starters" slots={member.released_starters} muted />
                <Section title="Released Bench" slots={member.released_bench} muted />
                {member.active_starters.length === 0 &&
                  member.active_bench.length === 0 &&
                  member.released_starters.length === 0 &&
                  member.released_bench.length === 0 && (
                    <p className="text-sm text-neutral-500">No roster yet.</p>
                  )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
