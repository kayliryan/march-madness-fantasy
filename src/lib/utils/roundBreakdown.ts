import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';

/**
 * Shared per-round scoring cell semantics — used everywhere a user's roster is
 * broken down round by round (leaderboard expand rows, demo standings, roster
 * page, and the mock draft season simulator). One rule set, one place.
 *
 * - 'counted' — this roster slot was active (starting) this round; the value
 *   counts toward the user's total.
 * - 'raw'     — the player's team played this round, but the points don't
 *   count (they were on the bench, or this is the round their team lost while
 *   they were starting — the game still happened, just doesn't score).
 * - 'elim'    — this player's team was already out by this round; nothing to show.
 * - null      — not on this roster slot yet, or the round hasn't happened.
 */
export type RoundCell =
  | { kind: 'counted'; value: number }
  | { kind: 'raw'; value: number }
  | { kind: 'elim' }
  | null;

export interface RoundCellSlot {
  is_bench: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage?: string | null;
}

/** Points lookup accepted by getRoundCell — callers may already have either shape. */
export type PointsLookup = Map<string, number> | Record<string, number>;

function lookupPoints(points: PointsLookup, stage: string): number | undefined {
  if (points instanceof Map) return points.get(stage);
  return points[stage];
}

/**
 * stage: the round column being rendered
 * countedPoints: round_stage -> points credited toward the user's total (only ever set on starter rounds)
 * rawPoints: round_stage -> the player's actual game score that round, regardless of active/bench
 * slot: acquisition/release window + whether this assignment is a bench or starter slot
 */
export function getRoundCell(
  stage: RoundStage,
  countedPoints: PointsLookup,
  rawPoints: PointsLookup,
  slot: RoundCellSlot,
): RoundCell {
  const stageIdx = ROUND_STAGE_ORDER.indexOf(stage);
  const acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
  const relIdx = slot.released_at_round_stage
    ? ROUND_STAGE_ORDER.indexOf(slot.released_at_round_stage as RoundStage)
    : ROUND_STAGE_ORDER.length;

  // Not on this slot yet
  if (stageIdx < acqIdx) return null;

  if (slot.is_bench) {
    // Bench period runs through (and including) the release round, if any
    const inBenchPeriod = stageIdx < relIdx || (slot.released_at_round_stage != null && stageIdx === relIdx);
    if (!inBenchPeriod) return null;
    const pts = lookupPoints(rawPoints, stage);
    return pts !== undefined ? { kind: 'raw', value: pts } : null;
  }

  // Active/starter slot — inside the scoring window, counts toward the total
  if (stageIdx < relIdx) {
    const pts = lookupPoints(countedPoints, stage);
    return pts !== undefined ? { kind: 'counted', value: pts } : null;
  }

  // Elimination round itself — the team played (and lost) this round; show the raw game score
  if (stageIdx === relIdx && slot.released_at_round_stage != null) {
    const pts = lookupPoints(rawPoints, stage);
    return pts !== undefined ? { kind: 'raw', value: pts } : null;
  }

  // Any round after elimination
  return { kind: 'elim' };
}

/** Convenience: build a round_stage -> points Map from an array of {round_stage, points}. */
export function toRoundPointsMap(rows: { round_stage: string; points: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.round_stage, r.points);
  return map;
}
