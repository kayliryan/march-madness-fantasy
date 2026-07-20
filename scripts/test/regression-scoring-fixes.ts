import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { RosterActivationService } from '@/lib/services/RosterActivationService';
import { db, assert, createTestLeague, cleanupTestLeague, setSubmittedBenchOrder } from './utils/testHelpers';

/**
 * Regression tests for two scoring-engine correctness fixes:
 *
 *  Bug 1 — ScoreAccumulator credited bench slots as if they were starters.
 *    Canonical rule (src/lib/utils/roundBreakdown.ts): a starter slot's points count
 *    when is_bench=false AND acqIdx <= gameRound <= releaseRound — INCLUSIVE of the
 *    release round (the team's elimination/loss game still scores). Bench slots NEVER
 *    score.
 *
 *  Bug 2 — activateBatch (end_of_round leagues) never released eliminated starters'
 *    slots; only activateImmediate ever set is_active=false + released_at_round_stage.
 *    activateBatch now performs the release itself (released_at_round_stage = the
 *    team's eliminated_in_round_stage) before promoting bench replacements.
 */

// ── Test runner (same pattern as unit-score-accumulator.ts) ───────────────

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

async function getEventsForPlayer(
  league_id: string,
  player_id: string
): Promise<{ points_credited: number; round_stage: string; roster_slot_id: string | null }[]> {
  const { data, error } = await db
    .from('scoring_events')
    .select('points_credited, round_stage, roster_slot_id')
    .eq('league_id', league_id)
    .eq('player_id', player_id)
    .eq('is_stale', false);
  if (error) throw new Error(`getEventsForPlayer failed: ${error.message}`);
  return (data ?? []) as { points_credited: number; round_stage: string; roster_slot_id: string | null }[];
}

async function getEventByGameScore(
  league_id: string,
  game_score_id: string
): Promise<{ points_credited: number } | null> {
  const { data, error } = await db
    .from('scoring_events')
    .select('points_credited')
    .eq('league_id', league_id)
    .eq('game_score_id', game_score_id)
    .eq('is_stale', false)
    .maybeSingle();
  if (error) throw new Error(`getEventByGameScore failed: ${error.message}`);
  return data as { points_credited: number } | null;
}

async function getSnapshotTotal(league_id: string, user_id: string): Promise<number | null> {
  const { data, error } = await db
    .from('leaderboard_snapshots')
    .select('total_points')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw new Error(`getSnapshotTotal failed: ${error.message}`);
  return data ? (data.total_points as number) : null;
}

interface SlotRow {
  id: string;
  player_id: string;
  slot_key: string;
  slot_position: 'G' | 'F' | 'C';
  is_bench: boolean;
  is_active: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
  release_reason: string | null;
}

async function getSlot(
  league_id: string,
  user_id: string,
  player_id: string,
  is_bench: boolean
): Promise<SlotRow | null> {
  const { data, error } = await db
    .from('roster_slots')
    .select('id, player_id, slot_key, slot_position, is_bench, is_active, acquired_at_round_stage, released_at_round_stage, release_reason')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .eq('player_id', player_id)
    .eq('is_bench', is_bench)
    .maybeSingle();
  if (error) throw new Error(`getSlot failed: ${error.message}`);
  return data as SlotRow | null;
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case 1 — Bench slot is never credited by runForGames
  await runCase('Case 1 — Bench slot not credited (runForGames)', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const players = league.player_assignments.get(league.commissioner_id)!; // SLOT_KEYS order
      const starter = players[0]; // G1 (is_bench=false)
      const bench = players[5]; // B1 (is_bench=true)

      const gsStarter = await upsertGameScore(starter, 'r64', '2026-04-11', 37);
      const gsBench = await upsertGameScore(bench, 'r64', '2026-04-11', 24);
      await ScoreAccumulator.runForGames([gsStarter, gsBench]);

      const starterEvents = await getEventsForPlayer(league.league_id, starter);
      assert(
        starterEvents.length === 1 && starterEvents[0].points_credited === 37,
        `starter: expected 1 event @37, got ${JSON.stringify(starterEvents)}`
      );

      const benchEvents = await getEventsForPlayer(league.league_id, bench);
      assert(
        benchEvents.length === 0,
        `bench: expected 0 scoring_events (bench slots never score), got ${JSON.stringify(benchEvents)}`
      );

      const total = await getSnapshotTotal(league.league_id, league.commissioner_id);
      assert(
        total === 37,
        `leaderboard snapshot: expected total_points=37 (starter only, bench excluded), got ${total}`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 2 — Release-round boundary is INCLUSIVE for team-elimination: the release
  // round (the loss game) IS credited; the round strictly after is not.
  await runCase('Case 2 — Release-round boundary inclusive (r64 and the r32 loss both credited, s16 not)', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const starter = league.player_assignments.get(league.commissioner_id)![0]; // G1

      // Starter's team eliminated in r32: scores r64 AND r32 (the loss round), NOT s16.
      await db
        .from('roster_slots')
        .update({ released_at_round_stage: 'r32', is_active: false, release_reason: 'eliminated' })
        .eq('league_id', league.league_id)
        .eq('player_id', starter);

      const gsR64 = await upsertGameScore(starter, 'r64', '2026-04-12', 21);
      const gsR32 = await upsertGameScore(starter, 'r32', '2026-04-12', 30);
      const gsS16 = await upsertGameScore(starter, 's16', '2026-04-12', 40); // after elimination — must not count
      await ScoreAccumulator.runForGames([gsR64, gsR32, gsS16]);

      const evR64 = await getEventByGameScore(league.league_id, gsR64);
      assert(
        evR64 !== null && evR64.points_credited === 21,
        `r64 game (before release round): expected credited @21, got ${JSON.stringify(evR64)}`
      );

      const evR32 = await getEventByGameScore(league.league_id, gsR32);
      assert(
        evR32 !== null && evR32.points_credited === 30,
        `r32 game (the elimination/loss round itself): expected credited @30 (inclusive), got ${JSON.stringify(evR32)}`
      );

      const evS16 = await getEventByGameScore(league.league_id, gsS16);
      assert(
        evS16 === null,
        `s16 game (strictly after elimination): expected NO credit, got ${JSON.stringify(evS16)}`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 3 — runForLeague cleans up pre-existing bench-credited corruption
  await runCase('Case 3 — runForLeague removes stale bench credits', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const players = league.player_assignments.get(league.commissioner_id)!;
      const starter = players[0]; // G1
      const bench = players[5]; // B1

      const gsStarter = await upsertGameScore(starter, 'r64', '2026-04-13', 30);
      const gsBench = await upsertGameScore(bench, 'r64', '2026-04-13', 50);
      await ScoreAccumulator.runForGames([gsStarter, gsBench]);

      // Simulate pre-fix corruption: a scoring_events row crediting the bench slot.
      const benchSlot = await getSlot(league.league_id, league.commissioner_id, bench, true);
      assert(benchSlot, 'expected a bench roster_slot for B1');
      const { error: insertErr } = await db.from('scoring_events').insert({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        player_id: bench,
        game_score_id: gsBench,
        round_stage: 'r64',
        points_credited: 50,
        roster_slot_id: benchSlot.id,
        is_stale: false,
      });
      if (insertErr) throw new Error(`bogus bench scoring_event insert failed: ${insertErr.message}`);

      // Full recompute must delete the bench credit and rebuild starter-only events.
      await ScoreAccumulator.runForLeague(league.league_id);

      const benchEvents = await getEventsForPlayer(league.league_id, bench);
      assert(
        benchEvents.length === 0,
        `bench: expected 0 events after runForLeague cleanup, got ${JSON.stringify(benchEvents)}`
      );

      // Snapshot must equal the sum of remaining (starter-only) non-stale events.
      // Note: game_scores are global per player, so the full rebuild legitimately
      // re-credits this league's starters for game rows created by other test cases
      // sharing the same top-avg_ppg players — assert consistency, not a hardcoded sum.
      const { data: allEvents, error: allErr } = await db
        .from('scoring_events')
        .select('points_credited, roster_slot_id, player_id')
        .eq('league_id', league.league_id)
        .eq('user_id', league.commissioner_id)
        .eq('is_stale', false);
      if (allErr) throw new Error(`scoring_events query failed: ${allErr.message}`);

      const { data: benchSlots, error: benchErr } = await db
        .from('roster_slots')
        .select('id')
        .eq('league_id', league.league_id)
        .eq('user_id', league.commissioner_id)
        .eq('is_bench', true);
      if (benchErr) throw new Error(`roster_slots query failed: ${benchErr.message}`);
      const benchSlotIds = new Set((benchSlots ?? []).map((s) => s.id as string));

      for (const ev of allEvents ?? []) {
        assert(
          !ev.roster_slot_id || !benchSlotIds.has(ev.roster_slot_id),
          `found a scoring_event still referencing a bench roster_slot: ${JSON.stringify(ev)}`
        );
      }

      const expectedTotal = (allEvents ?? []).reduce((sum, e) => sum + (e.points_credited as number), 0);
      const total = await getSnapshotTotal(league.league_id, league.commissioner_id);
      assert(
        total === expectedTotal,
        `snapshot total expected ${expectedTotal} (sum of starter-only events, bench credit gone), got ${total}`
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 4 — activateBatch releases eliminated starters (end_of_round leagues)
  await runCase('Case 4 — activateBatch releases eliminated starters and promotes bench', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'end_of_round' });
    // teams are season-global (shared with the demo league and prior test runs, many of
    // which already marked teams eliminated) — neutralize elimination state for every
    // team rostered in this league so the batch release is deterministic, and restore
    // the original values afterward.
    let savedTeams: { id: string; is_eliminated: boolean; eliminated_in_round_stage: string | null }[] = [];
    try {
      const allPlayerIds = [...league.player_assignments.values()].flat();
      const { data: playerRows, error: playerErr } = await db
        .from('players')
        .select('id, team_id')
        .in('id', allPlayerIds);
      if (playerErr) throw new Error(`players query failed: ${playerErr.message}`);
      const teamByPlayer = new Map((playerRows ?? []).map((p) => [p.id as string, p.team_id as string]));
      const rosteredTeamIds = [...new Set([...teamByPlayer.values()])];

      const { data: teamRows, error: teamErr } = await db
        .from('teams')
        .select('id, is_eliminated, eliminated_in_round_stage')
        .in('id', rosteredTeamIds);
      if (teamErr) throw new Error(`teams query failed: ${teamErr.message}`);
      savedTeams = (teamRows ?? []) as typeof savedTeams;

      const { error: clearErr } = await db
        .from('teams')
        .update({ is_eliminated: false, eliminated_in_round_stage: null })
        .in('id', rosteredTeamIds);
      if (clearErr) throw new Error(`teams clear failed: ${clearErr.message}`);

      // Commissioner's roster in SLOT_KEYS order: G1,G2,F1,F2,C1,B1,B2,B3
      const players = league.player_assignments.get(league.commissioner_id)!;
      const starterMeta: { idx: number; pos: 'G' | 'F' | 'C' }[] = [
        { idx: 0, pos: 'G' }, { idx: 1, pos: 'G' }, { idx: 2, pos: 'F' }, { idx: 3, pos: 'F' }, { idx: 4, pos: 'C' },
      ];
      const benchMeta: { idx: number; pos: 'G' | 'F' | 'C' }[] = [
        { idx: 5, pos: 'G' }, { idx: 6, pos: 'F' }, { idx: 7, pos: 'C' },
      ];
      // Default sub_eligibility_matrix: G/F slots accept G or F; C slots accept C.
      const eligibleFor: Record<'G' | 'F' | 'C', ('G' | 'F' | 'C')[]> = {
        G: ['G', 'F'],
        F: ['G', 'F'],
        C: ['C'],
      };

      // Pick a starter whose team is unique among the commissioner's starters, with an
      // eligible bench sub on a DIFFERENT team (an eliminated-team bench player would be
      // skipped by BenchOrderService).
      let starterId: string | null = null;
      let expectedSubId: string | null = null;
      for (const s of starterMeta) {
        const sTeam = teamByPlayer.get(players[s.idx])!;
        const sharesTeam = starterMeta.some((o) => o.idx !== s.idx && teamByPlayer.get(players[o.idx]) === sTeam);
        if (sharesTeam) continue;
        const sub = benchMeta.find((b) => eligibleFor[s.pos].includes(b.pos) && teamByPlayer.get(players[b.idx]) !== sTeam);
        if (!sub) continue;
        starterId = players[s.idx];
        expectedSubId = players[sub.idx];
        break;
      }
      assert(starterId && expectedSubId, 'could not find a starter/bench pair on distinct teams');

      // Bench order in B1,B2,B3 order — resolveNext takes the first eligible entry.
      await setSubmittedBenchOrder({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        ordered_player_ids: benchMeta.map((b) => players[b.idx]),
      });

      // Eliminate the starter's team in r64.
      const starterTeamId = teamByPlayer.get(starterId!)!;
      const { error: elimErr } = await db
        .from('teams')
        .update({ is_eliminated: true, eliminated_in_round_stage: 'r64' })
        .eq('id', starterTeamId);
      if (elimErr) throw new Error(`team eliminate failed: ${elimErr.message}`);

      const preSlot = await getSlot(league.league_id, league.commissioner_id, starterId!, false);
      assert(
        preSlot && preSlot.is_active && preSlot.released_at_round_stage === null,
        `precondition: starter slot should be active and unreleased, got ${JSON.stringify(preSlot)}`
      );

      // r64 complete -> r32 begins for end_of_round leagues.
      await RosterActivationService.activateBatch([league.league_id], 'r32');

      const released = await getSlot(league.league_id, league.commissioner_id, starterId!, false);
      assert(released, 'released starter slot not found');
      assert(released.is_active === false, `released slot: expected is_active=false, got ${released.is_active}`);
      assert(
        released.released_at_round_stage === 'r64',
        `released slot: expected released_at_round_stage='r64' (the team's elimination round), got ${JSON.stringify(released.released_at_round_stage)}`
      );
      assert(
        released.release_reason === 'eliminated',
        `released slot: expected release_reason='eliminated', got ${JSON.stringify(released.release_reason)}`
      );

      // The bench sub gets a NEW active starter slot, acquired at the batch's next round.
      const promoted = await getSlot(league.league_id, league.commissioner_id, expectedSubId!, false);
      assert(promoted, `expected a new starter (is_bench=false) slot for the promoted bench player ${expectedSubId}`);
      assert(promoted.is_active === true, `promoted slot: expected is_active=true, got ${promoted.is_active}`);
      assert(
        promoted.acquired_at_round_stage === 'r32',
        `promoted slot: expected acquired_at_round_stage='r32', got ${JSON.stringify(promoted.acquired_at_round_stage)}`
      );
      assert(
        promoted.slot_key === released.slot_key,
        `promoted slot: expected inherited slot_key=${released.slot_key}, got ${promoted.slot_key}`
      );

      // The promoted player's original bench slot is released at the new round.
      const benchSlot = await getSlot(league.league_id, league.commissioner_id, expectedSubId!, true);
      assert(benchSlot, 'promoted player bench slot not found');
      assert(
        benchSlot.is_active === false && benchSlot.released_at_round_stage === 'r32',
        `bench slot: expected is_active=false + released_at_round_stage='r32', got ${JSON.stringify(benchSlot)}`
      );

      // Let activateBatch's fire-and-forget ScoreAccumulator.runForPlayer settle
      // before deleting the league out from under it.
      await new Promise((r) => setTimeout(r, 1500));
    } finally {
      for (const t of savedTeams) {
        await db
          .from('teams')
          .update({ is_eliminated: t.is_eliminated, eliminated_in_round_stage: t.eliminated_in_round_stage })
          .eq('id', t.id);
      }
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
  console.error('regression-scoring-fixes: unhandled error:', err);
  process.exit(1);
});
