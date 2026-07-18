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
 *
 * Dash policy: within a slot's owned window a cell is NEVER null — a missing
 * game_scores row means the player didn't check in (DNP) while their team
 * played, which renders as 0 (single-elimination: an alive team plays every
 * round). null is reserved for the two structural cases: rounds before the
 * slot was acquired, and the play_in column for the 60 teams that were never
 * in a First Four game.
 *
 * Post-release bench cells return 'elim', mirroring how released starter
 * slots already render. When the release was actually a PROMOTION (not the
 * team dying), the same player has a starter slot covering those rounds, and
 * every per-player view (mergePlayerRounds, buildRoundEntries) picks the best
 * cell by counted > raw > elim > null — so the starter cells win and the
 * 'elim' never shows. release_reason can't distinguish the two cases at slot
 * level: promotions also write release_reason='eliminated' on the vacated
 * bench row (see RosterActivationService.activateSlot).
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

  // Structural absence: only First Four teams have a play_in game. A missing
  // play_in row means "no game existed", not "scored zero".
  const playInNoGame = stage === 'play_in' && lookupPoints(rawPoints, stage) === undefined;

  if (slot.is_bench) {
    // Bench period runs through (and including) the release round, if any
    const inBenchPeriod = stageIdx < relIdx || (slot.released_at_round_stage != null && stageIdx === relIdx);
    if (!inBenchPeriod) return { kind: 'elim' }; // see doc comment — masked by starter cells when promoted
    if (playInNoGame) return null;
    return { kind: 'raw', value: lookupPoints(rawPoints, stage) ?? 0 };
  }

  // Active/starter slot — inside the scoring window, counts toward the total
  if (stageIdx < relIdx) {
    if (playInNoGame) return null;
    const counted = lookupPoints(countedPoints, stage);
    if (counted !== undefined) return { kind: 'counted', value: counted };
    // Game happened but nothing credited yet (accumulator lag / fire-and-forget
    // recompute in flight): show the real score as raw rather than a false 0.
    const raw = lookupPoints(rawPoints, stage);
    if (raw !== undefined) return { kind: 'raw', value: raw };
    return { kind: 'counted', value: 0 }; // DNP — played-round zero, counts as zero
  }

  // Elimination round itself — the team played (and lost) this round; show the raw game score
  if (stageIdx === relIdx && slot.released_at_round_stage != null) {
    if (playInNoGame) return null;
    return { kind: 'raw', value: lookupPoints(rawPoints, stage) ?? 0 };
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
