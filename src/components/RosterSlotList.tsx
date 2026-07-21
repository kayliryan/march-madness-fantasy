import { ROUND_STAGE_ORDER, ROUND_LABELS } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { Player, RosterSlot, Team } from '@/lib/types';
import { InjuryBadge } from '@/components/InjuryBadge';
import { getRoundCell, toRoundPointsMap } from '@/lib/utils/roundBreakdown';
import { RoundCellBadge } from '@/components/RoundCellBadge';
import { PlayerNameCell } from '@/components/PlayerNameCell';
import { PlayerTeamLabel } from '@/components/PlayerTeamLabel';

export interface RosterSlotEnriched extends RosterSlot {
  player: (Player & { teams?: Pick<Team, 'id' | 'name' | 'short_name' | 'seed' | 'region' | 'is_eliminated'> | null }) | null;
  per_round: { round_stage: string; points: number }[];
  raw_round: { round_stage: string; points: number }[];
  total_points: number;
}

/** Every round stage that has any data across a set of slots — decides which columns to show. */
export function visibleRoundsFor(slots: RosterSlotEnriched[]): RoundStage[] {
  const played = new Set<string>();
  for (const s of slots) {
    for (const r of s.per_round) played.add(r.round_stage);
    for (const r of s.raw_round) played.add(r.round_stage);
  }
  return (ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[]).filter((s) => played.has(s));
}

export function SlotRow({
  slot,
  historical,
  visibleRounds,
}: {
  slot: RosterSlotEnriched;
  historical?: boolean;
  visibleRounds: RoundStage[];
}) {
  const countedPts = toRoundPointsMap(slot.per_round);
  const rawPts = toRoundPointsMap(slot.raw_round);

  // Name status reflects the latest round we have data for. When no rounds have
  // been played yet (pre-tournament roster), there's no round concept — fall
  // back to the plain, status-free PlayerTeamLabel.
  const nameNode = (() => {
    const playerName = slot.player?.name ?? slot.player_id.slice(0, 8);
    const team = slot.player?.teams ?? null;
    const position = slot.player?.position ?? null;
    if (visibleRounds.length > 0) {
      const cell = getRoundCell(visibleRounds[visibleRounds.length - 1], countedPts, rawPts, slot);
      return <PlayerNameCell name={playerName} position={position} team={team} cell={cell} />;
    }
    return <PlayerTeamLabel name={playerName} position={position} team={team} />;
  })();

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2.5 px-1">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {!historical && <span className="text-xs font-mono text-neutral-500 w-8">{slot.slot_key}</span>}
          {nameNode}
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

        {visibleRounds.length > 0 && (
          <div className="mt-1 flex flex-wrap gap-x-3 gap-y-1">
            {visibleRounds.map((stage) => {
              const cell = getRoundCell(stage, countedPts, rawPts, slot);
              if (cell === null) return null;
              return (
                <span key={stage} className="flex items-center gap-1 text-xs">
                  <span className="text-neutral-600">{ROUND_LABELS[stage] ?? stage}:</span>
                  <RoundCellBadge cell={cell} />
                </span>
              );
            })}
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
  visibleRounds,
}: {
  title: string;
  slots: RosterSlotEnriched[];
  muted?: boolean;
  historical?: boolean;
  visibleRounds: RoundStage[];
}) {
  if (slots.length === 0) return null;
  return (
    <div className={`rounded-lg border bg-neutral-900 shadow-sm ${muted ? 'border-neutral-900 opacity-75' : 'border-neutral-800'}`}>
      <div className="border-b border-neutral-800 px-4 py-3">
        <h2 className="text-base font-semibold text-neutral-200">{title}</h2>
      </div>
      <ul className="divide-y divide-neutral-800 px-4">
        {slots.map((s) => (
          <SlotRow key={s.id} slot={s} historical={historical} visibleRounds={visibleRounds} />
        ))}
      </ul>
    </div>
  );
}
