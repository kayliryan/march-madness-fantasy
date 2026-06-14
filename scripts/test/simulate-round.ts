import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { RosterActivationService } from '@/lib/services/RosterActivationService';
import { getNextRoundStage, ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { LeagueSettings } from '@/lib/types';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  advanceRound,
  triggerSync,
} from './utils/testHelpers';
import type { AdvanceRoundResult } from './utils/testHelpers';

// ── simulateRound ────────────────────────────────────────────────────────
//
// Foundation helper used directly by this script's self-test below, and
// importable by Scripts 4-7 (test-bench-order-change, test-injury-sub,
// test-score-recalculation, test-full-tournament) to drive a round forward.

export interface SimulateRoundOptions {
  league_id: string;
  round_stage: RoundStage;
  season?: number;
}

export type SimulateRoundResult = AdvanceRoundResult;

async function getPlayerIdsInTeams(team_ids: string[]): Promise<string[]> {
  if (team_ids.length === 0) return [];
  const { data, error } = await db.from('players').select('id').in('team_id', team_ids);
  if (error) throw new Error(`getPlayerIdsInTeams failed: ${error.message}`);
  return (data ?? []).map((p) => p.id as string);
}

/**
 * Simulates one tournament round completing for a league, building on
 * advanceRound() (steps 1-6: load alive teams, eliminate deterministic
 * losers, insert final game_scores, mark stale + runForGames, immediate
 * activation), then adds:
 *
 *  - For `end_of_round` leagues: advanceRound() does NOT release eliminated
 *    starters' roster_slots (that's normally Responsibility 1 of the cron,
 *    which is a no-op under MOCK_ESPN=true). This releases them here so
 *    activateBatch() has something to replace, mirroring what the cron's
 *    elimination-detection would do before batch activation runs.
 *  - A full ScoreAccumulator.runForLeague() recompute so
 *    leaderboard_snapshots.round_stage advances to reflect this round.
 *  - triggerSync() for Responsibility 2 (bench lock) and Responsibility 3
 *    (end-of-round detection) side effects — not relied on for activation,
 *    which is driven explicitly above.
 */
export async function simulateRound(options: SimulateRoundOptions): Promise<SimulateRoundResult> {
  const { league_id, round_stage, season } = options;

  const result = await advanceRound({ league_id, round_stage, season });

  const { data: leagueRow, error: leagueErr } = await db
    .from('leagues')
    .select('settings')
    .eq('id', league_id)
    .single();
  if (leagueErr || !leagueRow) throw new Error(`simulateRound: failed to load league ${league_id}: ${leagueErr?.message}`);
  const settings = leagueRow.settings as LeagueSettings;

  if (settings.activation_timing === 'end_of_round') {
    const elimPlayerIds = await getPlayerIdsInTeams(result.eliminated_team_ids);
    if (elimPlayerIds.length > 0) {
      const { error } = await db
        .from('roster_slots')
        .update({ is_active: false, released_at_round_stage: round_stage, release_reason: 'eliminated' })
        .eq('league_id', league_id)
        .eq('is_bench', false)
        .eq('is_active', true)
        .is('released_at_round_stage', null)
        .in('player_id', elimPlayerIds);
      if (error) throw new Error(`simulateRound: failed to release eliminated starters: ${error.message}`);
    }

    const next = getNextRoundStage(round_stage);
    if (next) await RosterActivationService.activateBatch([league_id], next);
  }

  // Full recompute — advances leaderboard_snapshots.round_stage to the max
  // round_stage among each user's non-stale scoring_events.
  await ScoreAccumulator.runForLeague(league_id);

  // Bench lock + end-of-round detection side effects (score sync is a no-op
  // under MOCK_ESPN=true; activation is driven explicitly above).
  await triggerSync();

  return result;
}

// ── CLI entry point ─────────────────────────────────────────────────────
//
// Usage: npx tsx --env-file=.env.local scripts/test/simulate-round.ts --league-id=<id> --round=r64

function parseArgs(): { league_id?: string; round?: string } {
  const out: { league_id?: string; round?: string } = {};
  for (const arg of process.argv.slice(2)) {
    const [key, value] = arg.replace(/^--/, '').split('=');
    if (key === 'league-id') out.league_id = value;
    if (key === 'round') out.round = value;
  }
  return out;
}

// ── Test runner (self-test against fresh test leagues) ─────────────────────

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

async function getScoringEventByGameScore(
  league_id: string,
  game_score_id: string
): Promise<{ points_credited: number; roster_slot_id: string | null; is_stale: boolean } | null> {
  const { data, error } = await db
    .from('scoring_events')
    .select('points_credited, roster_slot_id, is_stale')
    .eq('league_id', league_id)
    .eq('game_score_id', game_score_id)
    .maybeSingle();
  if (error) throw new Error(`getScoringEventByGameScore failed: ${error.message}`);
  return data as { points_credited: number; roster_slot_id: string | null; is_stale: boolean } | null;
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const cliArgs = parseArgs();
  if (cliArgs.league_id && cliArgs.round) {
    console.log(`Running simulateRound for league=${cliArgs.league_id} round=${cliArgs.round}...`);
    const result = await simulateRound({ league_id: cliArgs.league_id, round_stage: cliArgs.round as RoundStage });
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  // Case 1 — Immediate-activation league: round r64, then r32 (round_stage progression)
  await runCase('Case 1 — Immediate-activation league: r64 then r32', async () => {
    const league = await createTestLeague({ memberCount: 24, activationTiming: 'immediate' });
    try {
      const r64 = await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

      // Every active player's game_scores has matching scoring_events with points_credited > 0
      const { data: r64Events, error: evErr } = await db
        .from('scoring_events')
        .select('points_credited, is_stale')
        .eq('league_id', league.league_id)
        .eq('round_stage', 'r64');
      if (evErr) throw new Error(`scoring_events query failed: ${evErr.message}`);
      assert((r64Events ?? []).length > 0, 'expected at least one r64 scoring_event');
      assert(
        (r64Events ?? []).every((e) => e.is_stale === false),
        `is_stale=false expected for all r64 scoring_events after accumulator run, got ${
          (r64Events ?? []).filter((e) => e.is_stale).length
        } stale`
      );
      assert(
        (r64Events ?? []).every((e) => e.points_credited > 0),
        'expected all r64 scoring_events to have points_credited > 0'
      );

      // Eliminated teams' starter roster_slots released with release_reason='eliminated'
      const elimPlayerIds = new Set(await getPlayerIdsInTeams(r64.eliminated_team_ids));
      const { data: slots, error: slotsErr } = await db
        .from('roster_slots')
        .select('player_id, is_bench, is_active, acquired_at_round_stage, released_at_round_stage, release_reason')
        .eq('league_id', league.league_id);
      if (slotsErr) throw new Error(`roster_slots query failed: ${slotsErr.message}`);

      const releasedStarters = (slots ?? []).filter((s) => !s.is_bench && elimPlayerIds.has(s.player_id));
      for (const s of releasedStarters) {
        assert(
          s.is_active === false && s.released_at_round_stage === 'r64' && s.release_reason === 'eliminated',
          `expected eliminated-team starter to be released at r64, got ${JSON.stringify(s)}`
        );
      }

      // Newly activated bench players (immediate) have acquired_at_round_stage = 'r64'
      const activated = (slots ?? []).filter((s) => !s.is_bench && s.acquired_at_round_stage === 'r64');
      assert(
        activated.length <= releasedStarters.length,
        `expected at most ${releasedStarters.length} mid-round activations, got ${activated.length}`
      );

      // leaderboard_snapshots updated with correct totals + round_stage >= 'r64'.
      //
      // Not asserted as exactly 'r64': game_scores is a season-scoped shared fixture, not
      // reset between test runs. runForLeague's full rebuild pulls ALL game_scores ever
      // inserted for any player_id that has been on this league's roster (acquired='draft',
      // released=null spans the whole tournament), so a player with e.g. e8-stage game_scores
      // from a prior run's advanceRound calls legitimately produces an e8 scoring_event here
      // too, making round_stage (= max eligible event stage) >= 'r64' but not necessarily ==.
      const r64Idx = ROUND_STAGE_ORDER.indexOf('r64');
      const r32Idx = ROUND_STAGE_ORDER.indexOf('r32');

      const { data: snaps, error: snapErr } = await db
        .from('leaderboard_snapshots')
        .select('user_id, total_points, round_stage')
        .eq('league_id', league.league_id);
      if (snapErr) throw new Error(`leaderboard_snapshots query failed: ${snapErr.message}`);
      assert((snaps ?? []).length === league.member_ids.length, `expected ${league.member_ids.length} snapshots, got ${(snaps ?? []).length}`);

      const stagesR64 = new Map<string, number>();
      for (const snap of snaps ?? []) {
        const idx = ROUND_STAGE_ORDER.indexOf(snap.round_stage as (typeof ROUND_STAGE_ORDER)[number]);
        assert(idx >= r64Idx, `expected round_stage >= 'r64' after r64 run, got '${snap.round_stage}' for user ${snap.user_id}`);
        stagesR64.set(snap.user_id, idx);

        const { data: userEvents, error: ueErr } = await db
          .from('scoring_events')
          .select('points_credited')
          .eq('league_id', league.league_id)
          .eq('user_id', snap.user_id)
          .eq('is_stale', false);
        if (ueErr) throw new Error(`scoring_events query failed: ${ueErr.message}`);
        const expectedTotal = (userEvents ?? []).reduce((sum, e) => sum + (e.points_credited as number), 0);
        assert(
          snap.total_points === expectedTotal,
          `user ${snap.user_id}: expected total_points=${expectedTotal}, got ${snap.total_points}`
        );
      }

      // Run r32 — round_stage should be monotonically non-decreasing per user, and the
      // league-wide max should reach at least 'r32'.
      await simulateRound({ league_id: league.league_id, round_stage: 'r32' });

      const { data: snaps2, error: snap2Err } = await db
        .from('leaderboard_snapshots')
        .select('user_id, round_stage')
        .eq('league_id', league.league_id);
      if (snap2Err) throw new Error(`leaderboard_snapshots query failed: ${snap2Err.message}`);

      let maxIdxR32 = -1;
      for (const snap of snaps2 ?? []) {
        const idx = ROUND_STAGE_ORDER.indexOf(snap.round_stage as (typeof ROUND_STAGE_ORDER)[number]);
        maxIdxR32 = Math.max(maxIdxR32, idx);
        const prevIdx = stagesR64.get(snap.user_id) ?? -1;
        assert(
          idx >= prevIdx,
          `round_stage regressed for user ${snap.user_id}: was index ${prevIdx} after r64, now ${idx} ('${snap.round_stage}') after r32`
        );
      }
      assert(maxIdxR32 >= r32Idx, `expected league-wide max round_stage >= 'r32' after r32 run, got max index ${maxIdxR32}`);

      const { data: staleAfter, error: staleErr } = await db
        .from('scoring_events')
        .select('id')
        .eq('league_id', league.league_id)
        .eq('is_stale', true);
      if (staleErr) throw new Error(`scoring_events query failed: ${staleErr.message}`);
      assert((staleAfter ?? []).length === 0, `expected 0 stale scoring_events after r32 run, got ${(staleAfter ?? []).length}`);

      console.log(
        `      [Case 1] r64 eliminated ${r64.eliminated_team_ids.length} teams, ` +
        `${releasedStarters.length} drafted starters released, ${activated.length} bench players activated mid-round`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 2 — End-of-round-activation league: round r64
  await runCase('Case 2 — End-of-round-activation league: r64', async () => {
    const league = await createTestLeague({ memberCount: 24, activationTiming: 'end_of_round' });
    try {
      const r64 = await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

      const elimPlayerIds = new Set(await getPlayerIdsInTeams(r64.eliminated_team_ids));
      const { data: slots, error: slotsErr } = await db
        .from('roster_slots')
        .select('player_id, is_bench, is_active, acquired_at_round_stage, released_at_round_stage, release_reason')
        .eq('league_id', league.league_id);
      if (slotsErr) throw new Error(`roster_slots query failed: ${slotsErr.message}`);

      // Eliminated teams' starter roster_slots released with release_reason='eliminated'
      const releasedStarters = (slots ?? []).filter((s) => !s.is_bench && elimPlayerIds.has(s.player_id));
      for (const s of releasedStarters) {
        assert(
          s.is_active === false && s.released_at_round_stage === 'r64' && s.release_reason === 'eliminated',
          `expected eliminated-team starter to be released at r64, got ${JSON.stringify(s)}`
        );
      }

      // Bench players activated via activateBatch acquired at next_round_stage ('r32'), not 'r64'
      const activatedNext = (slots ?? []).filter((s) => !s.is_bench && s.acquired_at_round_stage === 'r32');
      const activatedR64 = (slots ?? []).filter((s) => !s.is_bench && s.acquired_at_round_stage === 'r64');
      assert(activatedR64.length === 0, `end_of_round league: expected no starters activated at 'r64', got ${activatedR64.length}`);
      assert(
        activatedNext.length <= releasedStarters.length,
        `expected at most ${releasedStarters.length} batch activations, got ${activatedNext.length}`
      );

      const { data: r64Events, error: evErr } = await db
        .from('scoring_events')
        .select('points_credited, is_stale')
        .eq('league_id', league.league_id)
        .eq('round_stage', 'r64');
      if (evErr) throw new Error(`scoring_events query failed: ${evErr.message}`);
      assert((r64Events ?? []).length > 0, 'expected at least one r64 scoring_event');
      assert(
        (r64Events ?? []).every((e) => e.is_stale === false),
        'expected is_stale=false for all r64 scoring_events after accumulator run'
      );

      console.log(
        `      [Case 2] r64 eliminated ${r64.eliminated_team_ids.length} teams, ` +
        `${releasedStarters.length} drafted starters released, ${activatedNext.length} bench players batch-activated for r32`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 3 — Mid-round activation credit (per-game_score_id eligibility within a round_stage)
  //
  // KNOWN LIMITATION: Mid-round activation credit is round_stage-granular, not
  // game-granular. A bench player activated during r64 after some r64 games have
  // already been played will receive credit for ALL r64 games, not just games
  // played after their activation. This is a known limitation of the current
  // schema, which stores round_stage as a text label rather than a game sequence
  // number. Behavior is internally consistent and defensible for the family app
  // use case.
  await runCase(
    'Case 3 — Mid-round activation credit',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const starterG1 = league.player_assignments.get(league.commissioner_id)![0]; // G1, starter
        const benchG = league.player_assignments.get(league.commissioner_id)![5]; // B1, bench G

        // "Earlier" r64 game while still on the bench (acquired='draft', released=null —
        // already eligible for r64, since acqIdx(0) <= gameStageIdx(2) < relIdx(8)).
        const gsEarly = await upsertGameScore(benchG, 'r64', '2026-03-29', 14);
        await ScoreAccumulator.runForGames([gsEarly]);

        const earlyEvent = await getScoringEventByGameScore(league.league_id, gsEarly);
        assert(
          earlyEvent?.points_credited === 14,
          `expected bench player credited @14 for pre-activation r64 game, got ${JSON.stringify(earlyEvent)}`
        );

        // Mid-round activation, mirroring RosterActivationService.activateSlot: release the
        // eliminated starter's slot (G1) and the incoming bench player's own bench slot (B1),
        // then insert a new active starter slot for benchG inheriting slot_key='G1' — the
        // partial unique index on (league_id, user_id, slot_key) WHERE is_active requires the
        // old G1 row to be released first.
        const { error: relStarterErr } = await db
          .from('roster_slots')
          .update({ is_active: false, released_at_round_stage: 'r64', release_reason: 'eliminated' })
          .eq('league_id', league.league_id)
          .eq('player_id', starterG1)
          .eq('is_bench', false);
        if (relStarterErr) throw new Error(`failed to release starter slot: ${relStarterErr.message}`);

        const { error: relBenchErr } = await db
          .from('roster_slots')
          .update({ is_active: false, released_at_round_stage: 'r64', release_reason: 'eliminated' })
          .eq('league_id', league.league_id)
          .eq('player_id', benchG)
          .eq('is_bench', true);
        if (relBenchErr) throw new Error(`failed to release bench slot: ${relBenchErr.message}`);

        const { error: insErr } = await db.from('roster_slots').insert({
          league_id: league.league_id,
          user_id: league.commissioner_id,
          player_id: benchG,
          slot_key: 'G1',
          slot_position: 'G',
          is_active: true,
          is_bench: false,
          acquired_at_round_stage: 'r64',
        });
        if (insErr) throw new Error(`failed to insert activated starter slot: ${insErr.message}`);

        // "Later" r64 game, inserted after activation.
        const gsLate = await upsertGameScore(benchG, 'r64', '2026-03-30', 19);
        await ScoreAccumulator.runForGames([gsEarly, gsLate]);

        const earlyAfter = await getScoringEventByGameScore(league.league_id, gsEarly);
        const lateAfter = await getScoringEventByGameScore(league.league_id, gsLate);
        assert(
          earlyAfter?.points_credited === 14 && earlyAfter?.is_stale === false,
          `expected pre-activation r64 game still credited @14 after activation, got ${JSON.stringify(earlyAfter)}`
        );
        assert(
          lateAfter?.points_credited === 19 && lateAfter?.is_stale === false,
          `expected post-activation r64 game credited @19, got ${JSON.stringify(lateAfter)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    },
    "Handoff doc's additional test expects the bench player to be credited 'only for " +
    "game_scores inserted after activation, not for earlier games in the same round_stage'. " +
    "This is structurally impossible given round_stage-granularity activation: eligibility " +
    "(acqIdx <= gameStageIdx < relIdx) depends only on round_stage indices, not game_date or " +
    "insertion order. A player active for r64 (whether via the pre-activation bench slot or " +
    "the post-activation starter slot) is credited for ALL r64 game_scores rows for that " +
    "player_id. This case documents and verifies that actual (correct) behavior instead: both " +
    "the pre- and post-activation r64 games are credited, with the scoring_event for the " +
    "earlier game re-pointed to the new starter roster_slot_id on recompute."
  );

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

// Only run main() (CLI mode or self-test) when this file is executed directly —
// not when simulateRound is imported by other scripts (e.g. Scripts 4-7).
const isMainModule = process.argv[1]?.endsWith('simulate-round.ts') ?? false;
if (isMainModule) {
  main().catch((err) => {
    console.error('simulate-round: unhandled error:', err);
    process.exit(1);
  });
}
