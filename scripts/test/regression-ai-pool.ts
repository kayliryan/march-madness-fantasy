import '@/lib/utils/wsPolyfill';
import { db, assert } from './utils/testHelpers';
import {
  DemoProvisioningService,
  AI_MEMBER_POOL_IDS,
} from '@/lib/services/DemoProvisioningService';

// Regression test for the shared AI-member pool (demo provisioning latency work).
//
// DemoProvisioningService used to create 7 fresh GoTrue auth users per provision
// (ids derived from the commissioner id). It now reuses ONE global pool of 7
// deterministic users (uuidv5('demo-ai-pool:' + name)) across every demo league.
// This script proves:
//   1. Two sequential provisions succeed and both leagues' league_members contain
//      the SAME 7 pool ids (no duplicate-user errors, no per-commissioner users).
//   2. The pool survives league cleanup (delete_orphaned_demo_leagues) — pool
//      auth users are permanent infrastructure.
//   3. Warm path: with the pool present, ensureAiMemberPool() is effectively free
//      (memoized) and exactly 7 public.users rows exist for the pool ids.

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

// ── Helpers ────────────────────────────────────────────────────────────────

async function createCommissionerUser(label: string): Promise<string> {
  const { data, error } = await db.auth.admin.createUser({
    email: `test-ai-pool-${label}-${Date.now()}@test.invalid`,
    password: 'TestPassword123!',
    email_confirm: true,
    user_metadata: { display_name: `AI Pool Test Commissioner ${label}` },
  });
  if (error || !data.user) {
    throw new Error(`createCommissionerUser(${label}) failed: ${error?.message}`);
  }
  return data.user.id;
}

async function getLeagueMemberIds(league_id: string): Promise<string[]> {
  const { data, error } = await db
    .from('league_members')
    .select('user_id')
    .eq('league_id', league_id);
  if (error) throw new Error(`league_members query failed: ${error.message}`);
  return (data ?? []).map((r) => r.user_id as string);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const poolIdSet = new Set(AI_MEMBER_POOL_IDS);
  assert(AI_MEMBER_POOL_IDS.length === 7, `expected 7 pool ids, got ${AI_MEMBER_POOL_IDS.length}`);
  assert(poolIdSet.size === 7, 'pool ids are not distinct');

  // Object properties (not plain lets) so TS doesn't narrow them to `null` at the
  // use sites below — assignments happen inside runCase closures, which control-flow
  // analysis doesn't track for local variables.
  const state: {
    commissionerA: string | null;
    commissionerB: string | null;
    leagueA: string | null;
    leagueB: string | null;
  } = { commissionerA: null, commissionerB: null, leagueA: null, leagueB: null };

  // Case 1 — two sequential provisions share the same pool
  await runCase(
    'Case 1 — two provisions succeed and share the SAME 7 pool AI member ids',
    async () => {
      state.commissionerA = await createCommissionerUser('a');
      state.commissionerB = await createCommissionerUser('b');

      const resA = await DemoProvisioningService.provision(state.commissionerA);
      state.leagueA = resA.league_id;
      const resB = await DemoProvisioningService.provision(state.commissionerB);
      state.leagueB = resB.league_id;

      for (const [label, league_id, commissioner_id] of [
        ['A', state.leagueA, state.commissionerA],
        ['B', state.leagueB, state.commissionerB],
      ] as const) {
        const memberIds = await getLeagueMemberIds(league_id);
        assert(memberIds.length === 8, `league ${label}: expected 8 members, got ${memberIds.length}`);
        assert(memberIds.includes(commissioner_id), `league ${label}: commissioner missing from members`);
        const aiIds = memberIds.filter((id) => id !== commissioner_id);
        assert(aiIds.length === 7, `league ${label}: expected 7 AI members, got ${aiIds.length}`);
        for (const id of aiIds) {
          assert(poolIdSet.has(id), `league ${label}: AI member ${id} is not a pool id`);
        }
        assert(new Set(aiIds).size === 7, `league ${label}: AI member ids not distinct`);
      }
    }
  );

  // Case 2 — pool survives league cleanup
  await runCase(
    'Case 2 — pool auth users survive delete_orphaned_demo_leagues',
    async () => {
      const { leagueA, leagueB } = state;
      assert(leagueA !== null && leagueB !== null, 'Case 1 did not produce two leagues');

      const { error } = await db.rpc('delete_orphaned_demo_leagues', {
        p_league_ids: [leagueA, leagueB],
      });
      assert(!error, `delete_orphaned_demo_leagues failed: ${error?.message}`);

      // Leagues really gone
      const { data: remaining } = await db
        .from('leagues')
        .select('id')
        .in('id', [leagueA, leagueB]);
      assert((remaining ?? []).length === 0, 'leagues still exist after cleanup RPC');

      // All 7 pool auth users still exist
      for (const id of AI_MEMBER_POOL_IDS) {
        const { data, error: getErr } = await db.auth.admin.getUserById(id);
        assert(
          !getErr && data.user !== null,
          `pool auth user ${id} missing after cleanup: ${getErr?.message ?? 'no user'}`
        );
      }
    }
  );

  // Case 3 — warm path: ensureAiMemberPool is cheap and pool rows are complete
  await runCase(
    'Case 3 — warm ensureAiMemberPool() is fast; exactly 7 public.users pool rows',
    async () => {
      await DemoProvisioningService.ensureAiMemberPool();

      const t0 = Date.now();
      await DemoProvisioningService.ensureAiMemberPool();
      const elapsed = Date.now() - t0;
      // Memoized per process — the second call must not hit the network at all.
      // 50ms is a generous bound for "no round trip happened".
      assert(elapsed < 50, `second ensureAiMemberPool() took ${elapsed}ms — expected memoized (<50ms)`);

      const { data: rows, error } = await db
        .from('users')
        .select('id')
        .in('id', [...AI_MEMBER_POOL_IDS]);
      assert(!error, `public.users query failed: ${error?.message}`);
      assert(
        (rows ?? []).length === 7,
        `expected exactly 7 public.users pool rows, got ${(rows ?? []).length}`
      );
    }
  );

  // ── Cleanup: test commissioners (auth + public.users). Pool users stay — they
  // are permanent infrastructure by design.
  const commissionerIds = [state.commissionerA, state.commissionerB].filter((id): id is string => id !== null);
  for (const id of commissionerIds) {
    await db.auth.admin.deleteUser(id).catch(() => {});
  }
  if (commissionerIds.length > 0) {
    await db.from('users').delete().in('id', commissionerIds);
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  console.log(`\n${passed}/${results.length} cases passed`);
  if (passed !== results.length) process.exit(1);
}

main().catch((err) => {
  console.error('regression-ai-pool: unhandled error', err);
  process.exit(1);
});
