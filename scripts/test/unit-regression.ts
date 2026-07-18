import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { db, assert, createTestLeague, cleanupTestLeague } from './utils/testHelpers';

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

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Regression 1 — handle_new_user trigger
  await runCase(
    'Regression 1 — handle_new_user trigger creates public.users row',
    async () => {
      const { data, error } = await db.auth.admin.createUser({
        email: `test-regression-${Date.now()}@test.invalid`,
        password: 'testpassword123',
        email_confirm: true,
      });
      if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`);

      try {
        const { data: userRow, error: userErr } = await db
          .from('users')
          .select('id')
          .eq('id', data.user.id)
          .maybeSingle();
        if (userErr) throw new Error(`users query failed: ${userErr.message}`);
        assert(
          userRow !== null,
          'handle_new_user SECURITY DEFINER trigger regression: public.users row not created'
        );
      } finally {
        await db.auth.admin.deleteUser(data.user.id);
      }
    }
  );

  // Regression 2 — IN_FILTER_CHUNK_SIZE chunking (101 game_score_ids)
  await runCase(
    'Regression 2 — IN_FILTER_CHUNK_SIZE chunking (101 game_score_ids)',
    async () => {
      const league = await createTestLeague({ memberCount: 13, activationTiming: 'immediate' });
      try {
        const allPlayerIds = [...league.player_assignments.values()].flat();
        assert(allPlayerIds.length >= 101, `expected >=101 drafted players, got ${allPlayerIds.length}`);
        const playerIds = allPlayerIds.slice(0, 101);

        const gameScoreIds: string[] = [];
        for (const playerId of playerIds) {
          gameScoreIds.push(await upsertGameScore(playerId, 'r64', '2026-03-28', 12));
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
          `ScoreAccumulator chunking regression — URI-too-long fix: expected ${expectedCredited} ` +
          `scoring_events (starters only, bench excluded), got ${count}`
        );
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
  console.error('unit-regression: unhandled error:', err);
  process.exit(1);
});
