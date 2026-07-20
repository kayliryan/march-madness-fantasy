import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';

/**
 * Shared per-round scoring cell semantics — used everywhere a user's roster is
 * broken down round by round (leaderboard expand rows, demo standings, roster
 * page, and the mock draft season simulator). One rule set, one place.
 *
 * - 'counted' — this roster slot was active (starting) this round; the value
 *   counts toward the user's total. INCLUDES the round the team lost while the
 *   player was starting — the elimination game is a real game the starter played,
 *   so it scores (see the inclusive window below).
 * - 'raw'     — the player's team played this round, but the points don't count
 *   (they were on the bench).
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
  /**
   * Why the slot ended. Only 'substituted' changes the semantics here: it marks
   * a BENCH row that ended because the player was promoted away (not their team
   * dying), so this row only owns the rounds strictly BEFORE the promotion — the
   * player's separate starter row owns the promotion round onward. Any other
   * value (or undefined) is treated as a team-elimination / still-active window
   * whose release round is INCLUSIVE (the loss round counts).
   */
  release_reason?: string | null;
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
 * The scoring window is [acqIdx, relIdx] and is INCLUSIVE of the release round
 * for a team-elimination (release_reason 'eliminated', or a null release meaning
 * still active): the round the team lost is a real game the starter played, so it
 * COUNTS. Only strictly-after-release rounds are 'elim'. This mirrors
 * ScoreAccumulator's inclusive crediting window so the display total equals the
 * summed 'counted' cells.
 *
 * release_reason 'substituted' is the one exception: it marks a BENCH row that
 * ended because the player was promoted away (not their team dying). That row
 * only owns the rounds strictly BEFORE the promotion (raw/struck); the promotion
 * round onward returns null because the player's separate STARTER row owns those
 * rounds, and every per-player view (mergePlayerRounds, buildRoundEntries) then
 * shows the starter cells. (Older prod data wrote 'eliminated' on promoted bench
 * rows; that still renders correctly via counted > raw > elim > null masking —
 * 'substituted' just makes it explicit.)
 *
 * Dash policy: within a slot's owned window a cell is NEVER null — a missing
 * game_scores row means the player didn't check in (DNP) while their team
 * played, which renders as 0 (single-elimination: an alive team plays every
 * round). null is reserved for the structural cases: rounds before the slot was
 * acquired, the play_in column for teams that were never in a First Four game,
 * and a 'substituted' bench row's post-promotion rounds.
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

  // A bench row that ended because the player was PROMOTED away: it owns only the
  // rounds strictly before the promotion; the promotion round onward belongs to
  // the player's starter row (merge prefers it).
  if (slot.release_reason === 'substituted') {
    if (stageIdx >= relIdx) return null;
    if (playInNoGame) return null;
    return { kind: 'raw', value: lookupPoints(rawPoints, stage) ?? 0 };
  }

  // Team-elimination ('eliminated') or still-active (null release): the window
  // [acqIdx, relIdx] is INCLUSIVE of the release round — the loss round counts.
  if (stageIdx > relIdx) return { kind: 'elim' }; // strictly after elimination

  if (playInNoGame) return null;

  if (slot.is_bench) {
    // Bench never scores toward the total, but the game still happened this round.
    return { kind: 'raw', value: lookupPoints(rawPoints, stage) ?? 0 };
  }

  // Starter inside the (inclusive) scoring window — counts toward the total.
  const counted = lookupPoints(countedPoints, stage);
  if (counted !== undefined) return { kind: 'counted', value: counted };
  // Game happened but nothing credited yet (accumulator lag / fire-and-forget
  // recompute in flight): the player was starting, so it still counts — surface
  // the real score as counted rather than a false 0.
  const raw = lookupPoints(rawPoints, stage);
  if (raw !== undefined) return { kind: 'counted', value: raw };
  return { kind: 'counted', value: 0 }; // DNP — played-round zero, counts as zero
}

/** Convenience: build a round_stage -> points Map from an array of {round_stage, points}. */
export function toRoundPointsMap(rows: { round_stage: string; points: number }[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const r of rows) map.set(r.round_stage, r.points);
  return map;
}
