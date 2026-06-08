/**
 * Round stage ordering for March Madness tournament
 * All stage comparisons use indexOf() — never lexicographic
 */

export const ROUND_STAGE_ORDER = [
  'draft',
  'play_in',
  'r64',
  'r32',
  's16',
  'e8',
  'f4',
  'championship',
] as const;

export type RoundStage = (typeof ROUND_STAGE_ORDER)[number];

/**
 * Get the index of a round stage for comparison
 */
export function getRoundStageIndex(stage: RoundStage): number {
  return ROUND_STAGE_ORDER.indexOf(stage);
}

/**
 * Get the next round stage
 */
export function getNextRoundStage(stage: RoundStage): RoundStage | null {
  const index = getRoundStageIndex(stage);
  if (index === -1 || index === ROUND_STAGE_ORDER.length - 1) return null;
  return ROUND_STAGE_ORDER[index + 1];
}

/**
 * Check if stage A is before stage B
 */
export function isStageBefore(stageA: RoundStage, stageB: RoundStage): boolean {
  return getRoundStageIndex(stageA) < getRoundStageIndex(stageB);
}

/**
 * Check if stage A is after stage B
 */
export function isStageAfter(stageA: RoundStage, stageB: RoundStage): boolean {
  return getRoundStageIndex(stageA) > getRoundStageIndex(stageB);
}

/**
 * Check if stage A is same as or before stage B
 */
export function isStageBeforeOrEqual(
  stageA: RoundStage,
  stageB: RoundStage,
): boolean {
  return getRoundStageIndex(stageA) <= getRoundStageIndex(stageB);
}
