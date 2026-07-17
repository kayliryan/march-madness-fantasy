'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import AppHeader from '@/components/AppHeader';
import { LeagueForm } from '@/components/LeagueForm';
import { LeagueInviteModal } from '@/components/LeagueInviteModal';
import { supabase } from '@/lib/supabase/client';
import { CURRENT_TOURNAMENT_SEASON } from '@/lib/constants/season';
import type { CreateLeagueRequest, CreateLeagueResponse, League } from '@/lib/types';

export default function CreateLeaguePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLeague, setCreatedLeague] = useState<League | null>(null);
  const [allowedSeason, setAllowedSeason] = useState<number | null>(null);

  useEffect(() => {
    supabase
      .from('game_scores')
      .select('id', { count: 'exact', head: true })
      .eq('season', CURRENT_TOURNAMENT_SEASON)
      .eq('game_status', 'in_progress')
      .then(({ count }) => {
        setAllowedSeason((count ?? 0) > 0 ? CURRENT_TOURNAMENT_SEASON : CURRENT_TOURNAMENT_SEASON + 1);
      });
  }, []);

  async function handleCreate(payload: CreateLeagueRequest) {
    setSubmitting(true);
    setError(null);

    try {
      const res = await fetch('/api/league', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 401) {
        router.push('/auth/login');
        return;
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error ?? 'Failed to create league');
      }

      const data: CreateLeagueResponse = await res.json();
      setCreatedLeague(data.league);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-black">
      <AppHeader />
      <div className="px-4 py-12">
      <div className="mx-auto max-w-xl">
        <h1 className="mb-2 text-3xl font-bold text-white">Create a League</h1>
        <p className="mb-8 text-neutral-300">
          Set up your league&apos;s scoring and draft rules. You can fine-tune everything later
          from the commissioner panel.
        </p>

        {error && (
          <p className="mb-4 rounded-md bg-yellow-400/10 border border-yellow-400/30 px-4 py-3 text-sm text-red-400">{error}</p>
        )}

        <div className="rounded-lg border border-neutral-800 bg-neutral-900 p-6 shadow-sm">
          {allowedSeason === null ? (
            <div className="py-8 text-center text-sm text-neutral-500">Loading…</div>
          ) : (
            <LeagueForm onSubmit={handleCreate} submitting={submitting} season={allowedSeason} />
          )}
        </div>
      </div>

      {createdLeague && (
        <LeagueInviteModal
          leagueId={createdLeague.id}
          leagueName={createdLeague.name}
          onClose={() => router.push(`/commissioner/${createdLeague.id}`)}
        />
      )}
      </div>
    </div>
  );
}
