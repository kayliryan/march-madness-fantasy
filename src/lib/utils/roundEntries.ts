import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { getRoundCell, toRoundPointsMap } from '@/lib/utils/roundBreakdown';
import type { RoundCell } from '@/lib/utils/roundBreakdown';

/**
 * Pure, DB-free row builder for the /league/[league_id]/rounds view. Mirrors the
 * counted/raw point assembly established in RosterEnrichment.ts (per-slot credited
 * points, falling back to player-only matching only when a player has exactly one
 * roster_slot in the league) but works across ALL members/players in a league at
 * once, and reuses the shared getRoundCell() semantics (src/lib/utils/roundBreakdown.ts)
 * rather than re-deriving counted/raw/elim rules here.
 *
 * A player can have more than one roster_slots row in a league (e.g. a released
 * bench stint followed by a promoted starter stint) — this module also owns
 * picking exactly ONE slot to display per (user, player) per round, using
 * getRoundCell itself to decide which slot(s) have anything to show for that
 * round, and preferring the starter slot when two windows both touch the round
 * (the release round of one slot equals the acquisition round of the next).
 */

export interface RoundEntrySlotInput {
  id: string;
  user_id: string;
  player_id: string;
  is_bench: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
}

export interface RoundEntryGameScoreInput {
  player_id: string;
  round_stage: string;
  points: number;
}

export interface RoundEntryScoringEventInput {
  user_id: string;
  player_id: string;
  roster_slot_id: string | null;
  round_stage: string;
  points_credited: number;
}

export interface RoundEntryResult {
  roster_slot_id: string;
  user_id: string;
  player_id: string;
  is_bench: boolean;
  cell: RoundCell;
}

/**
 * Builds exactly one display row per (user_id, player_id) for the given round
 * stage, or none if that player has nothing to show that round (not yet
 * acquired by anyone, or a bench slot whose window has already closed).
 */
export function buildRoundEntries(
  stage: RoundStage,
  slots: RoundEntrySlotInput[],
  gameScores: RoundEntryGameScoreInput[],
  scoringEvents: RoundEntryScoringEventInput[],
): RoundEntryResult[] {
  // Raw game-by-game points, keyed by player — shared across every slot a
  // player has ever occupied (bench or starter), just like RosterEnrichment.
  const rawByPlayer = new Map<string, { round_stage: string; points: number }[]>();
  for (const gs of gameScores) {
    if (!rawByPlayer.has(gs.player_id)) rawByPlayer.set(gs.player_id, []);
    rawByPlayer.get(gs.player_id)!.push({ round_stage: gs.round_stage, points: gs.points });
  }

  // Credited points, attributed to the specific roster_slot that earned them.
  // Falls back to (user_id, player_id) matching only for legacy rows that
  // predate roster_slot_id, and only when that player has exactly one slot
  // for that user (same guard as RosterEnrichment.ts).
  const countedBySlotId = new Map<string, { round_stage: string; points: number }[]>();
  const countedByUserPlayerFallback = new Map<string, { round_stage: string; points: number }[]>();
  for (const ev of scoringEvents) {
    const entry = { round_stage: ev.round_stage, points: ev.points_credited };
    if (ev.roster_slot_id) {
      if (!countedBySlotId.has(ev.roster_slot_id)) countedBySlotId.set(ev.roster_slot_id, []);
      countedBySlotId.get(ev.roster_slot_id)!.push(entry);
    } else {
      const key = `${ev.user_id}:${ev.player_id}`;
      if (!countedByUserPlayerFallback.has(key)) countedByUserPlayerFallback.set(key, []);
      countedByUserPlayerFallback.get(key)!.push(entry);
    }
  }

  const slotCountByUserPlayer = new Map<string, number>();
  for (const s of slots) {
    const key = `${s.user_id}:${s.player_id}`;
    slotCountByUserPlayer.set(key, (slotCountByUserPlayer.get(key) ?? 0) + 1);
  }

  // Group slots by (user_id, player_id) so multiple roster_slots history rows
  // for the same player collapse into a single displayed row.
  const slotsByUserPlayer = new Map<string, RoundEntrySlotInput[]>();
  for (const s of slots) {
    const key = `${s.user_id}:${s.player_id}`;
    if (!slotsByUserPlayer.has(key)) slotsByUserPlayer.set(key, []);
    slotsByUserPlayer.get(key)!.push(s);
  }

  const results: RoundEntryResult[] = [];

  for (const [key, group] of slotsByUserPlayer) {
    const rawPoints = toRoundPointsMap(rawByPlayer.get(group[0].player_id) ?? []);

    const candidates: { slot: RoundEntrySlotInput; cell: RoundCell }[] = [];
    for (const slot of group) {
      const bySlot = countedBySlotId.get(slot.id);
      const countedPoints = toRoundPointsMap(
        bySlot ?? (slotCountByUserPlayer.get(key) === 1 ? countedByUserPlayerFallback.get(key) ?? [] : [])
      );
      const cell = getRoundCell(stage, countedPoints, rawPoints, slot);
      if (cell !== null) candidates.push({ slot, cell });
    }

    if (candidates.length === 0) continue;

    let chosen = candidates[0];
    if (candidates.length > 1) {
      // Two windows both touch this round (a release round matching the next
      // slot's acquisition round) — prefer the starter slot for display.
      const starter = candidates.find((c) => !c.slot.is_bench);
      chosen = starter ?? candidates.reduce((latest, c) =>
        ROUND_STAGE_ORDER.indexOf(c.slot.acquired_at_round_stage as RoundStage) >
        ROUND_STAGE_ORDER.indexOf(latest.slot.acquired_at_round_stage as RoundStage)
          ? c
          : latest
      );
    }

    results.push({
      roster_slot_id: chosen.slot.id,
      user_id: chosen.slot.user_id,
      player_id: chosen.slot.player_id,
      is_bench: chosen.slot.is_bench,
      cell: chosen.cell,
    });
  }

  return results;
}
