// Pure-function regression tests for src/lib/utils/mergePlayerRounds.ts — needs
// NO database. mergePlayerRounds() collapses a player's full roster_slots
// history (e.g. a released bench stint + a promoted starter stint) into ONE
// display row, picking each round's cell by preference counted > raw > elim >
// null via the shared getRoundCell() semantics, and summing only 'counted'
// cells into the row total.
//
// Run with: npx tsx scripts/test/unit-merge-player-rounds.ts

import {
  mergePlayerRounds,
  groupAndMergeSlots,
  type MergeableSlot,
} from '@/lib/utils/mergePlayerRounds';
import type { RoundStage } from '@/lib/constants/rounds';

// ── Test runner (same local pattern as scripts/test/unit-round-entries.ts) ──

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

type TestSlot = MergeableSlot & { player_id: string };

function slot(overrides: Partial<TestSlot> & { player_id: string }): TestSlot {
  return {
    is_bench: false,
    is_active: true,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: null,
    counted_pts: {},
    raw_pts: {},
    ...overrides,
  };
}

const STAGES: RoundStage[] = ['r64', 'r32', 's16', 'e8'];

// ── Cases ────────────────────────────────────────────────────────────────

// (1) Single starter slot passes through unchanged with correct total.
runCase('(1) Single starter slot passes through unchanged', () => {
  const starter = slot({
    player_id: 'p1',
    counted_pts: { r64: 20, r32: 15 },
    raw_pts: { r64: 20, r32: 15 },
  });

  const row = mergePlayerRounds([starter], STAGES);
  assert(row.cells['r64']?.kind === 'counted', `r64 expected 'counted', got ${JSON.stringify(row.cells['r64'])}`);
  assert(row.cells['r64']?.kind === 'counted' && row.cells['r64'].value === 20, 'r64 expected value 20');
  assert(row.cells['r32']?.kind === 'counted' && row.cells['r32'].value === 15, `r32 expected counted 15, got ${JSON.stringify(row.cells['r32'])}`);
  // Dash policy (July 2026): an in-window round with no game row is a DNP 0,
  // never "—" — callers hide genuinely-unplayed future rounds via visible
  // columns, not via null cells. See unit-round-cell-semantics.ts.
  assert(
    row.cells['s16']?.kind === 'counted' && row.cells['s16'].value === 0,
    `s16 expected counted 0 (DNP fill), got ${JSON.stringify(row.cells['s16'])}`
  );
  assert(row.total === 35, `expected total 35, got ${row.total}`);
  assert(row.is_bench === false, 'expected is_bench=false');
  assert(row.is_active === true, 'expected is_active=true');
  assert(row.had_bench_stint === false, 'expected had_bench_stint=false');
  assert(row.promoted_at_round_stage === null, 'expected promoted_at_round_stage=null');
  assert(row.latest === starter, 'expected latest to be the single slot');
});

// (2) Bench-then-promoted player merges to one row: pre-promotion 'raw',
//     transition round 'counted' (beats the bench slot's release-round 'raw'),
//     post-promotion 'counted', total counts only counted cells, promoted-tag
//     metadata present.
runCase('(2) Bench-then-promoted merges to one row, counted wins the transition round', () => {
  const benchStint = slot({
    player_id: 'p2',
    is_bench: true,
    is_active: false,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 'r32', // promoted at r32
    counted_pts: {}, // bench never earns credited points
    raw_pts: { r64: 10, r32: 12, s16: 18 },
  });
  const starterStint = slot({
    player_id: 'p2',
    is_bench: false,
    is_active: true,
    acquired_at_round_stage: 'r32', // same round the bench slot released
    released_at_round_stage: null,
    counted_pts: { r32: 12, s16: 18 }, // credited from promotion onward
    raw_pts: { r64: 10, r32: 12, s16: 18 },
  });

  const rows = groupAndMergeSlots([benchStint, starterStint], STAGES);
  assert(rows.length === 1, `expected exactly 1 merged row, got ${rows.length}`);
  const row = rows[0];

  // Pre-promotion round: bench stint only → raw
  assert(row.cells['r64']?.kind === 'raw' && row.cells['r64'].value === 10, `r64 expected raw 10, got ${JSON.stringify(row.cells['r64'])}`);
  // Transition round: bench slot yields 'raw' (its release round) but the new
  // starter slot yields 'counted' — counted must win.
  assert(row.cells['r32']?.kind === 'counted' && row.cells['r32'].value === 12, `r32 expected counted 12 (counted beats raw), got ${JSON.stringify(row.cells['r32'])}`);
  // Post-promotion round: counted
  assert(row.cells['s16']?.kind === 'counted' && row.cells['s16'].value === 18, `s16 expected counted 18, got ${JSON.stringify(row.cells['s16'])}`);
  // Total counts only counted cells: 12 + 18 (NOT the r64 bench 10)
  assert(row.total === 30, `expected total 30 (counted only), got ${row.total}`);
  // Promoted-tag metadata
  assert(row.had_bench_stint === true, 'expected had_bench_stint=true');
  assert(row.promoted_at_round_stage === 'r32', `expected promoted_at_round_stage='r32', got ${row.promoted_at_round_stage}`);
  // Current status comes from the latest (starter) slot
  assert(row.is_bench === false, 'expected current is_bench=false (starter now)');
  assert(row.is_active === true, 'expected current is_active=true');
  assert(row.latest === starterStint, 'expected latest slot to be the starter stint');
});

// (3) Player eliminated with no promotion → trailing 'elim' cells, current
//     status released.
runCase("(3) Eliminated starter → trailing 'elim' cells, current status released", () => {
  const starter = slot({
    player_id: 'p3',
    is_active: false, // released when eliminated
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 's16', // team lost in s16
    counted_pts: { r64: 20, r32: 9 },
    raw_pts: { r64: 20, r32: 9, s16: 7 },
  });

  const row = mergePlayerRounds([starter], STAGES);
  assert(row.cells['r64']?.kind === 'counted' && row.cells['r64'].value === 20, `r64 expected counted 20, got ${JSON.stringify(row.cells['r64'])}`);
  assert(row.cells['r32']?.kind === 'counted' && row.cells['r32'].value === 9, `r32 expected counted 9, got ${JSON.stringify(row.cells['r32'])}`);
  // Elimination round itself: raw (played and lost — doesn't count)
  assert(row.cells['s16']?.kind === 'raw' && row.cells['s16'].value === 7, `s16 expected raw 7, got ${JSON.stringify(row.cells['s16'])}`);
  // Rounds after elimination: elim badge
  assert(row.cells['e8']?.kind === 'elim', `e8 expected 'elim', got ${JSON.stringify(row.cells['e8'])}`);
  assert(row.total === 29, `expected total 29 (counted only), got ${row.total}`);
  assert(row.is_active === false, 'expected current status released (is_active=false)');
  assert(row.had_bench_stint === false, 'expected had_bench_stint=false');
  assert(row.promoted_at_round_stage === null, 'expected promoted_at_round_stage=null');
});

// (4) Pure bench player: all 'raw', total 0.
runCase("(4) Pure bench player → all 'raw', total 0", () => {
  const bench = slot({
    player_id: 'p4',
    is_bench: true,
    is_active: true,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: null,
    counted_pts: {},
    raw_pts: { r64: 5, r32: 8 },
  });

  const row = mergePlayerRounds([bench], STAGES);
  assert(row.cells['r64']?.kind === 'raw' && row.cells['r64'].value === 5, `r64 expected raw 5, got ${JSON.stringify(row.cells['r64'])}`);
  assert(row.cells['r32']?.kind === 'raw' && row.cells['r32'].value === 8, `r32 expected raw 8, got ${JSON.stringify(row.cells['r32'])}`);
  // Dash policy (July 2026): bench DNP within the window renders strikethrough
  // 0, never "—". See unit-round-cell-semantics.ts.
  assert(
    row.cells['s16']?.kind === 'raw' && row.cells['s16'].value === 0,
    `s16 expected raw 0 (DNP fill), got ${JSON.stringify(row.cells['s16'])}`
  );
  assert(row.total === 0, `expected total 0 (raw never counts), got ${row.total}`);
  assert(row.is_bench === true, 'expected current is_bench=true');
  assert(row.is_active === true, 'expected is_active=true');
  assert(row.had_bench_stint === false, 'expected had_bench_stint=false (bench IS the current stint)');
  assert(row.promoted_at_round_stage === null, 'expected promoted_at_round_stage=null');
});

// ── Summary ──────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

if (failed > 0) process.exit(1);
