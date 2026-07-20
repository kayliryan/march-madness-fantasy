import '@/lib/utils/wsPolyfill';
import { DemoProvisioningService } from '@/lib/services/DemoProvisioningService';
import { groupAndMergeSlots, type MergeableSlot } from '@/lib/utils/mergePlayerRounds';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { db, assert, cleanupTestLeague } from './utils/testHelpers';

/**
 * End-to-end regression test for the demo round-by-round scoring model.
 *
 * Provisions a real demo league (DemoProvisioningService.provision → seedDemoLeagueData),
 * picks one member, and for EVERY drafted player asserts the merged display
 * (groupAndMergeSlots + getRoundCell) satisfies the correctness model:
 *
 *   - E (team elimination) is derived from the player's team's REAL game_scores
 *     (source='espn_api'); the round they lost.
 *   - Every round strictly AFTER E renders 'elim' — never a "counted 0" masquerading
 *     as the player still playing (the original screenshot bug).
 *   - The loss round E itself is 'counted' for a player who was an active STARTER
 *     that round (the elimination game scores).
 *   - Bench rounds before a promotion render 'raw' (struck), never counted.
 *   - Each player's counted-total equals the sum of their real game_scores over the
 *     rounds they were an active starter — no more, no less.
 *
 * Run: npx tsx --env-file=.env.local scripts/test/regression-demo-scoring.ts
 */

const STAGES = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];
const idx = (s: string) => ROUND_STAGE_ORDER.indexOf(s as RoundStage);

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

interface SlotRow {
  id: string;
  user_id: string;
  player_id: string;
  is_bench: boolean;
  is_active: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
  release_reason: string | null;
  slot_key: string;
}

async function main(): Promise<void> {
  // Create a throwaway commissioner auth user.
  const { data: userData, error: userErr } = await db.auth.admin.createUser({
    email: `demo-scoring-${Date.now()}@test.invalid`,
    password: 'testpassword123',
    email_confirm: true,
  });
  if (userErr || !userData.user) throw new Error(`createUser failed: ${userErr?.message}`);
  const commissionerId = userData.user.id;

  let leagueId: string | null = null;
  try {
    const { league_id } = await DemoProvisioningService.provision(commissionerId);
    leagueId = league_id;

    // Load all roster_slots for the league.
    const { data: slotRows, error: slotErr } = await db
      .from('roster_slots')
      .select('id, user_id, player_id, is_bench, is_active, acquired_at_round_stage, released_at_round_stage, release_reason, slot_key')
      .eq('league_id', league_id);
    if (slotErr) throw new Error(`roster_slots read failed: ${slotErr.message}`);
    const slots = (slotRows ?? []) as SlotRow[];
    assert(slots.length > 0, 'expected roster_slots to be seeded');

    // Player -> team_id (real players).
    const playerIds = [...new Set(slots.map((s) => s.player_id))];
    const teamByPlayer = new Map<string, string>();
    for (let i = 0; i < playerIds.length; i += 100) {
      const { data, error } = await db
        .from('players')
        .select('id, team_id')
        .in('id', playerIds.slice(i, i + 100));
      if (error) throw new Error(`players read failed: ${error.message}`);
      for (const p of data ?? []) teamByPlayer.set(p.id as string, p.team_id as string);
    }

    // Real (espn_api) game_scores for every rostered player, keyed by player then round.
    const rawByPlayer = new Map<string, Map<string, number>>();
    for (let i = 0; i < playerIds.length; i += 100) {
      const { data, error } = await db
        .from('game_scores')
        .select('player_id, round_stage, points')
        .eq('season', 2026)
        .eq('source', 'espn_api')
        .in('player_id', playerIds.slice(i, i + 100));
      if (error) throw new Error(`game_scores read failed: ${error.message}`);
      for (const g of data ?? []) {
        const pid = g.player_id as string;
        if (!rawByPlayer.has(pid)) rawByPlayer.set(pid, new Map());
        rawByPlayer.get(pid)!.set(g.round_stage as string, g.points as number);
      }
    }

    // Team E = last (highest-ordered) round ANY of the team's players (rostered or
    // not) has a real espn_api game — this MUST match the seed's derivation, which
    // scans all real-team players, not just the ones this draft happened to pick.
    const { data: realTeamRows, error: rtErr } = await db
      .from('teams')
      .select('id, espn_team_id')
      .eq('season', 2026);
    if (rtErr) throw new Error(`teams read failed: ${rtErr.message}`);
    const realTeamIds = new Set((realTeamRows ?? []).filter((t) => t.espn_team_id != null).map((t) => t.id as string));

    const { data: allPlayers, error: apErr } = await db
      .from('players')
      .select('id, team_id')
      .eq('season', 2026);
    if (apErr) throw new Error(`players read failed: ${apErr.message}`);
    const teamOfAny = new Map((allPlayers ?? []).map((p) => [p.id as string, p.team_id as string]));

    const teamMaxIdx = new Map<string, number>();
    for (let from = 0; ; from += 1000) {
      const { data, error } = await db
        .from('game_scores')
        .select('player_id, round_stage')
        .eq('season', 2026)
        .eq('source', 'espn_api')
        .range(from, from + 999);
      if (error) throw new Error(`game_scores (team E) read failed: ${error.message}`);
      if (!data || data.length === 0) break;
      for (const g of data) {
        const teamId = teamOfAny.get(g.player_id as string);
        if (!teamId || !realTeamIds.has(teamId)) continue;
        const i = idx(g.round_stage as string);
        if (i > (teamMaxIdx.get(teamId) ?? -1)) teamMaxIdx.set(teamId, i);
      }
      if (data.length < 1000) break;
    }

    const teamElim = new Map<string, RoundStage | null>();
    const CHAMP = idx('championship');
    for (const [teamId, maxIdx] of teamMaxIdx) {
      teamElim.set(teamId, maxIdx >= CHAMP ? null : (ROUND_STAGE_ORDER[maxIdx] as RoundStage));
    }

    // scoring_events -> counted points keyed by roster_slot_id.
    const countedBySlot = new Map<string, Map<string, number>>();
    const { data: events, error: evErr } = await db
      .from('scoring_events')
      .select('roster_slot_id, round_stage, points_credited')
      .eq('league_id', league_id)
      .eq('is_stale', false);
    if (evErr) throw new Error(`scoring_events read failed: ${evErr.message}`);
    for (const e of events ?? []) {
      const sid = e.roster_slot_id as string | null;
      if (!sid) continue;
      if (!countedBySlot.has(sid)) countedBySlot.set(sid, new Map());
      countedBySlot.get(sid)!.set(e.round_stage as string, e.points_credited as number);
    }

    // Verify EVERY member's roster (exercises bench promotions across the league).
    type TestSlot = MergeableSlot & { player_id: string; slot_key: string };
    const userIds = [...new Set(slots.map((s) => s.user_id))];

    let checkedPlayers = 0;
    let checkedPostElim = 0;
    let checkedLossRound = 0;
    let checkedBenchRaw = 0;
    let checkedPromotions = 0;

    for (const targetUser of userIds) {
      const userSlots = slots.filter((s) => s.user_id === targetUser);
      const mergeable: TestSlot[] = userSlots.map((s) => ({
        player_id: s.player_id,
        slot_key: s.slot_key,
        is_bench: s.is_bench,
        is_active: s.is_active,
        acquired_at_round_stage: s.acquired_at_round_stage,
        released_at_round_stage: s.released_at_round_stage,
        release_reason: s.release_reason,
        counted_pts: Object.fromEntries(countedBySlot.get(s.id) ?? new Map()),
        raw_pts: Object.fromEntries(rawByPlayer.get(s.player_id) ?? new Map()),
      }));

      const merged = groupAndMergeSlots(mergeable, STAGES);
      assert(merged.length > 0, `expected merged player rows for user ${targetUser.slice(0, 8)}`);
      checkedPlayers += merged.length;

      for (const row of merged) {
        const teamId = teamByPlayer.get(row.player_id)!;
        const E = teamElim.get(teamId) ?? null;
        const realGames = rawByPlayer.get(row.player_id) ?? new Map<string, number>();
        const playerSlots = userSlots.filter((s) => s.player_id === row.player_id);
        const label = `player ${row.player_id.slice(0, 8)} (E=${E ?? 'none'})`;

        // (2) No "counted 0" masquerade after real elimination — every round strictly
        //     after E is 'elim'.
        if (E !== null) {
          for (const stage of STAGES) {
            if (idx(stage) > idx(E)) {
              const c = row.cells[stage];
              assert(
                c?.kind === 'elim',
                `${label}: round ${stage} after elimination must be 'elim', got ${JSON.stringify(c)}`
              );
              checkedPostElim++;
            }
          }
        }

        // (3) Loss round counted for a player who was an active STARTER at E.
        const starterAtE =
          E !== null &&
          playerSlots.some(
            (s) => !s.is_bench && idx(s.acquired_at_round_stage) <= idx(E) &&
              (s.released_at_round_stage === E || s.released_at_round_stage === null)
          );
        if (starterAtE) {
          const c = row.cells[E!];
          assert(
            c?.kind === 'counted',
            `${label}: loss round ${E} must be 'counted' for an active starter, got ${JSON.stringify(c)}`
          );
          checkedLossRound++;
        }

        // (4) Bench rounds strictly before a promotion render 'raw'/null, never counted.
        if (row.had_bench_stint && row.promoted_at_round_stage) {
          checkedPromotions++;
          const P = row.promoted_at_round_stage;
          for (const stage of STAGES) {
            if (idx(stage) < idx(P) && idx(stage) >= idx('r64')) {
              const c = row.cells[stage];
              assert(
                c === null || c.kind === 'raw',
                `${label}: pre-promotion round ${stage} must be 'raw'/null, got ${JSON.stringify(c)}`
              );
              if (c?.kind === 'raw') checkedBenchRaw++;
            }
          }
          // The promotion round onward, up to the promoted player's own E, must be counted.
          const pE = E;
          if (pE === null || idx(pE) >= idx(P)) {
            const c = row.cells[P];
            assert(
              c?.kind === 'counted',
              `${label}: promotion round ${P} must be 'counted', got ${JSON.stringify(c)}`
            );
          }
        }

        // (5) counted-total == sum of real game points over the rounds the player was an
        //     active starter (inclusive of the elimination/loss round).
        let expectedTotal = 0;
        for (const s of playerSlots) {
          if (s.is_bench) continue;
          const acqI = idx(s.acquired_at_round_stage);
          const relI = s.released_at_round_stage ? idx(s.released_at_round_stage) : ROUND_STAGE_ORDER.length;
          for (const stage of STAGES) {
            const si = idx(stage);
            if (si >= acqI && si <= relI) {
              expectedTotal += realGames.get(stage) ?? 0;
            }
          }
        }
        assert(
          row.total === expectedTotal,
          `${label}: counted-total ${row.total} != sum of real starter-round game points ${expectedTotal}`
        );
      }
    }

    console.log(
      `      ${userIds.length} members, ${checkedPlayers} players; post-elim cells=${checkedPostElim}, ` +
      `loss-round-counted=${checkedLossRound}, promotions=${checkedPromotions}, bench-raw=${checkedBenchRaw}`
    );
    assert(checkedPostElim > 0, 'expected at least one post-elimination round to verify (no eliminations found?)');
    assert(checkedLossRound > 0, 'expected at least one active-starter elimination (loss round) to verify');
    // Promotions are provision-dependent: the survival-ordered draft makes a user's
    // own bench generally shorter-lived than their starters, so promotions only arise
    // cross-position and may legitimately be 0 in a given shuffle. When they DO occur
    // the per-row checks above verify the 'substituted' model; the deterministic
    // promotion path is additionally covered by unit-merge-player-rounds.ts and
    // unit-round-cell-semantics.ts. So we don't hard-require > 0 here.
  } finally {
    if (leagueId) await cleanupTestLeague(leagueId);
    await db.auth.admin.deleteUser(commissionerId);
  }
}

async function run(): Promise<void> {
  await runCase('Demo scoring model holds for every drafted player', main);

  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);
  if (failed > 0) process.exit(1);
}

run().catch((err) => {
  console.error('regression-demo-scoring: unhandled error:', err);
  process.exit(1);
});
