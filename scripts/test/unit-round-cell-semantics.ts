/**
 * Pure unit tests for the getRoundCell dash policy (no database).
 *
 * Regression context (July 2026 screenshot bug): bench players rendered "—"
 * for rounds after their team was eliminated (starters got a proper Elim
 * badge), and any player-round without a game_scores row rendered "—" instead
 * of 0 — making the leaderboard expand look like broken scoring. The rule now:
 * within a slot's owned window a cell is NEVER null — it's a score, a
 * strikethrough score, a 0, or an Elim badge. null is only for rounds before
 * acquisition and the play_in column of teams that had no First Four game.
 *
 * Run: npx tsx scripts/test/unit-round-cell-semantics.ts
 */

import { getRoundCell } from '../../src/lib/utils/roundBreakdown';
import type { RoundCellSlot } from '../../src/lib/utils/roundBreakdown';
import { ROUND_STAGE_ORDER } from '../../src/lib/constants/rounds';
import type { RoundStage } from '../../src/lib/constants/rounds';

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

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

const STAGES = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];

function cells(counted: Record<string, number>, raw: Record<string, number>, slot: RoundCellSlot) {
  return Object.fromEntries(STAGES.map((s) => [s, getRoundCell(s, counted, raw, slot)]));
}

// ── The screenshot cases ──────────────────────────────────────────────────

runCase('Bench player after own-team elimination → Elim badges, never “—”', () => {
  // Victor Nelson case: bench, team eliminated s16 (raw scores through s16)
  const slot: RoundCellSlot = { is_bench: true, acquired_at_round_stage: 'draft', released_at_round_stage: 's16' };
  const c = cells({}, { r64: 12, r32: 12, s16: 13 }, slot);
  assert(c.r64?.kind === 'raw' && c.r64.value === 12, `r64: ${JSON.stringify(c.r64)}`);
  assert(c.s16?.kind === 'raw' && c.s16.value === 13, `s16 (elim round): ${JSON.stringify(c.s16)}`);
  for (const s of ['e8', 'f4', 'championship'] as const) {
    assert(c[s]?.kind === 'elim', `${s}: expected elim, got ${JSON.stringify(c[s])}`);
  }
});

runCase('Bench player with no game rows at all → strikethrough 0s then Elim, never “—”', () => {
  // DeShawn Adams case: bench, team eliminated r64, player never checked in (DNP)
  const slot: RoundCellSlot = { is_bench: true, acquired_at_round_stage: 'draft', released_at_round_stage: 'r64' };
  const c = cells({}, {}, slot);
  assert(c.r64?.kind === 'raw' && c.r64.value === 0, `r64 DNP: expected raw 0, got ${JSON.stringify(c.r64)}`);
  assert(c.r32?.kind === 'elim' && c.championship?.kind === 'elim', 'post-elim rounds must be Elim');
});

runCase('Starter DNP in a played round → counted 0, never “—”', () => {
  const slot: RoundCellSlot = { is_bench: false, acquired_at_round_stage: 'draft', released_at_round_stage: null };
  const c = cells({ r64: 15 }, { r64: 15 }, slot);
  assert(c.r64?.kind === 'counted' && c.r64.value === 15, `r64: ${JSON.stringify(c.r64)}`);
  assert(c.r32?.kind === 'counted' && c.r32.value === 0, `r32 DNP: expected counted 0, got ${JSON.stringify(c.r32)}`);
});

runCase('Starter with a game score but no credit yet (accumulator lag) → raw, not a false 0', () => {
  const slot: RoundCellSlot = { is_bench: false, acquired_at_round_stage: 'draft', released_at_round_stage: null };
  const cell = getRoundCell('r32', { r64: 15 }, { r64: 15, r32: 22 }, slot);
  assert(cell?.kind === 'raw' && cell.value === 22, `expected raw 22, got ${JSON.stringify(cell)}`);
});

// ── The two legitimate “—” cases ──────────────────────────────────────────

runCase('play_in with no game (team not in the First Four) → “—” preserved', () => {
  const starter: RoundCellSlot = { is_bench: false, acquired_at_round_stage: 'draft', released_at_round_stage: null };
  const bench: RoundCellSlot = { is_bench: true, acquired_at_round_stage: 'draft', released_at_round_stage: null };
  assert(getRoundCell('play_in', {}, {}, starter) === null, 'starter play_in should be null');
  assert(getRoundCell('play_in', {}, {}, bench) === null, 'bench play_in should be null');
  // ...but a First Four team's play_in game still renders
  const ff = getRoundCell('play_in', {}, { play_in: 9 }, bench);
  assert(ff?.kind === 'raw' && ff.value === 9, `First Four bench game: ${JSON.stringify(ff)}`);
});

runCase('Rounds before acquisition → “—” preserved', () => {
  const slot: RoundCellSlot = { is_bench: false, acquired_at_round_stage: 's16', released_at_round_stage: null };
  assert(getRoundCell('r64', {}, {}, slot) === null, 'pre-acquisition r64 should be null');
  assert(getRoundCell('r32', {}, {}, slot) === null, 'pre-acquisition r32 should be null');
});

// ── Promotion masking (why bench post-release = elim is safe) ─────────────

runCase('Promoted player: starter cells outrank the old bench slot in per-player views', () => {
  // Old bench slot released r32 (promotion); new starter slot acquired r32.
  const benchSlot: RoundCellSlot = { is_bench: true, acquired_at_round_stage: 'draft', released_at_round_stage: 'r32' };
  const starterSlot: RoundCellSlot = { is_bench: false, acquired_at_round_stage: 'r32', released_at_round_stage: null };
  const counted = { r32: 14, s16: 18 };
  const raw = { r64: 9, r32: 14, s16: 18 };
  const rank = (k: string | undefined) => ({ counted: 3, raw: 2, elim: 1 }[k ?? ''] ?? 0);
  for (const s of ['r32', 's16', 'e8'] as const) {
    const b = getRoundCell(s, {}, raw, benchSlot);
    const st = getRoundCell(s, counted, raw, starterSlot);
    assert(rank(st?.kind) >= rank(b?.kind), `${s}: starter cell ${JSON.stringify(st)} must outrank bench ${JSON.stringify(b)}`);
  }
});

const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (of ${results.length})`);
if (failed > 0) process.exit(1);
