import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
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

// ── Helpers ───────────────────────────────────────────────────────────────

async function upsertGameScore(
  player_id: string,
  round_stage: string,
  game_date: string,
  points: number
): Promise<string> {
  const { data, error } = await db
    .from('game_scores')
    .upsert(
      {
        player_id,
        season: 2026,
        round_stage,
        round_number: 1,
        game_date,
        game_status: 'final',
        points,
        source: 'manual',
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'player_id,round_stage,round_number,game_date' }
    )
    .select('id')
    .single();

  if (error || !data) throw new Error(`upsertGameScore failed: ${error?.message}`);
  return data.id as string;
}

async function getScoringEvents(
  league_id: string,
  player_id: string,
  round_stage?: string
): Promise<{ points_credited: number; round_stage: string }[]> {
  let q = db
    .from('scoring_events')
    .select('points_credited, round_stage')
    .eq('league_id', league_id)
    .eq('player_id', player_id)
    .eq('is_stale', false);
  if (round_stage) q = q.eq('round_stage', round_stage);

  const { data, error } = await q;
  if (error) throw new Error(`getScoringEvents failed: ${error.message}`);
  return (data ?? []) as { points_credited: number; round_stage: string }[];
}

async function getScoringEventByGameScore(
  league_id: string,
  game_score_id: string
): Promise<{ points_credited: number; is_stale: boolean } | null> {
  const { data, error } = await db
    .from('scoring_events')
    .select('points_credited, is_stale')
    .eq('league_id', league_id)
    .eq('game_score_id', game_score_id)
    .eq('is_stale', false)
    .maybeSingle();
  if (error) throw new Error(`getScoringEventByGameScore failed: ${error.message}`);
  return data as { points_credited: number; is_stale: boolean } | null;
}

async function waitForScoringEvent(
  league_id: string,
  game_score_id: string,
  timeoutMs = 5000
): Promise<{ points_credited: number; is_stale: boolean } | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const { data } = await db
      .from('scoring_events')
      .select('points_credited, is_stale')
      .eq('league_id', league_id)
      .eq('game_score_id', game_score_id)
      .maybeSingle();
    if (data && data.is_stale === false) return data as { points_credited: number; is_stale: boolean };
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

// ── Precondition check ───────────────────────────────────────────────────

function checkPreconditions(): void {
  const expected = ['draft', 'play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship'];
  assert(
    JSON.stringify(ROUND_STAGE_ORDER) === JSON.stringify(expected),
    `ROUND_STAGE_ORDER has changed (got ${JSON.stringify(ROUND_STAGE_ORDER)}) — every case below assumes ` +
    `the order ${JSON.stringify(expected)}; all scoring tests are invalid until re-verified.`
  );
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  try {
    checkPreconditions();
  } catch (err) {
    console.log('FAIL  Precondition check');
    console.log(`      ${err instanceof Error ? err.message : err}`);
    console.log('\nAborting — all scoring tests depend on ROUND_STAGE_ORDER and are invalid.');
    process.exit(1);
  }
  console.log('PASS  Precondition check (ROUND_STAGE_ORDER matches expected order)\n');

  // Case 1 — Basic scoring
  await runCase('Case 1 — Basic scoring', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const playerA = league.player_assignments.get(league.commissioner_id)![0]; // G1, acquired=draft, released=null

      const gsId = await upsertGameScore(playerA, 'r64', '2026-03-19', 37);
      await ScoreAccumulator.runForGames([gsId]);

      const events = await getScoringEvents(league.league_id, playerA, 'r64');
      assert(events.length === 1, `expected 1 scoring_event, got ${events.length}`);
      assert(events[0].points_credited === 37, `expected points_credited=37, got ${events[0].points_credited}`);
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 2 — Mid-round sub (immediate activation)
  await runCase(
    'Case 2 — Mid-round sub (immediate activation)',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const [playerA, playerB] = league.player_assignments.get(league.commissioner_id)!; // G1, G2

        // Player A: scored through r64, released entering r32 (acquired='draft', released='r32').
        await db
          .from('roster_slots')
          .update({ released_at_round_stage: 'r32', is_active: false, release_reason: 'eliminated' })
          .eq('league_id', league.league_id)
          .eq('player_id', playerA);

        // Player B: activated entering r64 (acquired='r64', released=null).
        await db
          .from('roster_slots')
          .update({ acquired_at_round_stage: 'r64' })
          .eq('league_id', league.league_id)
          .eq('player_id', playerB);

        const gsA = await upsertGameScore(playerA, 'r64', '2026-03-20', 22);
        const gsB = await upsertGameScore(playerB, 'r64', '2026-03-20', 31);
        await ScoreAccumulator.runForGames([gsA, gsB]);

        const eventsA = await getScoringEvents(league.league_id, playerA, 'r64');
        const eventsB = await getScoringEvents(league.league_id, playerB, 'r64');

        assert(
          eventsA.length === 1 && eventsA[0].points_credited === 22,
          `Player A: expected 1 event @22, got ${JSON.stringify(eventsA)}`
        );
        assert(
          eventsB.length === 1 && eventsB[0].points_credited === 31,
          `Player B: expected 1 event @31, got ${JSON.stringify(eventsB)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    },
    "Handoff doc says Player A's released_at_round_stage='r64'; implemented as 'r32'. " +
    'ScoreAccumulator.ts uses `gameStageIdx < relIdx` (strict), so released_at=X means the slot ' +
    "does NOT score round X. For Player A to be credited for its r64 game (as the case requires), " +
    "relIdx must be > index('r64')=2, i.e. released_at='r32' (idx 3). This is the same exclusive " +
    'boundary semantics that Case 5 (retroactive correction) relies on.'
  );

  // Case 3 — End-of-round sub
  await runCase(
    'Case 3 — End-of-round sub',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const [playerA, playerB] = league.player_assignments.get(league.commissioner_id)!; // G1, G2

        // Player A: scored through r64, released entering r32.
        await db
          .from('roster_slots')
          .update({ released_at_round_stage: 'r32', is_active: false, release_reason: 'eliminated' })
          .eq('league_id', league.league_id)
          .eq('player_id', playerA);

        // Player B: activated entering r32 (acquired='r32', released=null).
        await db
          .from('roster_slots')
          .update({ acquired_at_round_stage: 'r32' })
          .eq('league_id', league.league_id)
          .eq('player_id', playerB);

        const gsA64 = await upsertGameScore(playerA, 'r64', '2026-03-21', 18);
        const gsB64 = await upsertGameScore(playerB, 'r64', '2026-03-21', 27);
        const gsB32 = await upsertGameScore(playerB, 'r32', '2026-03-22', 33);
        await ScoreAccumulator.runForGames([gsA64, gsB64, gsB32]);

        const aR64 = await getScoringEvents(league.league_id, playerA, 'r64');
        const bR64 = await getScoringEvents(league.league_id, playerB, 'r64');
        const bR32 = await getScoringEvents(league.league_id, playerB, 'r32');

        assert(
          aR64.length === 1 && aR64[0].points_credited === 18,
          `Player A r64: expected 1 event @18, got ${JSON.stringify(aR64)}`
        );
        assert(
          bR64.length === 0,
          `Player B r64: expected 0 events (acquired_at='r32' is after r64), got ${JSON.stringify(bR64)}`
        );
        assert(
          bR32.length === 1 && bR32[0].points_credited === 33,
          `Player B r32: expected 1 event @33, got ${JSON.stringify(bR32)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    },
    "Handoff doc says Player A's released_at_round_stage='r64'; implemented as 'r32' for the same " +
    'exclusive-boundary reasoning as Case 2.'
  );

  // Case 4 — draft_cancelled sentinel
  await runCase('Case 4 — draft_cancelled sentinel', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const playerA = league.player_assignments.get(league.commissioner_id)![0]; // G1

      await db
        .from('roster_slots')
        .update({ released_at_round_stage: 'draft_cancelled', is_active: false, release_reason: 'correction' })
        .eq('league_id', league.league_id)
        .eq('player_id', playerA);

      const gsId = await upsertGameScore(playerA, 'r64', '2026-03-23', 50);
      await ScoreAccumulator.runForGames([gsId]);

      const events = await getScoringEvents(league.league_id, playerA);
      assert(events.length === 0, `expected 0 scoring_events for draft_cancelled slot, got ${events.length}`);
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 5 — Retroactive correction
  await runCase('Case 5 — Retroactive correction', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const [playerA, playerB] = league.player_assignments.get(league.commissioner_id)!; // G1, G2

      const gsA = await upsertGameScore(playerA, 'r64', '2026-03-24', 40);
      await ScoreAccumulator.runForGames([gsA]);

      let eventsA = await getScoringEvents(league.league_id, playerA, 'r64');
      assert(
        eventsA.length === 1 && eventsA[0].points_credited === 40,
        `Player A pre-correction: expected 1 event @40, got ${JSON.stringify(eventsA)}`
      );

      // Correction: Player A's pick is voided/released at r64 (exclusive boundary -> no longer
      // scores r64). Player B (already on roster, acquired='draft', released=null) takes over.
      await db
        .from('roster_slots')
        .update({ released_at_round_stage: 'r64', is_active: false, release_reason: 'correction' })
        .eq('league_id', league.league_id)
        .eq('player_id', playerA);

      const gsB = await upsertGameScore(playerB, 'r64', '2026-03-24', 28);

      // Full rebuild (delete + recompute) — this is what removes Player A's now-orphaned event.
      await ScoreAccumulator.runForLeague(league.league_id);

      eventsA = await getScoringEvents(league.league_id, playerA);
      assert(eventsA.length === 0, `Player A post-correction: expected 0 events, got ${eventsA.length}`);

      // Scoped to gsB specifically (not "round_stage=r64 for playerB") — Player B is the same
      // global player used as "Player B" in Cases 2/3, which inserted their own r64 game_scores
      // rows at different game_dates. With Player B's roster_slot eligible for all of them
      // (acquired='draft', released=null), runForLeague's full rebuild legitimately creates one
      // scoring_event per distinct game_score_id.
      const eventB = await getScoringEventByGameScore(league.league_id, gsB);
      assert(
        eventB?.points_credited === 28,
        `Player B: expected event @28 for game_score=${gsB}, got ${JSON.stringify(eventB)}`
      );

      // Snapshot-consistency check: total_points must equal the sum of this user's non-stale
      // scoring_events (whatever that sum legitimately is, given shared game_scores rows from
      // other cases for this user's other roster slots).
      const { data: allEvents, error: allErr } = await db
        .from('scoring_events')
        .select('points_credited')
        .eq('league_id', league.league_id)
        .eq('user_id', league.commissioner_id)
        .eq('is_stale', false);
      if (allErr) throw new Error(`scoring_events query failed: ${allErr.message}`);
      const expectedTotal = (allEvents ?? []).reduce((sum, e) => sum + (e.points_credited as number), 0);

      const { data: snap } = await db
        .from('leaderboard_snapshots')
        .select('total_points')
        .eq('league_id', league.league_id)
        .eq('user_id', league.commissioner_id)
        .maybeSingle();
      assert(
        snap?.total_points === expectedTotal,
        `leaderboard_snapshots.total_points expected ${expectedTotal} (sum of non-stale events), got ${snap?.total_points}`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 6 — is_stale atomicity via POST /api/league/[league_id]/scores/manual
  await runCase('Case 6 — Manual score route (commissioner-authenticated)', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const playerA = league.player_assignments.get(league.commissioner_id)![0]; // G1

      const email = await getUserEmail(league.commissioner_id);
      const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

      const res = await fetch(`${APP_URL}/api/league/${league.league_id}/scores/manual`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Cookie: cookie },
        body: JSON.stringify({
          player_id: playerA,
          round_stage: 'r64',
          round_number: 1,
          game_date: '2026-03-26',
          points: 45,
        }),
      });
      const text = await res.text();
      assert(res.ok, `POST /scores/manual returned ${res.status}: ${text}`);
      const body = JSON.parse(text);
      const gameScoreId = body.game_score?.id as string | undefined;
      assert(!!gameScoreId, `response missing game_score.id: ${JSON.stringify(body)}`);

      const event = await waitForScoringEvent(league.league_id, gameScoreId!);
      assert(event !== null, 'scoring_events row never reached is_stale=false within 5s');
      assert(event!.points_credited === 45, `expected points_credited=45, got ${event!.points_credited}`);
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 7 — Chunking regression (>100 game_score_ids)
  await runCase('Case 7 — Chunking regression (101 game_score_ids)', async () => {
    const league = await createTestLeague({ memberCount: 13, activationTiming: 'immediate' });
    try {
      const allPlayerIds = [...league.player_assignments.values()].flat();
      assert(allPlayerIds.length >= 101, `expected >=101 drafted players, got ${allPlayerIds.length}`);
      const playerIds = allPlayerIds.slice(0, 101);

      const gameScoreIds: string[] = [];
      for (const playerId of playerIds) {
        gameScoreIds.push(await upsertGameScore(playerId, 'r64', '2026-03-27', 15));
      }
      assert(gameScoreIds.length === 101, `expected 101 game_score_ids, got ${gameScoreIds.length}`);

      await ScoreAccumulator.runForGames(gameScoreIds);

      // Bench slots never score (roundBreakdown.ts rule) — only the starter slots
      // among the 101 sliced players get scoring_events. The chunking under test is
      // the >100-id .in() game_scores lookup, which all 101 ids still exercise.
      const { data: starterSlots, error: starterErr } = await db
        .from('roster_slots')
        .select('player_id')
        .eq('league_id', league.league_id)
        .eq('is_bench', false);
      if (starterErr) throw new Error(`roster_slots query failed: ${starterErr.message}`);
      const starterIds = new Set((starterSlots ?? []).map((s) => s.player_id as string));
      const expectedCredited = playerIds.filter((id) => starterIds.has(id)).length;
      assert(expectedCredited > 0, 'expected at least one starter among the 101 players');

      const { count, error } = await db
        .from('scoring_events')
        .select('*', { count: 'exact', head: true })
        .eq('league_id', league.league_id)
        .eq('round_stage', 'r64')
        .eq('is_stale', false);
      if (error) throw new Error(`scoring_events count query failed: ${error.message}`);
      assert(
        count === expectedCredited,
        `expected ${expectedCredited} scoring_events at r64 (starters only, bench excluded), got ${count}`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('unit-score-accumulator: unhandled error:', err);
  process.exit(1);
});
