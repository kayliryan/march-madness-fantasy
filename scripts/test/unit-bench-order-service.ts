// NOTE: `teams` (season 2026) is a shared fixture table, not reset between test runs — every
// advanceRound() call across every script's history leaves eliminations behind, so most teams
// end up is_eliminated=true over time. Cases below that depend on a specific player's team
// NOT being eliminated use withTeamEliminationStates() to force + restore that team's flag,
// keeping this script deterministic regardless of what other scripts have already run.

import '@/lib/utils/wsPolyfill';
import { BenchOrderService } from '@/lib/services/BenchOrderService';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  setSubmittedBenchOrder,
} from './utils/testHelpers';
import type { LeagueSettings } from '@/lib/types';

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

async function getLeagueSettings(league_id: string): Promise<LeagueSettings> {
  const { data, error } = await db.from('leagues').select('settings').eq('id', league_id).single();
  if (error || !data) throw new Error(`getLeagueSettings failed: ${error?.message}`);
  return data.settings as LeagueSettings;
}

/** Temporarily overrides players.avg_ppg for the given (global, shared) players, restoring on exit. */
async function withTempAvgPpg(
  updates: { player_id: string; avg_ppg: number }[],
  fn: () => Promise<void>
): Promise<void> {
  const originals: { player_id: string; avg_ppg: number }[] = [];
  for (const u of updates) {
    const { data, error } = await db.from('players').select('avg_ppg').eq('id', u.player_id).single();
    if (error || !data) throw new Error(`withTempAvgPpg: failed to read player ${u.player_id}: ${error?.message}`);
    originals.push({ player_id: u.player_id, avg_ppg: data.avg_ppg });
    const { error: updErr } = await db.from('players').update({ avg_ppg: u.avg_ppg }).eq('id', u.player_id);
    if (updErr) throw new Error(`withTempAvgPpg: failed to update player ${u.player_id}: ${updErr.message}`);
  }
  try {
    await fn();
  } finally {
    for (const o of originals) {
      await db.from('players').update({ avg_ppg: o.avg_ppg }).eq('id', o.player_id);
    }
  }
}

async function getPlayerTeamId(player_id: string): Promise<string> {
  const { data, error } = await db.from('players').select('team_id').eq('id', player_id).single();
  if (error || !data) throw new Error(`getPlayerTeamId: failed to read player ${player_id}: ${error?.message}`);
  return data.team_id as string;
}

/**
 * Temporarily forces teams.is_eliminated to specific values for the given (global, shared)
 * teams, restoring original values on exit. Season 2026's teams table accumulates eliminations
 * from other test scripts (advanceRound) over time — most teams end up is_eliminated=true — so
 * cases whose "expected winner" depends on a player's team NOT being eliminated need this to
 * stay deterministic regardless of what other scripts have done.
 */
async function withTeamEliminationStates(
  overrides: { team_id: string; value: boolean }[],
  fn: () => Promise<void>
): Promise<void> {
  const originals: { team_id: string; value: boolean }[] = [];
  for (const o of overrides) {
    const { data, error } = await db.from('teams').select('is_eliminated').eq('id', o.team_id).single();
    if (error || !data) throw new Error(`withTeamEliminationStates: failed to read team ${o.team_id}: ${error?.message}`);
    originals.push({ team_id: o.team_id, value: data.is_eliminated });
    if (data.is_eliminated !== o.value) {
      await db.from('teams').update({ is_eliminated: o.value }).eq('id', o.team_id);
    }
  }
  try {
    await fn();
  } finally {
    for (const orig of originals) {
      await db.from('teams').update({ is_eliminated: orig.value }).eq('id', orig.team_id);
    }
  }
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case 1 — Submitted bench order respected
  await runCase('Case 1 — Submitted bench order respected', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!; // [G1,G2,F1,F2,C1,B1,B2,B3]
      const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
      const settings = await getLeagueSettings(league.league_id);

      // Submitted order: [C, G, F] — C is ineligible for the open G slot.
      await setSubmittedBenchOrder({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        ordered_player_ids: [benchC, benchG, benchF],
      });

      await withTeamEliminationStates(
        [{ team_id: await getPlayerTeamId(benchG), value: false }],
        async () => {
          const result = await BenchOrderService.resolveNext(
            league.league_id,
            league.commissioner_id,
            'G',
            settings.sub_eligibility_matrix
          );
          assert(result?.id === benchG, `expected bench G (${benchG}) promoted, got ${JSON.stringify(result)}`);
        }
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 2 — PPG fallback
  await runCase('Case 2 — PPG fallback', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!;
      const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
      const settings = await getLeagueSettings(league.league_id);

      // No submitted bench order — fallback to highest avg_ppg among G/F-eligible bench players.
      await withTempAvgPpg(
        [
          { player_id: benchF, avg_ppg: 18 },
          { player_id: benchG, avg_ppg: 15 },
          { player_id: benchC, avg_ppg: 12 },
        ],
        async () => {
          await withTeamEliminationStates(
            [{ team_id: await getPlayerTeamId(benchF), value: false }],
            async () => {
              const result = await BenchOrderService.resolveNext(
                league.league_id,
                league.commissioner_id,
                'G',
                settings.sub_eligibility_matrix
              );
              assert(
                result?.id === benchF,
                `expected bench F (${benchF}, 18ppg) promoted, got ${JSON.stringify(result)}`
              );
            }
          );
        }
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 3 — Skip bench player with eliminated team
  await runCase(
    'Case 3 — Skip bench player with eliminated team',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        const assigned = league.player_assignments.get(league.commissioner_id)!;
        const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
        const settings = await getLeagueSettings(league.league_id);

        await setSubmittedBenchOrder({
          league_id: league.league_id,
          user_id: league.commissioner_id,
          ordered_player_ids: [benchG, benchF, benchC],
        });

        await withTeamEliminationStates(
          [
            { team_id: await getPlayerTeamId(benchG), value: true },
            { team_id: await getPlayerTeamId(benchF), value: false },
          ],
          async () => {
            const result = await BenchOrderService.resolveNext(
              league.league_id,
              league.commissioner_id,
              'G',
              settings.sub_eligibility_matrix
            );
            assert(
              result?.id === benchF,
              `expected bench F (${benchF}) promoted (bench G's team eliminated), got ${JSON.stringify(result)}`
            );
          }
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    },
    "KNOWN FAILING marker in handoff doc references Bug #2 (BenchOrderService missing teams.is_eliminated " +
    'check) — fixed in Phase A. Expected to PASS here as a regression guard for that fix.'
  );

  // Case 4 — Skip already-released bench player
  await runCase('Case 4 — Skip already-released bench player', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!;
      const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
      const settings = await getLeagueSettings(league.league_id);

      await setSubmittedBenchOrder({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        ordered_player_ids: [benchG, benchF, benchC],
      });

      // Bench G already released mid-tournament (e.g. subbed out earlier).
      await db
        .from('roster_slots')
        .update({ is_active: false, released_at_round_stage: 'r64', release_reason: 'eliminated' })
        .eq('league_id', league.league_id)
        .eq('player_id', benchG);

      await withTeamEliminationStates(
        [{ team_id: await getPlayerTeamId(benchF), value: false }],
        async () => {
          const result = await BenchOrderService.resolveNext(
            league.league_id,
            league.commissioner_id,
            'G',
            settings.sub_eligibility_matrix
          );
          assert(
            result?.id === benchF,
            `expected bench F (${benchF}) promoted (bench G already released), got ${JSON.stringify(result)}`
          );
        }
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 5 — C slot isolation
  await runCase('Case 5 — C slot isolation', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!;
      const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
      const settings = await getLeagueSettings(league.league_id);

      // Submitted order [G, F, C] — only C is eligible for the open C slot, regardless of order/PPG.
      await setSubmittedBenchOrder({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        ordered_player_ids: [benchG, benchF, benchC],
      });

      await withTeamEliminationStates(
        [{ team_id: await getPlayerTeamId(benchC), value: false }],
        async () => {
          const result = await BenchOrderService.resolveNext(
            league.league_id,
            league.commissioner_id,
            'C',
            settings.sub_eligibility_matrix
          );
          assert(
            result?.id === benchC,
            `expected bench C (${benchC}) promoted regardless of order, got ${JSON.stringify(result)}`
          );
        }
      );
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 6 — No eligible bench player
  await runCase('Case 6 — No eligible bench player', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!;
      const [g1, , , , c1, , , benchC] = assigned; // G1, C1 (starters), B3 (bench C)
      const settings = await getLeagueSettings(league.league_id);

      // Seed a scoring_event so runForLeague() actually upserts a snapshot for this user
      // (_runForGamesInternal/_upsertSnapshot only run for "affected pairs" with eligible game_scores).
      const { data: gs, error: gsErr } = await db
        .from('game_scores')
        .upsert(
          {
            player_id: g1,
            season: 2026,
            round_stage: 'r64',
            round_number: 1,
            game_date: '2026-04-01',
            game_status: 'final',
            points: 10,
            source: 'manual',
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'player_id,round_stage,round_number,game_date' }
        )
        .select('id')
        .single();
      if (gsErr || !gs) throw new Error(`game_scores upsert failed: ${gsErr?.message}`);
      await ScoreAccumulator.runForGames([gs.id]);

      const before = await getActivePlayerCount(league.league_id, league.commissioner_id);
      assert(before === 8, `expected baseline active_player_count=8, got ${before}`);

      // "Open a C slot with no bench C available": release both the C starter and bench C.
      await db
        .from('roster_slots')
        .update({ is_active: false, released_at_round_stage: 'r64', release_reason: 'eliminated' })
        .eq('league_id', league.league_id)
        .eq('player_id', c1);
      await db
        .from('roster_slots')
        .update({ is_active: false, released_at_round_stage: 'r64', release_reason: 'eliminated' })
        .eq('league_id', league.league_id)
        .eq('player_id', benchC);

      const result = await BenchOrderService.resolveNext(
        league.league_id,
        league.commissioner_id,
        'C',
        settings.sub_eligibility_matrix
      );
      assert(result === null, `expected null (no eligible bench C), got ${JSON.stringify(result)}`);

      const stillBefore = await getActivePlayerCount(league.league_id, league.commissioner_id);
      assert(
        stillBefore === 8,
        `expected active_player_count still 8 before explicit accumulator call, got ${stillBefore}`
      );

      await ScoreAccumulator.runForLeague(league.league_id);

      const after = await getActivePlayerCount(league.league_id, league.commissioner_id);
      assert(after === 6, `expected active_player_count=6 after runForLeague, got ${after}`);
    } finally {
      await cleanupTestLeague(league.league_id);
    }
  });

  // Case 7 — Voided pick cleanup
  await runCase('Case 7 — Voided pick cleanup', async () => {
    const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
    try {
      const assigned = league.player_assignments.get(league.commissioner_id)!;
      const [benchG, benchF, benchC] = [assigned[5], assigned[6], assigned[7]];
      const settings = await getLeagueSettings(league.league_id);

      await setSubmittedBenchOrder({
        league_id: league.league_id,
        user_id: league.commissioner_id,
        ordered_player_ids: [benchG, benchF, benchC],
      });

      // Bench G's pick was voided (mirrors PATCH /api/commissioner/pick/void's release shape:
      // released_at_round_stage='draft', is_active=false, release_reason='correction').
      await db
        .from('roster_slots')
        .update({ is_active: false, released_at_round_stage: 'draft', release_reason: 'correction' })
        .eq('league_id', league.league_id)
        .eq('player_id', benchG);

      await withTeamEliminationStates(
        [{ team_id: await getPlayerTeamId(benchF), value: false }],
        async () => {
          const result = await BenchOrderService.resolveNext(
            league.league_id,
            league.commissioner_id,
            'G',
            settings.sub_eligibility_matrix
          );
          assert(
            result?.id === benchF,
            `expected bench F (${benchF}) promoted (bench G's pick was voided), got ${JSON.stringify(result)}`
          );
        }
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

async function getActivePlayerCount(league_id: string, user_id: string): Promise<number | null> {
  const { data, error } = await db
    .from('leaderboard_snapshots')
    .select('active_player_count')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .maybeSingle();
  if (error) throw new Error(`getActivePlayerCount failed: ${error.message}`);
  return data?.active_player_count ?? null;
}

main().catch((err) => {
  console.error('unit-bench-order-service: unhandled error:', err);
  process.exit(1);
});
