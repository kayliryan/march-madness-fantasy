'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { LeagueForm } from '@/components/LeagueForm';
import { LeagueInviteModal } from '@/components/LeagueInviteModal';
import type { CreateLeagueRequest, CreateLeagueResponse, League } from '@/lib/types';

export default function CreateLeaguePage() {
  const router = useRouter();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdLeague, setCreatedLeague] = useState<League | null>(null);

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
    <div className="min-h-screen bg-gray-50 px-4 py-12">
      <div className="mx-auto max-w-xl">
        <h1 className="mb-2 text-3xl font-bold text-gray-900">Create a League</h1>
        <p className="mb-8 text-gray-600">
          Set up your league&apos;s scoring and draft rules. You can fine-tune everything later
          from the commissioner panel.
        </p>

        {error && (
          <p className="mb-4 rounded-md bg-red-50 px-4 py-3 text-sm text-red-700">{error}</p>
        )}

        <div className="rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <LeagueForm onSubmit={handleCreate} submitting={submitting} />
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
  );
}
