import { ROUND_STAGE_ORDER, ROUND_LABELS } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { Player, RosterSlot, Team } from '@/lib/types';
import { InjuryBadge } from '@/components/InjuryBadge';

export interface RosterSlotEnriched extends RosterSlot {
  player: (Player & { teams?: Pick<Team, 'id' | 'name' | 'seed' | 'region' | 'is_eliminated'> | null }) | null;
  per_round: { round_stage: string; points: number }[];
  uncounted_round: { round_stage: string; points: number }[];
  total_points: number;
}

function sortRounds(per_round: { round_stage: string; points: number }[]) {
  return [...per_round].sort(
    (a, b) =>
      ROUND_STAGE_ORDER.indexOf(a.round_stage as RoundStage) -
      ROUND_STAGE_ORDER.indexOf(b.round_stage as RoundStage)
  );
}

export function SlotRow({ slot, historical }: { slot: RosterSlotEnriched; historical?: boolean }) {
  const rounds = sortRounds(slot.per_round);
  const uncountedRounds = sortRounds(slot.uncounted_round);
  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 px-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!historical && <span className="text-xs font-mono text-neutral-500 w-8">{slot.slot_key}</span>}
          <span className="font-medium text-white">
            {slot.player?.name ?? slot.player_id.slice(0, 8)}
          </span>
          <span className="text-xs text-neutral-500">{slot.player?.position}</span>
          {slot.player?.teams && (
            <span className="text-xs text-neutral-500">
              {slot.player.teams.name} ({slot.player.teams.seed})
            </span>
          )}
          {!historical && !slot.is_active && (
            <span className="rounded bg-neutral-800 px-1.5 py-0.5 text-xs text-neutral-400">
              {slot.release_reason ?? 'released'}
            </span>
          )}
          {!historical && slot.is_active && (
            <InjuryBadge
              status={slot.player?.injury_status}
              note={slot.player?.injury_note}
              updatedAt={slot.player?.injury_updated_at}
            />
          )}
        </div>

        {(rounds.length > 0 || uncountedRounds.length > 0) && (
          <div className="mt-1 flex flex-wrap gap-2">
            {rounds.map((r) => (
              <span key={r.round_stage} className="text-xs text-neutral-500">
                {ROUND_LABELS[r.round_stage] ?? r.round_stage}: {r.points}
              </span>
            ))}
            {uncountedRounds.map((r) => (
              <span
                key={r.round_stage}
                className="text-xs text-neutral-600 line-through"
                title="Scored, but not counted toward this roster slot"
              >
                {ROUND_LABELS[r.round_stage] ?? r.round_stage}: {r.points}
              </span>
            ))}
          </div>
        )}
      </div>

      <span className="text-sm font-semibold text-yellow-400 tabular-nums">
        {slot.total_points} pts
      </span>
    </li>
  );
}

export function Section({
  title,
  slots,
  muted,
  historical,
}: {
  title: string;
  slots: RosterSlotEnriched[];
  muted?: boolean;
  historical?: boolean;
}) {
  if (slots.length === 0) return null;
  return (
    <div className={`rounded-lg border bg-neutral-900 shadow-sm ${muted ? 'border-neutral-900 opacity-75' : 'border-neutral-800'}`}>
      <div className="border-b border-neutral-800 px-4 py-3">
        <h2 className="text-base font-semibold text-neutral-200">{title}</h2>
      </div>
      <ul className="divide-y divide-neutral-800 px-4">
        {slots.map((s) => (
          <SlotRow key={s.id} slot={s} historical={historical} />
        ))}
      </ul>
    </div>
  );
}
