import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { getRoundCell } from '@/lib/utils/roundBreakdown';
import type { PointsLookup, RoundCell, RoundCellSlot } from '@/lib/utils/roundBreakdown';

/**
 * Merges a player's full roster_slots history (a bench-promoted player has TWO
 * rows: the released bench stint plus the new starter stint — see migration
 * 20260618000001_fix_roster_slot_unique_constraint.sql) into ONE display row,
 * so round-by-round tables show one line per player instead of one line per
 * historical slot.
 *
 * Per-round merge preference, evaluated via the shared getRoundCell semantics
 * for every slot of the player, best cell wins:
 *
 *   counted > raw > elim > null
 *
 * On the promotion-transition round the old bench slot yields 'raw' for its
 * release round while the new starter slot yields 'counted' for the same round
 * — 'counted' must win, which this ordering guarantees.
 *
 * Pure and client-safe: no server imports, no DB.
 */

/** One roster_slots row plus its per-round points lookups. */
export interface MergeableSlot extends RoundCellSlot {
  /** Whether this slot row is still live (false once released). */
  is_active: boolean;
  /** round_stage -> points credited toward the user's total for THIS slot row. */
  counted_pts: PointsLookup;
  /** round_stage -> the player's raw game score that round (player-level). */
  raw_pts: PointsLookup;
}

export interface MergedPlayerRow<T extends MergeableSlot = MergeableSlot> {
  /**
   * The player's latest slot row — "latest" = highest acquired_at_round_stage
   * index, tiebreak starter over bench. Carries whatever extra display fields
   * (name, team, position…) the caller's slot type has.
   */
  latest: T;
  /** Current status: is the player a bench player right now? (from the latest slot) */
  is_bench: boolean;
  /** Current status: is the player's latest slot still live? (false = no longer active) */
  is_active: boolean;
  /** True when the player served a bench stint before their current slot. */
  had_bench_stint: boolean;
  /**
   * The round the player was promoted bench -> starter, or null if never
   * promoted. Set only when the latest slot is a starter slot acquired after
   * the draft and a prior bench stint exists.
   */
  promoted_at_round_stage: RoundStage | null;
  /** Best cell per requested round stage (counted > raw > elim > null). */
  cells: Record<string, RoundCell>;
  /** Sum of 'counted' cell values only, across the requested stages. */
  total: number;
}

function cellRank(cell: RoundCell): number {
  if (cell === null) return 0;
  if (cell.kind === 'elim') return 1;
  if (cell.kind === 'raw') return 2;
  return 3; // counted
}

function acquiredIdx(slot: RoundCellSlot): number {
  return ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
}

/**
 * Merge ALL of one player's slot rows into a single display row.
 * `slots` must be non-empty and all belong to the same player.
 */
export function mergePlayerRounds<T extends MergeableSlot>(
  slots: T[],
  stages: RoundStage[],
): MergedPlayerRow<T> {
  if (slots.length === 0) {
    throw new Error('mergePlayerRounds: slot list must be non-empty');
  }

  // Latest slot: highest acquisition round; on a tie, starter beats bench.
  let latest = slots[0];
  for (const s of slots.slice(1)) {
    const cmp = acquiredIdx(s) - acquiredIdx(latest);
    if (cmp > 0 || (cmp === 0 && latest.is_bench && !s.is_bench)) latest = s;
  }

  const had_bench_stint = slots.some((s) => s.is_bench && s !== latest);
  const promoted_at_round_stage =
    !latest.is_bench && had_bench_stint && latest.acquired_at_round_stage !== 'draft'
      ? (latest.acquired_at_round_stage as RoundStage)
      : null;

  const cells: Record<string, RoundCell> = {};
  let total = 0;
  for (const stage of stages) {
    let best: RoundCell = null;
    for (const slot of slots) {
      const cell = getRoundCell(stage, slot.counted_pts, slot.raw_pts, slot);
      if (cellRank(cell) > cellRank(best)) best = cell;
    }
    cells[stage] = best;
    if (best?.kind === 'counted') total += best.value;
  }

  return {
    latest,
    is_bench: latest.is_bench,
    is_active: latest.is_active,
    had_bench_stint,
    promoted_at_round_stage,
    cells,
    total,
  };
}

/**
 * Convenience for pages holding a flat list of slot rows spanning many
 * players: group by player_id (preserving first-seen order), then merge each
 * group. Returns one row per distinct player.
 */
export function groupAndMergeSlots<T extends MergeableSlot & { player_id: string }>(
  slots: T[],
  stages: RoundStage[],
): (MergedPlayerRow<T> & { player_id: string })[] {
  const byPlayer = new Map<string, T[]>();
  for (const slot of slots) {
    const arr = byPlayer.get(slot.player_id);
    if (arr) arr.push(slot);
    else byPlayer.set(slot.player_id, [slot]);
  }
  return [...byPlayer.entries()].map(([player_id, playerSlots]) => ({
    player_id,
    ...mergePlayerRounds(playerSlots, stages),
  }));
}
