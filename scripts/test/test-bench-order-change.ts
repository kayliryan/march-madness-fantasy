import '@/lib/utils/wsPolyfill';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  triggerSync,
  setSubmittedBenchOrder,
  TEST_USER_PASSWORD,
  getUserEmail,
  getAuthCookieHeader,
} from './utils/testHelpers';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ── Test runner ────────────────────────────────────────────────────────────

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string; note?: string }[] = [];

async function runCase(name: string, fn: () => Promise<void>, note?: string): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS', note });
    console.log(`PASS  ${name}`);
    if (note) console.log(`      note: ${note}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message, note });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
    if (note) console.log(`      note: ${note}`);
  }
}

async function patchBenchOrder(
  cookie: string,
  league_id: string,
  user_id: string,
  ordered_player_ids: string[]
): Promise<{ status: number; body: { bench_order?: { id: string; ordered_player_ids: string[]; submitted_at: string; locked_at: string | null; last_edited_by: string }; error?: string; message?: string } }> {
  const res = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ league_id, user_id, ordered_player_ids }),
  });
  const body = await res.json();
  return { status: res.status, body };
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case 1 — PATCH inserts then updates a bench order (happy path)
  await runCase(
    'Case 1 — PATCH /api/commissioner/bench-order inserts then updates a bench order',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', benchLockMode: 'always_editable' });
      try {
        const [b1, b2, b3] = league.player_assignments.get(league.commissioner_id)!.slice(5, 8);

        const email = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

        // Insert
        const insertRes = await patchBenchOrder(cookie, league.league_id, league.commissioner_id, [b1, b2, b3]);
        assert(insertRes.status === 200, `expected 200 on insert, got ${insertRes.status}: ${JSON.stringify(insertRes.body)}`);
        const inserted = insertRes.body.bench_order;
        assert(!!inserted, `expected bench_order in response, got ${JSON.stringify(insertRes.body)}`);
        assert(JSON.stringify(inserted!.ordered_player_ids) === JSON.stringify([b1, b2, b3]), `expected ordered_player_ids=[b1,b2,b3], got ${JSON.stringify(inserted!.ordered_player_ids)}`);
        assert(inserted!.submitted_at !== null && inserted!.submitted_at !== undefined, 'expected submitted_at to be set on insert');
        assert(inserted!.locked_at === null, `expected locked_at=null on insert, got ${inserted!.locked_at}`);
        assert(inserted!.last_edited_by === league.commissioner_id, `expected last_edited_by=${league.commissioner_id}, got ${inserted!.last_edited_by}`);

        // Update (reorder) — same row, new order
        const updateRes = await patchBenchOrder(cookie, league.league_id, league.commissioner_id, [b3, b1, b2]);
        assert(updateRes.status === 200, `expected 200 on update, got ${updateRes.status}: ${JSON.stringify(updateRes.body)}`);
        const updated = updateRes.body.bench_order;
        assert(!!updated, `expected bench_order in response, got ${JSON.stringify(updateRes.body)}`);
        assert(updated!.id === inserted!.id, `expected update to reuse the same bench_orders row (id=${inserted!.id}), got ${updated!.id}`);
        assert(JSON.stringify(updated!.ordered_player_ids) === JSON.stringify([b3, b1, b2]), `expected ordered_player_ids=[b3,b1,b2] after reorder, got ${JSON.stringify(updated!.ordered_player_ids)}`);

        // Single row in DB (no duplicate insert)
        const { count, error } = await db
          .from('bench_orders')
          .select('*', { count: 'exact', head: true })
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id);
        if (error) throw new Error(`bench_orders count query failed: ${error.message}`);
        assert(count === 1, `expected exactly 1 bench_orders row, got ${count}`);
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 2 — BenchOrderService.resolveNext honors a submitted bench order over the avg_ppg fallback
  await runCase(
    "Case 2 — BenchOrderService.resolveNext honors a submitted bench order over the avg_ppg fallback",
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true, benchLockMode: 'always_editable' });
      try {
        const target = league.member_ids[1];
        const assignments = league.player_assignments.get(target)!;
        const injuredPlayerId = assignments[0]; // G1
        const b1 = assignments[5]; // B1 (G) — eligible for G1 (sub_eligibility_matrix.G=['G','F'])
        const b2 = assignments[6]; // B2 (F) — eligible for G1
        const b3 = assignments[7]; // B3 (C) — not eligible for G1

        const { data: benchPlayers, error } = await db.from('players').select('id, avg_ppg').in('id', [b1, b2]);
        if (error || !benchPlayers) throw new Error(`players query failed: ${error?.message}`);
        const ppg = new Map(benchPlayers.map((p) => [p.id as string, p.avg_ppg as number]));

        // Put the LOWER-avg_ppg eligible player first — the avg_ppg fallback would pick the
        // HIGHER one, so resolveNext can only return this player if it honors the submitted order.
        const preferredSubId = ppg.get(b1)! <= ppg.get(b2)! ? b1 : b2;
        const otherEligibleId = preferredSubId === b1 ? b2 : b1;

        await setSubmittedBenchOrder({
          league_id: league.league_id,
          user_id: target,
          ordered_player_ids: [preferredSubId, otherEligibleId, b3],
        });

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId }),
        });
        const body = await res.json();
        assert(res.ok, `POST /api/commissioner/injury-sub returned ${res.status}: ${JSON.stringify(body)}`);
        assert(
          body.sub_player_id === preferredSubId,
          `expected resolveNext to honor the submitted bench order and pick ${preferredSubId} ` +
          `(avg_ppg=${ppg.get(preferredSubId)}), got ${body.sub_player_id} ` +
          `(avg_ppg fallback would have picked ${otherEligibleId}, avg_ppg=${ppg.get(otherEligibleId)})`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 3 — lock enforcement on an existing bench_orders row: blocks non-commissioner, allows commissioner override
  await runCase(
    'Case 3 — locked bench order blocks non-commissioner edits but allows commissioner override',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', benchLockMode: 'before_first_game' });
      try {
        const member = league.member_ids[1];
        const [b1, b2, b3] = league.player_assignments.get(member)!.slice(5, 8);

        const memberEmail = await getUserEmail(member);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);

        // bench_lock_deadline was set 5 minutes in the past by createTestLeague — the lock
        // check is based directly on draft_sessions.bench_lock_deadline (post-fix), so even a
        // first-ever submission (no bench_orders row exists yet) is blocked.
        const firstAttempt = await patchBenchOrder(memberCookie, league.league_id, member, [b1, b2, b3]);
        assert(firstAttempt.status === 422, `expected 422 for locked first-ever submission, got ${firstAttempt.status}: ${JSON.stringify(firstAttempt.body)}`);
        assert(firstAttempt.body.error === 'BENCH_ORDER_LOCKED', `expected error='BENCH_ORDER_LOCKED', got ${JSON.stringify(firstAttempt.body)}`);
        assert(firstAttempt.body.message === 'Bench order is locked for this league.', `unexpected message: ${JSON.stringify(firstAttempt.body)}`);

        // Commissioner override still succeeds despite the lock, creating the row
        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const commissionerCookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);
        const overrideRes = await patchBenchOrder(commissionerCookie, league.league_id, member, [b1, b2, b3]);
        assert(overrideRes.status === 200, `expected 200 for commissioner override of a locked bench order, got ${overrideRes.status}: ${JSON.stringify(overrideRes.body)}`);
        assert(JSON.stringify(overrideRes.body.bench_order?.ordered_player_ids) === JSON.stringify([b1, b2, b3]), `expected commissioner override to create the row with the given order, got ${JSON.stringify(overrideRes.body.bench_order?.ordered_player_ids)}`);

        // The lock persists for the now-existing row too — member still can't edit it
        const secondAttempt = await patchBenchOrder(memberCookie, league.league_id, member, [b3, b2, b1]);
        assert(secondAttempt.status === 422, `expected 422 for locked edit of an existing row, got ${secondAttempt.status}: ${JSON.stringify(secondAttempt.body)}`);
        assert(secondAttempt.body.error === 'BENCH_ORDER_LOCKED', `expected error='BENCH_ORDER_LOCKED', got ${JSON.stringify(secondAttempt.body)}`);
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 4 — validation: missing required fields returns 400
  await runCase(
    'Case 4 — missing required fields returns 400',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', benchLockMode: 'always_editable' });
      try {
        const email = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: league.commissioner_id }), // missing ordered_player_ids
        });
        const body = await res.json();
        assert(res.status === 400, `expected 400 for missing ordered_player_ids, got ${res.status}: ${JSON.stringify(body)}`);
        assert(
          body.error === 'Missing required fields: league_id, user_id, ordered_player_ids',
          `unexpected error message: ${JSON.stringify(body)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 5 — regression guard for Bug #5: first-time bench order submission after
  // bench_lock_deadline is correctly blocked (fixed: lock check now reads
  // draft_sessions.bench_lock_deadline directly instead of bench_orders.locked_at).
  await runCase(
    'Case 5 — first-time bench order submission after bench_lock_deadline is blocked',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', benchLockMode: 'before_first_game' });
      try {
        const member = league.member_ids[1];
        const [b1, b2, b3] = league.player_assignments.get(member)!.slice(5, 8);

        // bench_lock_deadline was set 5 minutes in the past by createTestLeague. `member` has
        // never submitted a bench order, so no bench_orders row exists yet for them.
        await triggerSync();

        const { data: existingRow } = await db
          .from('bench_orders')
          .select('id')
          .eq('league_id', league.league_id)
          .eq('user_id', member)
          .maybeSingle();
        assert(existingRow === null, `expected no pre-existing bench_orders row for ${member}, got ${JSON.stringify(existingRow)}`);

        const memberEmail = await getUserEmail(member);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);

        const res = await patchBenchOrder(memberCookie, league.league_id, member, [b1, b2, b3]);

        assert(res.status === 422, `expected 422 BENCH_ORDER_LOCKED for a first-ever bench order submission after bench_lock_deadline has passed, got ${res.status}: ${JSON.stringify(res.body)}`);
        assert(res.body.error === 'BENCH_ORDER_LOCKED', `expected error='BENCH_ORDER_LOCKED', got ${JSON.stringify(res.body)}`);
        assert(res.body.message === 'Bench order is locked for this league.', `unexpected message: ${JSON.stringify(res.body)}`);
      } finally {
        await cleanupTestLeague(league.league_id);
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
  console.error('test-bench-order-change: unhandled error:', err);
  process.exit(1);
});
