// Pure-function regression tests for src/lib/utils/roundEntries.ts — needs NO
// database. buildRoundEntries() takes plain in-memory arrays (roster_slots,
// game_scores, scoring_events) and returns the display rows for one round,
// reusing the shared getRoundCell() semantics (src/lib/utils/roundBreakdown.ts)
// to decide counted/raw/elim and to dedupe a player who has more than one
// roster_slots history row into exactly one row per round.
//
// Run with: npx tsx scripts/test/unit-round-entries.ts

import {
  buildRoundEntries,
  type RoundEntrySlotInput,
  type RoundEntryGameScoreInput,
  type RoundEntryScoringEventInput,
} from '@/lib/utils/roundEntries';

// ── Test runner (same local pattern as scripts/test/unit-regression.ts) ────

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

class AssertionError extends Error {}
function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

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

// ── Fixtures ─────────────────────────────────────────────────────────────

const LEAGUE_USER = 'user-1';

function slot(overrides: Partial<RoundEntrySlotInput> & { id: string; player_id: string }): RoundEntrySlotInput {
  return {
    user_id: LEAGUE_USER,
    is_bench: false,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: null,
    ...overrides,
  };
}

function gameScore(player_id: string, round_stage: string, points: number): RoundEntryGameScoreInput {
  return { player_id, round_stage, points };
}

function scoringEvent(
  user_id: string,
  player_id: string,
  roster_slot_id: string,
  round_stage: string,
  points_credited: number
): RoundEntryScoringEventInput {
  return { user_id, player_id, roster_slot_id, round_stage, points_credited };
}

// ── Cases ────────────────────────────────────────────────────────────────

// (a) Starter with counted points this round → 'counted'
runCase("(a) Starter with counted points → kind 'counted'", () => {
  const slots = [slot({ id: 'slot-a', player_id: 'player-a', acquired_at_round_stage: 'draft' })];
  const gameScores = [gameScore('player-a', 'r64', 20)];
  const scoringEvents = [scoringEvent(LEAGUE_USER, 'player-a', 'slot-a', 'r64', 20)];

  const rows = buildRoundEntries('r64', slots, gameScores, scoringEvents);
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(rows[0].cell?.kind === 'counted', `expected 'counted', got ${JSON.stringify(rows[0].cell)}`);
  assert(
    rows[0].cell?.kind === 'counted' && rows[0].cell.value === 20,
    `expected value 20, got ${JSON.stringify(rows[0].cell)}`
  );
});

// (b) Bench player with a game that round → 'raw'
runCase("(b) Bench player with a game that round → kind 'raw'", () => {
  const slots = [slot({ id: 'slot-b', player_id: 'player-b', is_bench: true, acquired_at_round_stage: 'draft' })];
  const gameScores = [gameScore('player-b', 'r64', 15)];
  const scoringEvents: RoundEntryScoringEventInput[] = []; // bench players never get credited events

  const rows = buildRoundEntries('r64', slots, gameScores, scoringEvents);
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(rows[0].cell?.kind === 'raw', `expected 'raw', got ${JSON.stringify(rows[0].cell)}`);
  assert(
    rows[0].cell?.kind === 'raw' && rows[0].cell.value === 15,
    `expected value 15, got ${JSON.stringify(rows[0].cell)}`
  );
  assert(rows[0].is_bench === true, 'expected is_bench=true');
});

// (c) Player eliminated in a prior round → 'elim'
runCase("(c) Player eliminated in a prior round → kind 'elim'", () => {
  const slots = [
    slot({
      id: 'slot-c',
      player_id: 'player-c',
      acquired_at_round_stage: 'draft',
      released_at_round_stage: 'r32', // team lost in r32
    }),
  ];
  const gameScores = [gameScore('player-c', 'r32', 8)]; // the elimination-round game itself
  const scoringEvents: RoundEntryScoringEventInput[] = [];

  // s16 comes after r32 — the round being checked here.
  const rows = buildRoundEntries('s16', slots, gameScores, scoringEvents);
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(rows[0].cell?.kind === 'elim', `expected 'elim', got ${JSON.stringify(rows[0].cell)}`);
});

// (d) Released bench slot + active starter slot overlapping the transition round
//     → exactly ONE row, starter slot wins.
runCase('(d) Bench→starter transition round dedupes to exactly one row, starter wins', () => {
  const benchSlot = slot({
    id: 'slot-d-bench',
    player_id: 'player-d',
    is_bench: true,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 'r32', // promoted at r32
  });
  const starterSlot = slot({
    id: 'slot-d-starter',
    player_id: 'player-d',
    is_bench: false,
    acquired_at_round_stage: 'r32', // same round the bench slot released
    released_at_round_stage: null,
  });
  const gameScores = [gameScore('player-d', 'r32', 12)];
  // Only the promoted starter slot earns credited points at r32.
  const scoringEvents = [scoringEvent(LEAGUE_USER, 'player-d', 'slot-d-starter', 'r32', 12)];

  const rows = buildRoundEntries('r32', [benchSlot, starterSlot], gameScores, scoringEvents);
  assert(rows.length === 1, `expected exactly 1 row (dedup), got ${rows.length}: ${JSON.stringify(rows)}`);
  assert(
    rows[0].roster_slot_id === 'slot-d-starter',
    `expected starter slot to win, got roster_slot_id=${rows[0].roster_slot_id}`
  );
  assert(rows[0].is_bench === false, 'expected is_bench=false (starter slot)');
  assert(rows[0].cell?.kind === 'counted', `expected 'counted', got ${JSON.stringify(rows[0].cell)}`);
});

// (e) The release round itself → 'counted' (the loss game scores), for a plain
//     starter whose team lost that round. NEW inclusive semantics: the elimination
//     round is inside the scoring window and counts; ScoreAccumulator credits it too.
runCase("(e) Starter's release round itself → kind 'counted' (the loss counts)", () => {
  const slots = [
    slot({
      id: 'slot-e',
      player_id: 'player-e',
      acquired_at_round_stage: 'draft',
      released_at_round_stage: 'r32', // eliminated in r32
    }),
  ];
  const gameScores = [gameScore('player-e', 'r32', 9)]; // the game they lost
  // The accumulator now credits the loss round (inclusive window).
  const scoringEvents = [scoringEvent(LEAGUE_USER, 'player-e', 'slot-e', 'r32', 9)];

  const rows = buildRoundEntries('r32', slots, gameScores, scoringEvents);
  assert(rows.length === 1, `expected 1 row, got ${rows.length}`);
  assert(rows[0].cell?.kind === 'counted', `expected 'counted' at release round, got ${JSON.stringify(rows[0].cell)}`);
  assert(
    rows[0].cell?.kind === 'counted' && rows[0].cell.value === 9,
    `expected value 9, got ${JSON.stringify(rows[0].cell)}`
  );
});

// ── Summary ──────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

if (failed > 0) process.exit(1);
