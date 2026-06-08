'use client';

import { useEffect, useState } from 'react';
import { useParams } from 'next/navigation';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { Player, RosterSlot, Team } from '@/lib/types';

interface RosterSlotEnriched extends RosterSlot {
  player: (Player & { teams?: Pick<Team, 'id' | 'name' | 'seed' | 'region'> | null }) | null;
  per_round: { round_stage: string; points: number }[];
  total_points: number;
}

interface RosterResponse {
  active_starters: RosterSlotEnriched[];
  active_bench: RosterSlotEnriched[];
  released_starters: RosterSlotEnriched[];
  released_bench: RosterSlotEnriched[];
}

const ROUND_LABELS: Record<string, string> = {
  play_in: 'Play-In',
  r64: 'R64',
  r32: 'R32',
  s16: 'S16',
  e8: 'E8',
  f4: 'F4',
  championship: 'Champ',
};

function sortRounds(per_round: { round_stage: string; points: number }[]) {
  return [...per_round].sort(
    (a, b) =>
      ROUND_STAGE_ORDER.indexOf(a.round_stage as RoundStage) -
      ROUND_STAGE_ORDER.indexOf(b.round_stage as RoundStage)
  );
}

function SlotRow({ slot }: { slot: RosterSlotEnriched }) {
  const rounds = sortRounds(slot.per_round);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 px-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-xs font-mono text-gray-400 w-8">{slot.slot_key}</span>
          <span className="font-medium text-gray-900">
            {slot.player?.name ?? slot.player_id.slice(0, 8)}
          </span>
          <span className="text-xs text-gray-500">{slot.player?.position}</span>
          {slot.player?.teams && (
            <span className="text-xs text-gray-400">
              {slot.player.teams.name} ({slot.player.teams.seed})
            </span>
          )}
          {!slot.is_active && (
            <span className="rounded bg-gray-100 px-1.5 py-0.5 text-xs text-gray-500">
              {slot.release_reason ?? 'released'}
            </span>
          )}
        </div>

        {rounds.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-2">
            {rounds.map((r) => (
              <span key={r.round_stage} className="text-xs text-gray-500">
                {ROUND_LABELS[r.round_stage] ?? r.round_stage}: {r.points}
              </span>
            ))}
          </div>
        )}
      </div>

      <span className="text-sm font-semibold text-indigo-700 tabular-nums">
        {slot.total_points} pts
      </span>
    </li>
  );
}

function Section({
  title,
  slots,
  muted,
}: {
  title: string;
  slots: RosterSlotEnriched[];
  muted?: boolean;
}) {
  if (slots.length === 0) return null;
  return (
    <div className={`rounded-lg border bg-white shadow-sm ${muted ? 'border-gray-100 opacity-75' : 'border-gray-200'}`}>
      <div className="border-b border-gray-100 px-4 py-3">
        <h2 className="text-base font-semibold text-gray-800">{title}</h2>
      </div>
      <ul className="divide-y divide-gray-50 px-4">
        {slots.map((s) => (
          <SlotRow key={s.id} slot={s} />
        ))}
      </ul>
    </div>
  );
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
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-gray-500">Loading roster…</p>
      </div>
    );
  }

  if (error || !data) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-gray-50">
        <p className="text-red-500">{error ?? 'Roster not found.'}</p>
      </div>
    );
  }

  const totalPoints =
    [...data.active_starters, ...data.active_bench, ...data.released_starters, ...data.released_bench]
      .reduce((sum, s) => sum + s.total_points, 0);

  return (
    <div className="min-h-screen bg-gray-50">
      <div className="mx-auto max-w-3xl px-4 py-8">
        <div className="mb-6 flex items-baseline justify-between">
          <h1 className="text-2xl font-bold text-gray-900">Roster</h1>
          <span className="text-lg font-semibold text-indigo-700">{totalPoints} pts total</span>
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
            <p className="mt-12 text-center text-gray-400">No roster yet — draft hasn&apos;t started.</p>
          )}
      </div>
    </div>
  );
}
