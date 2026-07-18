import '@/lib/utils/wsPolyfill';
import {
  checkAndIncrementDemoAiCap,
  checkAndIncrementRealLeagueAiCap,
  DEMO_AI_CAP_PER_LEAGUE,
  REAL_LEAGUE_AI_DAILY_CAP,
} from '@/lib/utils/demoAiCap';
import { db, assert } from './utils/testHelpers';

// ── Test runner ────────────────────────────────────────────────────────────

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

/** Minimal league row — no members/draft needed for these cap-only tests. */
async function createBareLeague(overrides: Record<string, unknown>): Promise<string> {
  const { data, error } = await db
    .from('leagues')
    .insert({
      name: `AI Cap Test League ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      season: 2026,
      settings: {},
      ...overrides,
    })
    .select('id')
    .single();
  if (error || !data) throw new Error(`createBareLeague failed: ${error?.message}`);
  return data.id as string;
}

async function deleteLeague(league_id: string): Promise<void> {
  await db.from('leagues').delete().eq('id', league_id);
}

async function getDemoAiCallsUsed(league_id: string): Promise<number> {
  const { data, error } = await db
    .from('leagues')
    .select('demo_ai_calls_used')
    .eq('id', league_id)
    .single();
  if (error || !data) throw new Error(`getDemoAiCallsUsed failed: ${error?.message}`);
  return data.demo_ai_calls_used as number;
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Regression 1 — Layer 1 concurrency: atomic increment-first-then-deny under
  // parallel load. Pre-set the counter 2 below the cap, fire 6 parallel calls,
  // and confirm no more than 2 are allowed through (the atomic RPC still lets
  // every call increment the counter — that's the accepted "may overshoot the
  // counter, but allowed-count is bounded" tradeoff of increment-first).
  await runCase(
    'Regression 1 — checkAndIncrementDemoAiCap Layer 1 concurrency (no over-admission)',
    async () => {
      const startingCalls = DEMO_AI_CAP_PER_LEAGUE - 2;
      const league_id = await createBareLeague({ is_demo: true, demo_ai_calls_used: startingCalls });
      try {
        const results = await Promise.all(
          Array.from({ length: 6 }, () => checkAndIncrementDemoAiCap(league_id, null))
        );
        const allowedCount = results.filter((r) => r.allowed).length;
        assert(
          allowedCount <= 2,
          `Layer 1 concurrency regression: expected at most 2 of 6 parallel calls allowed ` +
          `(cap=${DEMO_AI_CAP_PER_LEAGUE}, starting=${startingCalls}), got ${allowedCount}`
        );

        const finalCalls = await getDemoAiCallsUsed(league_id);
        assert(
          finalCalls === startingCalls + 6,
          `Layer 1 concurrency regression: expected counter to reach exactly ${startingCalls + 6} ` +
          `(atomic increment — no lost updates), got ${finalCalls}`
        );
      } finally {
        await deleteLeague(league_id);
      }
    }
  );

  // Regression 2 — real-league per-league daily cap (Problem 1: previously zero
  // rate limiting for non-demo leagues). Pre-set usage to cap-1, then confirm the
  // call that pushes it to cap is allowed and the next one is denied.
  await runCase(
    'Regression 2 — checkAndIncrementRealLeagueAiCap denies over the daily cap',
    async () => {
      const league_id = await createBareLeague({ is_demo: false });
      const today = new Date().toISOString().slice(0, 10);
      try {
        const { error: seedErr } = await db
          .from('league_ai_daily_usage')
          .insert({ league_id, date: today, calls_used: REAL_LEAGUE_AI_DAILY_CAP - 1 });
        if (seedErr) throw new Error(`seed league_ai_daily_usage failed: ${seedErr.message}`);

        const first = await checkAndIncrementRealLeagueAiCap(league_id);
        assert(first.allowed === true, `Regression 2: expected the ${REAL_LEAGUE_AI_DAILY_CAP}th call to be allowed, got denied`);

        const second = await checkAndIncrementRealLeagueAiCap(league_id);
        assert(second.allowed === false, `Regression 2: expected the ${REAL_LEAGUE_AI_DAILY_CAP + 1}th call to be denied, got allowed`);
        assert(
          !second.allowed && second.reason === 'per_league',
          `Regression 2: expected denial reason 'per_league', got ${!second.allowed ? second.reason : 'allowed'}`
        );
      } finally {
        await db.from('league_ai_daily_usage').delete().eq('league_id', league_id);
        await deleteLeague(league_id);
      }
    }
  );

  // Regression 3 — Layer 1 no lost updates: 10 parallel calls from a counter of 0
  // (well under the cap of 25) should all be allowed, and the final counter should
  // be exactly 10 — proving the old read-then-absolute-update pattern (which could
  // lose updates under concurrency) is gone.
  await runCase(
    'Regression 3 — checkAndIncrementDemoAiCap Layer 1 no lost updates under concurrency',
    async () => {
      const league_id = await createBareLeague({ is_demo: true, demo_ai_calls_used: 0 });
      try {
        const results = await Promise.all(
          Array.from({ length: 10 }, () => checkAndIncrementDemoAiCap(league_id, null))
        );
        const allowedCount = results.filter((r) => r.allowed).length;
        assert(
          allowedCount === 10,
          `Regression 3: expected all 10 parallel calls allowed (well under cap of ${DEMO_AI_CAP_PER_LEAGUE}), got ${allowedCount}`
        );

        const finalCalls = await getDemoAiCallsUsed(league_id);
        assert(
          finalCalls === 10,
          `Regression 3: lost-update regression — expected demo_ai_calls_used === 10 after 10 parallel ` +
          `allowed calls, got ${finalCalls}`
        );
      } finally {
        await deleteLeague(league_id);
      }
    }
  );

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('ai-cap-regression: unhandled error:', err);
  process.exit(1);
});
