/**
 * Manually trigger a full ScoreAccumulator recompute for a league —
 * clears existing scoring_events and rebuilds from game_scores.
 * Usage: npx tsx --env-file=.env.local scripts/recompute-league.ts <league_id>
 */

import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';

async function main() {
  const league_id = process.argv[2];
  if (!league_id) {
    console.error('Usage: npx tsx --env-file=.env.local scripts/recompute-league.ts <league_id>');
    process.exit(1);
  }

  console.log(`Recomputing ${league_id}...`);
  await ScoreAccumulator.runForLeague(league_id);
  console.log(`Done: ${league_id}`);
}

main();
