// Pure unit tests for playedRoundStages() (src/lib/utils/roundVisibility.ts) —
// no DB access needed, but follows the same PASS/FAIL runCase() pattern as the
// other scripts/test/unit-*.ts scripts for consistency.
//
// Regression target: demo/league's Round-by-Round + Standings tabs previously
// decided which round columns to show by filtering `per_round[stage] > 0`,
// which made a round vanish entirely whenever every league member's starters
// happened to score zero that round (a real, played round with a real zero
// total — not "the round didn't happen"). playedRoundStages() fixes this by
// using key PRESENCE instead of value.

import { assert } from './utils/testHelpers';
import { playedRoundStages } from '@/lib/utils/roundVisibility';

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

function runCase(name: string, fn: () => void): void {
  try {
    fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
  }
}

runCase('Case 1 — a round with a zero total for every user is still shown (the core regression)', () => {
  const perRoundMaps = [
    { r64: 40, r32: 0 }, // this user's starters combined for 0 in r32 — round still happened
    { r64: 35, r32: 0 },
  ];
  const visible = playedRoundStages(perRoundMaps);
  assert(visible.includes('r64'), 'r64 should be visible');
  assert(visible.includes('r32'), 'r32 (all-zero round) should still be visible — it was played');
});

runCase('Case 2 — a round nobody has a key for at all is correctly hidden', () => {
  const perRoundMaps = [
    { r64: 40 },
    { r64: 35 },
  ];
  const visible = playedRoundStages(perRoundMaps);
  assert(visible.includes('r64'), 'r64 should be visible');
  assert(!visible.includes('r32'), 'r32 was never played by anyone — should not appear as a column');
  assert(!visible.includes('s16'), 's16 should not appear');
});

runCase('Case 3 — presence in ANY one user is enough to show the column for everyone', () => {
  const perRoundMaps: Record<string, number>[] = [
    { r64: 40, r32: 12 },
    { r64: 35 }, // this user's roster was fully benched / never scored in r32
  ];
  const visible = playedRoundStages(perRoundMaps);
  assert(visible.includes('r32'), 'r32 should be visible because at least one user has a scoring_events row for it');
});

runCase('Case 4 — result is in tournament order and excludes draft', () => {
  const perRoundMaps = [
    { championship: 10, r64: 5, s16: 0, e8: 8 },
  ];
  const visible = playedRoundStages(perRoundMaps);
  assert(
    JSON.stringify(visible) === JSON.stringify(['r64', 's16', 'e8', 'championship']),
    `expected tournament-ordered ['r64','s16','e8','championship'], got ${JSON.stringify(visible)}`
  );
  assert(!visible.includes('draft' as never), 'draft should never be a displayed column');
});

runCase('Case 5 — empty input yields no visible rounds', () => {
  const visible = playedRoundStages([]);
  assert(visible.length === 0, `expected no visible rounds for empty input, got ${JSON.stringify(visible)}`);
});

runCase('Case 6 — play_in only appears when actually present', () => {
  const withoutPlayIn = playedRoundStages([{ r64: 10 }]);
  assert(!withoutPlayIn.includes('play_in'), 'play_in should not appear when no user has a play_in entry');

  const withPlayIn = playedRoundStages([{ play_in: 0, r64: 10 }]);
  assert(withPlayIn.includes('play_in'), 'play_in (even at 0) should appear once present as a key');
});

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

if (failed > 0) process.exit(1);
