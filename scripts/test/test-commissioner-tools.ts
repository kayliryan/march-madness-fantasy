import '@/lib/utils/wsPolyfill';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  assertRosterSlot,
  setSubmittedBenchOrder,
  triggerSync,
  TEST_USER_PASSWORD,
  getUserEmail,
  getAuthCookieHeader,
} from './utils/testHelpers';
import { simulateRound } from './simulate-round';

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

// ── Helpers ───────────────────────────────────────────────────────────────

interface SnapshotRow {
  total_points: number;
  last_computed_at: string;
  round_stage: string;
}

async function getSnapshots(league_id: string, user_ids: string[]): Promise<Map<string, SnapshotRow>> {
  const { data, error } = await db
    .from('leaderboard_snapshots')
    .select('user_id, total_points, last_computed_at, round_stage')
    .eq('league_id', league_id)
    .in('user_id', user_ids);
  if (error) throw new Error(`getSnapshots failed: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.user_id, { total_points: r.total_points, last_computed_at: r.last_computed_at, round_stage: r.round_stage }]));
}

/** Polls leaderboard_snapshots until last_computed_at advances past `baselines` for every user. */
async function waitForSnapshotsAfter(
  league_id: string,
  baselines: Map<string, string>,
  timeoutMs = 8000
): Promise<Map<string, SnapshotRow>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snaps = await getSnapshots(league_id, [...baselines.keys()]);
    const allAdvanced = snaps.size === baselines.size && [...baselines].every(([user_id, baseline]) => {
      const row = snaps.get(user_id);
      return row !== undefined && new Date(row.last_computed_at).getTime() > new Date(baseline).getTime();
    });
    if (allAdvanced) return snaps;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForSnapshotsAfter: timed out waiting for leaderboard_snapshots.last_computed_at to advance for league ${league_id}`);
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case 1 — PATCH /api/commissioner/bench-order: commissioner updates another member's bench order
  await runCase(
    'Case 1 — commissioner can update another member\'s bench order',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', benchLockMode: 'always_editable' });
      try {
        const target = league.member_ids[1];
        const benchPlayers = league.player_assignments.get(target)!.slice(5); // B1, B2, B3
        const newOrder = [...benchPlayers].reverse();

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const commissionerCookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: commissionerCookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: target, ordered_player_ids: newOrder }),
        });
        const body = await res.json();
        assert(res.ok, `PATCH /api/commissioner/bench-order returned ${res.status}: ${JSON.stringify(body)}`);
        assert(
          JSON.stringify(body.bench_order.ordered_player_ids) === JSON.stringify(newOrder),
          `expected ordered_player_ids ${JSON.stringify(newOrder)}, got ${JSON.stringify(body.bench_order.ordered_player_ids)}`
        );
        assert(body.bench_order.last_edited_by === league.commissioner_id, 'expected last_edited_by to be the commissioner');

        const { data: row, error } = await db
          .from('bench_orders')
          .select('ordered_player_ids, submitted_at')
          .eq('league_id', league.league_id)
          .eq('user_id', target)
          .single();
        if (error || !row) throw new Error(`bench_orders query failed: ${error?.message}`);
        assert(JSON.stringify(row.ordered_player_ids) === JSON.stringify(newOrder), 'bench_orders row in DB does not match new order');
        assert(row.submitted_at !== null, 'expected submitted_at to be set');
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 2 — PATCH /api/commissioner/bench-order: a locked bench order blocks the member,
  // but the commissioner can still override it
  await runCase(
    'Case 2 — locked bench order blocks the member but the commissioner can override',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' }); // default benchLockMode='before_first_game'
      try {
        const target = league.member_ids[1];
        const initialOrder = league.player_assignments.get(target)!.slice(5); // B1, B2, B3

        await setSubmittedBenchOrder({ league_id: league.league_id, user_id: target, ordered_player_ids: initialOrder });

        // bench_lock_deadline was set 5 minutes in the past by createTestLeague — triggerSync()
        // locks any bench_orders row with locked_at still null for this league (and, globally,
        // for any other league in the same state).
        await triggerSync();

        const { data: lockedRow, error: lockedErr } = await db
          .from('bench_orders')
          .select('locked_at')
          .eq('league_id', league.league_id)
          .eq('user_id', target)
          .single();
        if (lockedErr || !lockedRow) throw new Error(`bench_orders query failed: ${lockedErr?.message}`);
        assert(lockedRow.locked_at !== null, 'expected triggerSync() to set bench_orders.locked_at');

        const newOrder = [...initialOrder].reverse();

        // Member attempts to change their own (now-locked) bench order -> 422
        const memberEmail = await getUserEmail(target);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);
        const memberRes = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: target, ordered_player_ids: newOrder }),
        });
        const memberBody = await memberRes.json();
        assert(memberRes.status === 422, `expected 422 for locked bench order, got ${memberRes.status}: ${JSON.stringify(memberBody)}`);
        assert(memberBody.error === 'BENCH_ORDER_LOCKED', `expected error BENCH_ORDER_LOCKED, got ${JSON.stringify(memberBody)}`);

        // Commissioner overrides the locked bench order -> 200
        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const commissionerCookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);
        const commRes = await fetch(`${APP_URL}/api/commissioner/bench-order`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: commissionerCookie },
          body: JSON.stringify({ league_id: league.league_id, user_id: target, ordered_player_ids: newOrder }),
        });
        const commBody = await commRes.json();
        assert(commRes.ok, `commissioner override returned ${commRes.status}: ${JSON.stringify(commBody)}`);
        assert(
          JSON.stringify(commBody.bench_order.ordered_player_ids) === JSON.stringify(newOrder),
          'commissioner override did not persist the new order'
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 3 — PATCH /api/commissioner/player/position: commissioner override persists;
  // non-commissioner is forbidden
  await runCase(
    'Case 3 — commissioner can override a player position; non-commissioner is forbidden',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      const playerId = league.player_assignments.get(league.commissioner_id)![0]; // G1

      const { data: original, error: origErr } = await db
        .from('players')
        .select('position, position_overridden, position_override_note')
        .eq('id', playerId)
        .single();
      if (origErr || !original) throw new Error(`players query failed: ${origErr?.message}`);

      try {
        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const commissionerCookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/player/position`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: commissionerCookie },
          body: JSON.stringify({
            player_id: playerId,
            league_id: league.league_id,
            position: 'F',
            override_note: 'Test override — guard misclassified',
          }),
        });
        const body = await res.json();
        assert(res.ok, `commissioner PATCH /api/commissioner/player/position returned ${res.status}: ${JSON.stringify(body)}`);
        assert(body.player.position === 'F', `expected position 'F', got ${body.player.position}`);
        assert(body.player.position_overridden === true, 'expected position_overridden=true');
        assert(
          body.player.position_override_note === 'Test override — guard misclassified',
          'expected override_note to be persisted'
        );

        const memberId = league.member_ids[1];
        const memberEmail = await getUserEmail(memberId);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);

        const memberRes = await fetch(`${APP_URL}/api/commissioner/player/position`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({
            player_id: playerId,
            league_id: league.league_id,
            position: 'C',
            override_note: 'Member attempt',
          }),
        });
        assert(memberRes.status === 403, `expected 403 for non-commissioner position override, got ${memberRes.status}`);
      } finally {
        await db
          .from('players')
          .update({
            position: original.position,
            position_overridden: original.position_overridden,
            position_override_note: original.position_override_note,
          })
          .eq('id', playerId);
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 4 — POST /api/commissioner/draft/order: commissioner sets an explicit snake_order;
  // non-commissioner is blocked by RLS
  await runCase(
    'Case 4 — commissioner can set explicit snake_order; non-commissioner is blocked (RLS)',
    async () => {
      const league = await createTestLeague({ memberCount: 3, activationTiming: 'immediate' });
      try {
        const reversed = [...league.member_ids].reverse();

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const commissionerCookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/draft/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: commissionerCookie },
          body: JSON.stringify({ league_id: league.league_id, order: reversed }),
        });
        const body = await res.json();
        assert(res.ok, `commissioner POST /api/commissioner/draft/order returned ${res.status}: ${JSON.stringify(body)}`);
        assert(
          JSON.stringify(body.draft_session.snake_order) === JSON.stringify(reversed),
          `expected snake_order ${JSON.stringify(reversed)}, got ${JSON.stringify(body.draft_session.snake_order)}`
        );

        const { data: row, error } = await db
          .from('draft_sessions')
          .select('snake_order')
          .eq('league_id', league.league_id)
          .single();
        if (error || !row) throw new Error(`draft_sessions query failed: ${error?.message}`);
        assert(JSON.stringify(row.snake_order) === JSON.stringify(reversed), 'draft_sessions.snake_order was not persisted');

        // Non-commissioner attempts to change it back -> blocked (RLS), DB value unchanged
        const memberEmail = await getUserEmail(league.member_ids[1]);
        const memberCookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);
        const memberRes = await fetch(`${APP_URL}/api/commissioner/draft/order`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: memberCookie },
          body: JSON.stringify({ league_id: league.league_id, order: league.member_ids }),
        });
        assert(!memberRes.ok, `expected non-commissioner draft/order POST to fail, got ${memberRes.status}`);

        const { data: rowAfter, error: errAfter } = await db
          .from('draft_sessions')
          .select('snake_order')
          .eq('league_id', league.league_id)
          .single();
        if (errAfter || !rowAfter) throw new Error(`draft_sessions query failed: ${errAfter?.message}`);
        assert(
          JSON.stringify(rowAfter.snake_order) === JSON.stringify(reversed),
          'non-commissioner request should not have changed snake_order'
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 5 — PATCH /api/commissioner/pick/void: void + replace updates roster_slots and
  // draft_picks correctly, and triggers a full ScoreAccumulator recompute
  await runCase(
    'Case 5 — commissioner can void a pick and replace it with a new player',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

        const snapsBefore = await getSnapshots(league.league_id, [league.commissioner_id]);
        assert(snapsBefore.size === 1, `expected a leaderboard_snapshots row for the commissioner after r64, got ${snapsBefore.size}`);
        const baselines = new Map([...snapsBefore].map(([uid, row]) => [uid, row.last_computed_at]));

        const originalPlayerId = league.player_assignments.get(league.commissioner_id)![0]; // G1
        const { data: pick, error: pickErr } = await db
          .from('draft_picks')
          .select('id, pick_number')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', originalPlayerId)
          .is('voided_at', null)
          .single();
        if (pickErr || !pick) throw new Error(`draft_picks query failed: ${pickErr?.message}`);

        const allDrafted = new Set([...league.player_assignments.values()].flat());
        const { data: candidates, error: candErr } = await db
          .from('players')
          .select('id')
          .eq('season', 2026)
          .eq('position', 'G')
          .limit(50);
        if (candErr) throw new Error(`players query failed: ${candErr.message}`);
        const replacementPlayerId = (candidates ?? []).map((p) => p.id as string).find((id) => !allDrafted.has(id));
        assert(replacementPlayerId, 'could not find an undrafted G player for replacement');

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/pick/void`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({
            pick_id: pick.id,
            void_reason: 'Test correction — misdraft',
            replacement_player_id: replacementPlayerId,
          }),
        });
        const body = await res.json();
        assert(res.ok, `PATCH /api/commissioner/pick/void returned ${res.status}: ${JSON.stringify(body)}`);
        assert(body.voided_pick.voided_at !== null, 'expected voided_pick.voided_at to be set');
        assert(body.voided_pick.voided_by === league.commissioner_id, 'expected voided_pick.voided_by to be the commissioner');
        assert(body.voided_pick.void_reason === 'Test correction — misdraft', 'expected void_reason to be persisted');
        assert(body.correction_pick.replaces_pick_id === pick.id, 'expected correction_pick.replaces_pick_id to reference the voided pick');
        assert(body.correction_pick.player_id === replacementPlayerId, 'expected correction_pick.player_id to be the replacement');
        assert(body.correction_pick.pick_number === pick.pick_number, 'expected correction_pick.pick_number to match the voided pick');
        assert(body.correction_pick.user_id === league.commissioner_id, 'expected correction_pick.user_id to be unchanged');

        await assertRosterSlot({
          league_id: league.league_id,
          user_id: league.commissioner_id,
          player_id: originalPlayerId,
          expected_is_active: false,
          expected_acquired_at_round_stage: 'draft',
          expected_released_at_round_stage: 'draft',
        });
        await assertRosterSlot({
          league_id: league.league_id,
          user_id: league.commissioner_id,
          player_id: replacementPlayerId,
          expected_is_active: true,
          expected_acquired_at_round_stage: 'draft',
          expected_released_at_round_stage: null,
        });

        const { data: oldSlot, error: oldSlotErr } = await db
          .from('roster_slots')
          .select('release_reason, override_by, override_reason')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', originalPlayerId)
          .single();
        if (oldSlotErr || !oldSlot) throw new Error(`roster_slots query failed: ${oldSlotErr?.message}`);
        assert(oldSlot.release_reason === 'correction', `expected release_reason='correction', got ${oldSlot.release_reason}`);
        assert(oldSlot.override_by === league.commissioner_id, 'expected override_by to be the commissioner');
        assert(oldSlot.override_reason === 'Test correction — misdraft', 'expected override_reason to be persisted');

        const { data: newSlot, error: newSlotErr } = await db
          .from('roster_slots')
          .select('slot_key, is_bench')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', replacementPlayerId)
          .single();
        if (newSlotErr || !newSlot) throw new Error(`roster_slots query failed: ${newSlotErr?.message}`);
        assert(newSlot.slot_key === 'G1', `expected replacement slot_key='G1', got ${newSlot.slot_key}`);
        assert(newSlot.is_bench === false, 'expected replacement slot is_bench=false');

        // ScoreAccumulator.runForLeague is fire-and-forget — confirm it completed
        await waitForSnapshotsAfter(league.league_id, baselines);
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 6 — PATCH /api/commissioner/pick/void error cases: already-drafted replacement
  // and voiding an already-voided pick
  await runCase(
    'Case 6 — pick/void rejects an already-drafted replacement and an already-voided pick',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        // 6a — replacement player is already drafted in this league -> 409
        const target = league.member_ids[1];
        const g1PlayerId = league.player_assignments.get(target)![0]; // G1 — already drafted by `target`
        const g2PlayerId = league.player_assignments.get(target)![1]; // G2

        const { data: g2Pick, error: g2Err } = await db
          .from('draft_picks')
          .select('id')
          .eq('league_id', league.league_id)
          .eq('user_id', target)
          .eq('player_id', g2PlayerId)
          .is('voided_at', null)
          .single();
        if (g2Err || !g2Pick) throw new Error(`draft_picks query failed: ${g2Err?.message}`);

        const dupRes = await fetch(`${APP_URL}/api/commissioner/pick/void`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ pick_id: g2Pick.id, void_reason: 'Test duplicate replacement', replacement_player_id: g1PlayerId }),
        });
        const dupBody = await dupRes.json();
        assert(dupRes.status === 409, `expected 409 for already-drafted replacement, got ${dupRes.status}: ${JSON.stringify(dupBody)}`);
        assert(dupBody.error === 'Replacement player is already drafted', `unexpected error message: ${JSON.stringify(dupBody)}`);

        // 6b — voiding an already-voided pick -> 409
        const originalPlayerId = league.player_assignments.get(league.commissioner_id)![0]; // G1
        const { data: pick, error: pickErr } = await db
          .from('draft_picks')
          .select('id')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', originalPlayerId)
          .is('voided_at', null)
          .single();
        if (pickErr || !pick) throw new Error(`draft_picks query failed: ${pickErr?.message}`);

        const allDrafted = new Set([...league.player_assignments.values()].flat());
        const { data: candidates, error: candErr } = await db
          .from('players')
          .select('id')
          .eq('season', 2026)
          .eq('position', 'G')
          .limit(50);
        if (candErr) throw new Error(`players query failed: ${candErr.message}`);
        const undrafted = (candidates ?? []).map((p) => p.id as string).filter((id) => !allDrafted.has(id));
        assert(undrafted.length >= 2, 'need at least 2 undrafted G players for this case');
        const [replacement1, replacement2] = undrafted;

        const firstVoid = await fetch(`${APP_URL}/api/commissioner/pick/void`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ pick_id: pick.id, void_reason: 'First void', replacement_player_id: replacement1 }),
        });
        assert(firstVoid.ok, `first void returned ${firstVoid.status}`);

        const secondVoid = await fetch(`${APP_URL}/api/commissioner/pick/void`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ pick_id: pick.id, void_reason: 'Second void attempt', replacement_player_id: replacement2 }),
        });
        const secondBody = await secondVoid.json();
        assert(secondVoid.status === 409, `expected 409 for already-voided pick, got ${secondVoid.status}: ${JSON.stringify(secondBody)}`);
        assert(secondBody.error === 'Pick is already voided', `unexpected error message: ${JSON.stringify(secondBody)}`);
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
  console.error('test-commissioner-tools: unhandled error:', err);
  process.exit(1);
});
