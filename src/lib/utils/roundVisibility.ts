import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';

/**
 * Decides which round-stage COLUMNS a round-by-round table should show, given
 * one per_round map per user (round_stage -> points_credited).
 *
 * Presence, not value: ScoreAccumulator upserts a scoring_events row for every
 * active-starter game it processes, including 0-point (DNP) games — see
 * `_runForGamesInternal` in src/lib/services/ScoreAccumulator.ts, which always
 * upserts `points_credited: game.points` regardless of whether that's zero.
 * So a round_stage key being present in ANY user's per_round map means that
 * round was genuinely played by the league; the summed value for that round
 * (zero or not) is irrelevant to whether the column should be shown.
 *
 * Filtering by `value > 0` instead is the bug this function exists to prevent:
 * a round where every rostered starter legitimately scored zero would vanish
 * from the table entirely, even though the round was played and is a real
 * column with real (zero) data in it.
 *
 * Returns the played stages in tournament order, excluding 'draft' (never a
 * displayed column) and 'play_in' unless it's actually present (most leagues
 * don't score play_in).
 */
export function playedRoundStages(perRoundMaps: Record<string, number>[]): RoundStage[] {
  const played = new Set<string>();
  for (const map of perRoundMaps) {
    for (const stage of Object.keys(map)) played.add(stage);
  }
  return (ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[]).filter((s) => played.has(s));
}
