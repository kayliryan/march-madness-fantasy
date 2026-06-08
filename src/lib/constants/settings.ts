/**
 * Settings keys that affect scoring calculations
 * When any of these settings change, ScoreAccumulator.runForLeague() must be called
 */
export const SCORING_AFFECTING_SETTINGS = [
  'sub_eligibility_matrix',
  'scoring_includes_play_in',
  'activation_timing',
] as const;

export type ScoringAffectingSetting = (typeof SCORING_AFFECTING_SETTINGS)[number];

/**
 * Check if a setting key affects scoring
 */
export function isScoringAffectingSetting(key: string): key is ScoringAffectingSetting {
  return SCORING_AFFECTING_SETTINGS.includes(key as ScoringAffectingSetting);
}
