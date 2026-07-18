import '@/lib/utils/wsPolyfill';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { LeagueSettings } from '@/lib/types';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  triggerSync,
  TEST_USER_PASSWORD,
  getUserEmail,
  getAuthCookieHeader,
  getTeamIdsForPlayers,
  withTeamsRestored,
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

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case 1 — explicit sub_player_id: injured starter released, specified bench player promoted
  await runCase(
    'Case 1 — explicit sub_player_id: injured starter released, specified bench player promoted',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true });
      try {
        const injuredPlayerId = league.player_assignments.get(league.commissioner_id)![0]; // G1
        const subPlayerId = league.player_assignments.get(league.commissioner_id)![5]; // B1 (G) — eligible (sub_eligibility_matrix.G=['G','F'])

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        // The shared season-2026 `teams` table has most teams marked eliminated by now
        // (real tournament progress + prior test runs) — un-eliminate just this test's
        // two players' teams for the duration of the sub call, then restore exactly.
        const teamIds = await getTeamIdsForPlayers([injuredPlayerId, subPlayerId]);
        const { res, body } = await withTeamsRestored(teamIds, async () => {
          const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId, sub_player_id: subPlayerId }),
          });
          return { res, body: await res.json() };
        });
        assert(res.ok, `POST /api/commissioner/injury-sub returned ${res.status}: ${JSON.stringify(body)}`);
        assert(body.sub_player_id === subPlayerId, `expected sub_player_id ${subPlayerId}, got ${body.sub_player_id}`);

        // Injured player's starter slot: released. current_round_stage is derived by the
        // route from this league's active players' most-recently-synced game_scores row
        // (falling back to 'r64' if none) — game_scores is a shared, season-scoped fixture
        // that other test scripts also write to, so don't assume a specific stage here;
        // just capture whatever the route picked and assert it's a real round stage.
        const { data: injuredSlot, error: injErr } = await db
          .from('roster_slots')
          .select('is_active, acquired_at_round_stage, released_at_round_stage, release_reason')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', injuredPlayerId)
          .single();
        if (injErr || !injuredSlot) throw new Error(`roster_slots query failed: ${injErr?.message}`);
        assert(injuredSlot.is_active === false, 'expected injured starter slot is_active=false');
        assert(injuredSlot.acquired_at_round_stage === 'draft', `expected injured slot acquired_at_round_stage unchanged ('draft'), got ${injuredSlot.acquired_at_round_stage}`);
        assert(injuredSlot.release_reason === 'injury_sub', `expected release_reason='injury_sub', got ${injuredSlot.release_reason}`);
        const currentRoundStage = injuredSlot.released_at_round_stage;
        assert(
          typeof currentRoundStage === 'string' && ROUND_STAGE_ORDER.includes(currentRoundStage as (typeof ROUND_STAGE_ORDER)[number]),
          `expected injured slot released_at_round_stage to be a valid round stage, got ${currentRoundStage}`
        );

        // Sub player now has two roster_slots rows: the released old bench slot (B1) and the
        // new active starter slot (inherits G1) — query each explicitly.
        const { data: subReleasedSlot, error: subRelErr } = await db
          .from('roster_slots')
          .select('slot_key, release_reason, released_at_round_stage')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', subPlayerId)
          .eq('is_active', false)
          .single();
        if (subRelErr || !subReleasedSlot) throw new Error(`roster_slots query failed: ${subRelErr?.message}`);
        assert(subReleasedSlot.slot_key === 'B1', `expected released sub slot_key='B1', got ${subReleasedSlot.slot_key}`);
        assert(subReleasedSlot.release_reason === 'injury_sub', `expected sub's old bench slot release_reason='injury_sub', got ${subReleasedSlot.release_reason}`);
        assert(subReleasedSlot.released_at_round_stage === currentRoundStage, `expected sub's old bench slot released_at_round_stage='${currentRoundStage}', got ${subReleasedSlot.released_at_round_stage}`);

        const { data: subActiveSlot, error: subActErr } = await db
          .from('roster_slots')
          .select('slot_key, slot_position, is_bench, acquired_at_round_stage, released_at_round_stage')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', subPlayerId)
          .eq('is_active', true)
          .single();
        if (subActErr || !subActiveSlot) throw new Error(`roster_slots query failed: ${subActErr?.message}`);
        assert(subActiveSlot.slot_key === 'G1', `expected promoted slot_key='G1', got ${subActiveSlot.slot_key}`);
        assert(subActiveSlot.is_bench === false, 'expected promoted slot is_bench=false');
        assert(subActiveSlot.acquired_at_round_stage === currentRoundStage, `expected promoted slot acquired_at_round_stage='${currentRoundStage}', got ${subActiveSlot.acquired_at_round_stage}`);
        assert(subActiveSlot.released_at_round_stage === null, 'expected promoted slot released_at_round_stage=null');
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 2 — auto-resolve via BenchOrderService promotes the only eligible bench player
  await runCase(
    'Case 2 — auto-resolve via BenchOrderService promotes the only C-eligible bench player',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true });
      try {
        const target = league.member_ids[1];
        const injuredPlayerId = league.player_assignments.get(target)![4]; // C1
        const expectedSubId = league.player_assignments.get(target)![7]; // B3 (C) — sub_eligibility_matrix.C=['C'] only

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        // BenchOrderService.resolveNext excludes bench candidates on an eliminated team —
        // un-eliminate this target user's whole roster's teams for the sub call only.
        const teamIds = await getTeamIdsForPlayers(league.player_assignments.get(target)!);
        const { res, body } = await withTeamsRestored(teamIds, async () => {
          const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Cookie: cookie },
            body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId }),
          });
          return { res, body: await res.json() };
        });
        assert(res.ok, `POST /api/commissioner/injury-sub returned ${res.status}: ${JSON.stringify(body)}`);
        assert(
          body.sub_player_id === expectedSubId,
          `expected auto-resolved sub_player_id ${expectedSubId} (only C-eligible bench player), got ${body.sub_player_id}`
        );

        const { data: newSlot, error } = await db
          .from('roster_slots')
          .select('slot_key, slot_position, is_bench')
          .eq('league_id', league.league_id)
          .eq('user_id', target)
          .eq('player_id', expectedSubId)
          .eq('is_active', true)
          .single();
        if (error || !newSlot) throw new Error(`roster_slots query failed: ${error?.message}`);
        assert(newSlot.slot_key === 'C1', `expected promoted slot_key='C1', got ${newSlot.slot_key}`);
        assert(newSlot.slot_position === 'C', `expected slot_position='C', got ${newSlot.slot_position}`);
        assert(newSlot.is_bench === false, 'expected promoted slot is_bench=false');
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 3 — injury_sub_enabled=false returns 400
  await runCase(
    'Case 3 — injury_sub_enabled=false returns 400',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' }); // injurySubEnabled defaults to false
      try {
        const injuredPlayerId = league.player_assignments.get(league.commissioner_id)![0];

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId }),
        });
        const body = await res.json();
        assert(res.status === 400, `expected 400 when injury_sub_enabled=false, got ${res.status}: ${JSON.stringify(body)}`);
        assert(
          body.error === 'Injury substitutions are not enabled for this league',
          `unexpected error message: ${JSON.stringify(body)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 4 — non-commissioner is forbidden
  await runCase(
    'Case 4 — non-commissioner is forbidden',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true });
      try {
        const injuredPlayerId = league.player_assignments.get(league.commissioner_id)![0];

        const memberEmail = await getUserEmail(league.member_ids[1]);
        const cookie = await getAuthCookieHeader(memberEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId }),
        });
        const body = await res.json();
        assert(res.status === 403, `expected 403 for non-commissioner, got ${res.status}: ${JSON.stringify(body)}`);
        assert(body.error === 'Commissioner access required', `unexpected error message: ${JSON.stringify(body)}`);
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 5 — explicit sub_player_id not on the injured user's bench returns 422
  await runCase(
    "Case 5 — explicit sub_player_id not on the injured user's bench returns 422",
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true });
      try {
        const injuredPlayerId = league.player_assignments.get(league.commissioner_id)![0]; // commissioner's G1
        const notOnBenchId = league.player_assignments.get(league.member_ids[1])![5]; // other member's bench player

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId, sub_player_id: notOnBenchId }),
        });
        const body = await res.json();
        assert(res.status === 422, `expected 422, got ${res.status}: ${JSON.stringify(body)}`);
        assert(
          body.error === "Sub player is not on this user's active bench",
          `unexpected error message: ${JSON.stringify(body)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case 6 — KNOWN FAILING (Bug #6): injury_sub_reversible is dead code — no reversal mechanism exists
  await runCase(
    'Case 6 — injury_sub_reversible has no effect: player does not return after recovery',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate', injurySubEnabled: true });
      try {
        const { data: leagueRow, error: leagueErr } = await db
          .from('leagues')
          .select('settings')
          .eq('id', league.league_id)
          .single();
        if (leagueErr || !leagueRow) throw new Error(`leagues query failed: ${leagueErr?.message}`);
        const settings = leagueRow.settings as LeagueSettings;
        await db
          .from('leagues')
          .update({ settings: { ...settings, injury_sub_reversible: true } })
          .eq('id', league.league_id);

        const injuredPlayerId = league.player_assignments.get(league.commissioner_id)![0]; // G1
        const subPlayerId = league.player_assignments.get(league.commissioner_id)![5]; // B1 (G)

        await db.from('players').update({ injury_status: 'out', injury_note: 'Sprained ankle' }).eq('id', injuredPlayerId);

        const commissionerEmail = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(commissionerEmail, TEST_USER_PASSWORD);

        const res = await fetch(`${APP_URL}/api/commissioner/injury-sub`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Cookie: cookie },
          body: JSON.stringify({ league_id: league.league_id, injured_player_id: injuredPlayerId, sub_player_id: subPlayerId }),
        });
        const body = await res.json();
        assert(res.ok, `POST /api/commissioner/injury-sub returned ${res.status}: ${JSON.stringify(body)}`);

        // Player recovers
        await db.from('players').update({ injury_status: 'active', injury_note: null }).eq('id', injuredPlayerId);

        // The only system "tick" available to react to a status change
        await triggerSync();

        // Let the injury-sub route's fire-and-forget ScoreAccumulator.runForPlayer (and any
        // fire-and-forget work from triggerSync) settle before reading state / cleaning up —
        // otherwise a scoring_events row can be inserted after delete_orphaned_demo_leagues's
        // own `delete from scoring_events` step but before its `delete from roster_slots` step,
        // tripping scoring_events_roster_slot_id_fkey. This is a test-cleanup-timing concern
        // only (fire-and-forget + immediate hard-delete in test teardown) — not a product bug.
        await new Promise((r) => setTimeout(r, 2000));

        const { data: recoveredSlot, error: recErr } = await db
          .from('roster_slots')
          .select('is_active, slot_key, released_at_round_stage')
          .eq('league_id', league.league_id)
          .eq('user_id', league.commissioner_id)
          .eq('player_id', injuredPlayerId)
          .eq('is_active', true)
          .is('released_at_round_stage', null)
          .maybeSingle();
        if (recErr) throw new Error(`roster_slots query failed: ${recErr.message}`);

        assert(
          recoveredSlot !== null && recoveredSlot.slot_key === 'G1',
          'Bug #6 (injury_sub_reversible dead code): with injury_sub_reversible=true and the injured player\'s ' +
          `injury_status restored to 'active', expected an active roster_slot for player ${injuredPlayerId} ` +
          `with slot_key='G1' (reversal of the injury sub) after triggerSync(). Got: ${JSON.stringify(recoveredSlot)}. ` +
          "src/app/api/league/route.ts:21 documents injury_sub_reversible as 'deferred — has no effect in current " +
          "implementation' — no code path (in /api/commissioner/injury-sub or the sync-scores cron) reads this " +
          'setting or reverses a prior injury substitution.'
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    },
    'KNOWN FAILING — Bug #6 (injury_sub_reversible is dead code, no reversal mechanism exists)'
  );

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test-injury-sub: unhandled error:', err);
  process.exit(1);
});
