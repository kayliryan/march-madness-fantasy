import '@/lib/utils/wsPolyfill';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  TEST_USER_PASSWORD,
  getUserEmail,
  getAuthCookieHeader,
} from './utils/testHelpers';

// Regression tests for the defense-in-depth authz work:
//
// 1. /api/commissioner/settings, /api/commissioner/draft/order, and
//    /api/draft/session previously relied solely on RLS to reject
//    non-commissioners. They now do an explicit league_members.role check first
//    (matching /api/commissioner/pick/void's existing pattern) — Case 1 proves the
//    settings route rejects a plain member with a clean 403.
// 2. /api/commissioner/bench-order let any authenticated member submit a bench
//    order for an arbitrary `body.user_id`, relying on RLS to reject writes for
//    someone else's bench — Case 2 proves the new explicit check rejects that.
// 3. Migration 20260718000001_bench_orders_co_commissioner_rls.sql extended the
//    bench_orders INSERT/UPDATE RLS policies to also allow co-commissioners (via
//    get_my_commissioner_league_ids()) — Case 3 proves a co_commissioner (a
//    league_members role, not leagues.commissioner_id) can submit a bench order
//    for another member and get a clean 200, not RLS-denied 500.

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

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

async function main(): Promise<void> {
  // Case 1 — non-commissioner member PATCHing /api/commissioner/settings gets 403.
  await runCase(
    'Case 1 — non-commissioner PATCH /api/commissioner/settings is rejected with 403',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const memberEmail = await getUserEmail(league.member_ids[1]);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/settings`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({ league_id: league.league_id, settings: { pick_timer_seconds: 30 } }),
        });
        const body = await res.json();
        assert(res.status === 403, `expected 403 for non-commissioner settings PATCH, got ${res.status}: ${JSON.stringify(body)}`);

        const { data: row, error } = await db
          .from('leagues')
          .select('settings')
          .eq('id', league.league_id)
          .single();
        if (error || !row) throw new Error(`leagues query failed: ${error?.message}`);
        assert(
          (row.settings as { pick_timer_seconds?: number }).pick_timer_seconds !== 30,
          'non-commissioner request should not have changed league settings'
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 2 — member A PATCHing /api/commissioner/bench-order with body.user_id = member B gets 403.
  await runCase(
    'Case 2 — member submitting another member\'s bench order via /api/commissioner/bench-order gets 403',
    async () => {
      const league = await createTestLeague({ memberCount: 3, activationTiming: 'immediate', benchLockMode: 'always_editable' });
      try {
        const memberA = league.member_ids[1];
        const memberB = league.member_ids[2];
        const benchPlayers = league.player_assignments.get(memberB)!.slice(5); // B1, B2, B3
        const newOrder = [...benchPlayers].reverse();

        const memberAEmail = await getUserEmail(memberA);
        const memberACookie = await getAuthCookieHeader(memberAEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: memberACookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: memberB, ordered_player_ids: newOrder }),
        });
        const body = await res.json();
        assert(res.status === 403, `expected 403 for member A submitting member B's bench order, got ${res.status}: ${JSON.stringify(body)}`);

        const { data: row } = await db
          .from('bench_orders')
          .select('id')
          .eq('league_id', league.league_id)
          .eq('user_id', memberB)
          .maybeSingle();
        assert(row === null, 'member A\'s rejected request should not have created a bench_orders row for member B');
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 3 — co-commissioner CAN update another member's bench order (exercises the
  // new bench_orders RLS policy from migration 20260718000001).
  await runCase(
    'Case 3 — co-commissioner can update another member\'s bench order (RLS policy)',
    async () => {
      const league = await createTestLeague({ memberCount: 3, activationTiming: 'immediate', benchLockMode: 'always_editable' });
      try {
        const coCommissioner = league.member_ids[1];
        const target = league.member_ids[2];

        const { error: promoteErr } = await db
          .from('league_members')
          .update({ role: 'co_commissioner' })
          .eq('league_id', league.league_id)
          .eq('user_id', coCommissioner);
        if (promoteErr) throw new Error(`failed to promote member to co_commissioner: ${promoteErr.message}`);

        const benchPlayers = league.player_assignments.get(target)!.slice(5); // B1, B2, B3
        const newOrder = [...benchPlayers].reverse();

        const coCommEmail = await getUserEmail(coCommissioner);
        const coCommCookie = await getAuthCookieHeader(coCommEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: coCommCookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: target, ordered_player_ids: newOrder }),
        });
        const body = await res.json();
        assert(res.ok, `expected 200 for co-commissioner bench-order update, got ${res.status}: ${JSON.stringify(body)}`);
        assert(
          JSON.stringify(body.bench_order?.ordered_player_ids) === JSON.stringify(newOrder),
          `expected ordered_player_ids ${JSON.stringify(newOrder)}, got ${JSON.stringify(body.bench_order?.ordered_player_ids)}`
        );

        const { data: row, error } = await db
          .from('bench_orders')
          .select('ordered_player_ids, last_edited_by')
          .eq('league_id', league.league_id)
          .eq('user_id', target)
          .single();
        if (error || !row) throw new Error(`bench_orders query failed: ${error?.message}`);
        assert(JSON.stringify(row.ordered_player_ids) === JSON.stringify(newOrder), 'bench_orders row in DB does not match new order');
        assert(row.last_edited_by === coCommissioner, 'expected last_edited_by to be the co-commissioner');
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('security-authz-regression: unhandled error:', err);
  process.exit(1);
});
