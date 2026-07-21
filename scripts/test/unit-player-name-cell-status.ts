// Pure-function tests for the player-NAME round status mapping — needs NO
// database. getPlayerRoundStatus() (src/lib/utils/playerNameStatus.ts) is the
// thin presentational layer PlayerNameCell renders from: it maps a single
// round's RoundCell.kind to {status, showBenchBadge, showElimTag}. The status
// per round is ALREADY computed correctly by getRoundCell()/mergePlayerRounds()
// (counted > raw > elim > null); these cases prove the name row reflects it,
// especially across the bench-to-active promotion transition the product owner
// described (Tyler eliminated, Matt promoted into his slot).
//
// Run with: npx tsx scripts/test/unit-player-name-cell-status.ts

import { getPlayerRoundStatus } from '@/lib/utils/playerNameStatus';
import {
  mergePlayerRounds,
  groupAndMergeSlots,
  type MergeableSlot,
} from '@/lib/utils/mergePlayerRounds';
import type { RoundStage } from '@/lib/constants/rounds';

// ── Test runner (same local pattern as unit-merge-player-rounds.ts) ─────────

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

// Full round sequence used throughout so we can watch a status change across
// the whole tournament, not just the transition round.
const STAGES: RoundStage[] = ['r64', 'r32', 's16', 'e8'];

/**
 * Helper: assert the derived name status for one round, and always assert the
 * bench badge and elim tag are mutually exclusive (a round is never both).
 */
function expectStatus(
  cells: Record<string, ReturnType<typeof mergePlayerRounds>['cells'][string]>,
  stage: RoundStage,
  expected: { status: string; bench: boolean; elim: boolean },
  who: string,
) {
  const s = getPlayerRoundStatus(cells[stage] ?? null);
  assert(
    !(s.showBenchBadge && s.showElimTag),
    `${who} ${stage}: bench badge and elim tag must be mutually exclusive, got both`,
  );
  assert(
    s.status === expected.status,
    `${who} ${stage}: expected status '${expected.status}', got '${s.status}'`,
  );
  assert(
    s.showBenchBadge === expected.bench,
    `${who} ${stage}: expected showBenchBadge=${expected.bench}, got ${s.showBenchBadge}`,
  );
  assert(
    s.showElimTag === expected.elim,
    `${who} ${stage}: expected showElimTag=${expected.elim}, got ${s.showElimTag}`,
  );
}

// ── Case 1: the product-owner promotion scenario (Tyler + Matt) ────────────
// Tyler starts, his team is eliminated in R32 (the loss round still counts).
// Matt is on the bench through R32, then promoted into Tyler's vacated slot at
// the following round (S16).
runCase('(1) Promotion transition: Tyler eliminated R32, Matt promoted into the slot at S16', () => {
  // Tyler — single starter slot, team lost in R32.
  const tyler = slot({
    player_id: 'tyler',
    is_active: false, // released when his team was eliminated
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 'r32', // team lost in R32 (inclusive — the loss counts)
    release_reason: 'eliminated',
    counted_pts: { r64: 20, r32: 10 }, // credited through the loss round
    raw_pts: { r64: 20, r32: 10 },
  });
  const tylerRow = mergePlayerRounds([tyler], STAGES);

  // r64: active/green, no badges. r32 (elimination round): STILL active/green —
  // the loss game counts (existing inclusive-release rule, must not break).
  expectStatus(tylerRow.cells, 'r64', { status: 'active', bench: false, elim: false }, 'Tyler');
  expectStatus(tylerRow.cells, 'r32', { status: 'active', bench: false, elim: false }, 'Tyler');
  // s16 onward: eliminated/grey with the Elim tag, no bench badge.
  expectStatus(tylerRow.cells, 's16', { status: 'eliminated', bench: false, elim: true }, 'Tyler');
  expectStatus(tylerRow.cells, 'e8', { status: 'eliminated', bench: false, elim: true }, 'Tyler');

  // Matt — TWO slot rows: the bench stint that ended by promotion, plus the new
  // starter stint acquired at S16.
  const mattBench = slot({
    player_id: 'matt',
    is_bench: true,
    is_active: false,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 's16', // promoted away at S16
    release_reason: 'substituted', // ended by promotion, NOT team elimination
    counted_pts: {}, // bench never earns credited points
    raw_pts: { r64: 8, r32: 9 }, // bench game scores pre-promotion
  });
  const mattStarter = slot({
    player_id: 'matt',
    is_bench: false,
    is_active: true,
    acquired_at_round_stage: 's16', // promoted into Tyler's slot the round after R32
    released_at_round_stage: null,
    counted_pts: { s16: 15, e8: 12 }, // credited from promotion onward
    raw_pts: { s16: 15, e8: 12 },
  });
  const merged = groupAndMergeSlots([mattBench, mattStarter], STAGES);
  assert(merged.length === 1, `expected Matt to merge to 1 row, got ${merged.length}`);
  const mattRow = merged[0];

  // r64 & r32 (still on the bench): bench/white with the B badge.
  expectStatus(mattRow.cells, 'r64', { status: 'bench', bench: true, elim: false }, 'Matt');
  expectStatus(mattRow.cells, 'r32', { status: 'bench', bench: true, elim: false }, 'Matt');
  // s16 (promotion round) onward: active/green, B badge REMOVED, no Elim tag.
  expectStatus(mattRow.cells, 's16', { status: 'active', bench: false, elim: false }, 'Matt');
  expectStatus(mattRow.cells, 'e8', { status: 'active', bench: false, elim: false }, 'Matt');

  // Sanity: merge metadata reflects the promotion.
  assert(mattRow.promoted_at_round_stage === 's16', `expected Matt promoted_at_round_stage='s16', got ${mattRow.promoted_at_round_stage}`);
  assert(mattRow.is_bench === false, 'expected Matt current is_bench=false (starter now)');
});

// ── Case 2: pure bench player, never promoted, team eventually eliminated ───
runCase('(2) Never-promoted bench player: bench+B through their last game, then eliminated+Elim (badge and tag never overlap)', () => {
  const bench = slot({
    player_id: 'benchie',
    is_bench: true,
    is_active: false,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: 's16', // their team lost in S16
    release_reason: 'eliminated',
    counted_pts: {},
    raw_pts: { r64: 5, r32: 6, s16: 7 }, // played (on the bench) through the S16 loss
  });
  const row = mergePlayerRounds([bench], STAGES);

  // Through their team's last game (S16 inclusive): bench/white + B badge.
  expectStatus(row.cells, 'r64', { status: 'bench', bench: true, elim: false }, 'Benchie');
  expectStatus(row.cells, 'r32', { status: 'bench', bench: true, elim: false }, 'Benchie');
  expectStatus(row.cells, 's16', { status: 'bench', bench: true, elim: false }, 'Benchie');
  // After elimination: eliminated/grey + Elim tag, B badge gone.
  expectStatus(row.cells, 'e8', { status: 'eliminated', bench: false, elim: true }, 'Benchie');
});

// ── Case 3: starter who is never eliminated ────────────────────────────────
runCase('(3) Never-eliminated starter: active/green, no badges, every round', () => {
  const starter = slot({
    player_id: 'survivor',
    is_bench: false,
    is_active: true,
    acquired_at_round_stage: 'draft',
    released_at_round_stage: null,
    counted_pts: { r64: 18, r32: 21, s16: 14, e8: 19 },
    raw_pts: { r64: 18, r32: 21, s16: 14, e8: 19 },
  });
  const row = mergePlayerRounds([starter], STAGES);
  for (const stage of STAGES) {
    expectStatus(row.cells, stage, { status: 'active', bench: false, elim: false }, 'Survivor');
  }
});

// ── Case 4: the null / pending case (round before the player was on the roster) ─
runCase("(4) Round before acquisition → 'pending', no badge or tag", () => {
  const lateAdd = slot({
    player_id: 'latecomer',
    is_bench: false,
    is_active: true,
    acquired_at_round_stage: 's16', // only joined the roster at S16
    released_at_round_stage: null,
    counted_pts: { s16: 12, e8: 10 },
    raw_pts: { s16: 12, e8: 10 },
  });
  const row = mergePlayerRounds([lateAdd], STAGES);
  // Before acquisition → null cell → pending, nothing shown.
  expectStatus(row.cells, 'r64', { status: 'pending', bench: false, elim: false }, 'Latecomer');
  expectStatus(row.cells, 'r32', { status: 'pending', bench: false, elim: false }, 'Latecomer');
  // Once on the roster → active.
  expectStatus(row.cells, 's16', { status: 'active', bench: false, elim: false }, 'Latecomer');
});

// ── Summary ────────────────────────────────────────────────────────────────

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

if (failed > 0) process.exit(1);
