import '@/lib/utils/wsPolyfill';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { simulateRound } from './simulate-round';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
} from './utils/testHelpers';

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

const PLAYABLE_ROUND_STAGES = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];

interface Snapshot {
  user_id: string;
  total_points: number;
  round_stage: string;
  highest_single_game_points: number;
  active_player_count: number;
}

async function fetchSnapshots(league_id: string): Promise<Snapshot[]> {
  const { data, error } = await db
    .from('leaderboard_snapshots')
    .select('user_id, total_points, round_stage, highest_single_game_points, active_player_count')
    .eq('league_id', league_id);
  if (error) throw new Error(`leaderboard_snapshots query failed: ${error.message}`);
  return (data ?? []) as Snapshot[];
}

// ── Case ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  await runCase(
    'Full tournament: 10-member league through play_in -> r64 -> r32 -> s16 -> e8 -> f4 -> championship',
    async () => {
      const league = await createTestLeague({ memberCount: 10, activationTiming: 'immediate' });
      try {
        // Track each user's leaderboard_snapshots.round_stage index across rounds —
        // it must never regress, even though it can jump AHEAD of the round just run
        // (game_scores is a season-scoped shared fixture: players drafted here may
        // already have later-round game_scores from earlier scripts' test leagues,
        // e.g. simulate-round.ts's 24-member league drafts a superset of this
        // league's top-avg_ppg players and already ran r64/r32).
        const prevStageIdx = new Map<string, number>();

        for (const stage of PLAYABLE_ROUND_STAGES) {
          const result = await simulateRound({ league_id: league.league_id, round_stage: stage });
          const snaps = await fetchSnapshots(league.league_id);

          let maxIdx = -1;
          for (const snap of snaps) {
            const idx = ROUND_STAGE_ORDER.indexOf(snap.round_stage as RoundStage);
            assert(idx !== -1, `invalid round_stage "${snap.round_stage}" for user ${snap.user_id} after ${stage}`);
            const prev = prevStageIdx.get(snap.user_id);
            if (prev !== undefined) {
              assert(
                idx >= prev,
                `round_stage regressed for user ${snap.user_id}: index ${prev} (${ROUND_STAGE_ORDER[prev]}) before ${stage}, ` +
                `index ${idx} (${snap.round_stage}) after`
              );
            }
            prevStageIdx.set(snap.user_id, idx);
            maxIdx = Math.max(maxIdx, idx);
          }

          const totalPoints = snaps.reduce((sum, s) => sum + s.total_points, 0);
          console.log(
            `      [${stage}] eliminated ${result.eliminated_team_ids.length} teams, ` +
            `${snaps.length}/${league.member_ids.length} snapshots, ` +
            `league-wide max round_stage = ${maxIdx === -1 ? 'n/a' : ROUND_STAGE_ORDER[maxIdx]}, ` +
            `sum(total_points) = ${totalPoints}`
          );
        }

        // ── 1. Champion team is never eliminated ────────────────────────
        //
        // The champion is deterministic (see computeEliminationRounds in
        // testHelpers.ts): of the 4 regions' #1 seeds, the two from the
        // alphabetically-first 2 regions reach the final; the alphabetically-
        // later of those two is the runner-up (eliminated in 'championship'),
        // and the alphabetically-first region's #1 seed is the champion.
        const { data: regionRows, error: regionErr } = await db.from('teams').select('region').eq('season', 2026);
        if (regionErr) throw new Error(`teams region query failed: ${regionErr.message}`);
        const regions = [...new Set((regionRows ?? []).map((r) => r.region as string))].sort();
        assert(regions.length === 4, `expected 4 regions for season 2026, got ${regions.length}: ${JSON.stringify(regions)}`);

        const { data: championRow, error: champErr } = await db
          .from('teams')
          .select('id, name, seed, region, is_eliminated, eliminated_in_round_stage')
          .eq('season', 2026)
          .eq('region', regions[0])
          .eq('seed', 1)
          .single();
        if (champErr || !championRow) throw new Error(`champion team query failed: ${champErr?.message}`);

        assert(
          championRow.is_eliminated === false,
          `expected champion team (${championRow.name}, #${championRow.seed} ${championRow.region}) is_eliminated=false, got ${championRow.is_eliminated}`
        );
        assert(
          championRow.eliminated_in_round_stage === null,
          `expected champion team eliminated_in_round_stage=null, got "${championRow.eliminated_in_round_stage}"`
        );

        const { data: nonEliminated, error: nonElimErr } = await db
          .from('teams')
          .select('id, name, seed, region')
          .eq('season', 2026)
          .eq('is_eliminated', false);
        if (nonElimErr) throw new Error(`non-eliminated teams query failed: ${nonElimErr.message}`);
        assert(
          (nonEliminated ?? []).length === 1,
          `expected exactly 1 non-eliminated team after the championship round, got ${(nonEliminated ?? []).length}: ${JSON.stringify(nonEliminated)}`
        );
        assert(
          (nonEliminated ?? [])[0]?.id === championRow.id,
          `the sole non-eliminated team (${JSON.stringify((nonEliminated ?? [])[0])}) does not match the computed champion (${championRow.name})`
        );

        console.log(`\n      Champion: ${championRow.name} (#${championRow.seed} ${championRow.region}) — is_eliminated=false, eliminated_in_round_stage=null`);

        // ── 2. Champion team players' roster_slots: never released ──────
        const { data: champPlayers, error: cpErr } = await db
          .from('players')
          .select('id, name')
          .eq('team_id', championRow.id)
          .eq('season', 2026);
        if (cpErr) throw new Error(`champion players query failed: ${cpErr.message}`);
        const champPlayerIds = (champPlayers ?? []).map((p) => p.id as string);
        assert(champPlayerIds.length > 0, `expected at least 1 player on champion team ${championRow.name}, got 0`);

        const { data: champSlots, error: csErr } = await db
          .from('roster_slots')
          .select('user_id, player_id, slot_key, is_bench, is_active, acquired_at_round_stage, released_at_round_stage, release_reason')
          .eq('league_id', league.league_id)
          .in('player_id', champPlayerIds);
        if (csErr) throw new Error(`champion roster_slots query failed: ${csErr.message}`);

        if ((champSlots ?? []).length === 0) {
          console.log(`      Champion team players (${championRow.name}): none of this league's 10 members drafted a player from the champion team — roster_slots check N/A.`);
        } else {
          // Invariant for ANY champion-team player row: is_active=true implies
          // released_at_round_stage=null (the champion team was never eliminated,
          // so nothing of theirs is released for that reason).
          for (const s of champSlots ?? []) {
            if (s.is_active) {
              assert(
                s.released_at_round_stage === null,
                `champion team player slot is_active=true but released_at_round_stage="${s.released_at_round_stage}" (user=${s.user_id}, player=${s.player_id}, slot=${s.slot_key})`
              );
            }
          }

          // Stronger check for slots drafted as starters: since the champion team
          // is never in eliminated_team_ids for any round, these specific rows must
          // remain untouched (is_active=true, released_at_round_stage=null).
          const draftedStarters = (champSlots ?? []).filter((s) => !s.is_bench && s.acquired_at_round_stage === 'draft');
          for (const s of draftedStarters) {
            assert(
              s.is_active === true && s.released_at_round_stage === null,
              `champion team player drafted as starter (slot ${s.slot_key}, user=${s.user_id}) should remain ` +
              `is_active=true / released_at_round_stage=null since the champion is never eliminated, got ${JSON.stringify(s)}`
            );
          }

          console.log(
            `      Champion team players (${championRow.name}): ${(champSlots ?? []).length} roster_slots row(s) in this league, ` +
            `${draftedStarters.length} drafted-starter row(s) confirmed is_active=true / released_at_round_stage=null`
          );
        }

        // ── 3. highest_single_game_points populated on all snapshots ────
        const finalSnaps = await fetchSnapshots(league.league_id);
        assert(
          finalSnaps.length === league.member_ids.length,
          `expected ${league.member_ids.length} leaderboard_snapshots rows at tournament end, got ${finalSnaps.length}`
        );
        for (const snap of finalSnaps) {
          assert(
            snap.highest_single_game_points > 0,
            `expected highest_single_game_points > 0 for user ${snap.user_id}, got ${snap.highest_single_game_points}`
          );
        }
        console.log(`      highest_single_game_points populated (> 0) on all ${finalSnaps.length} leaderboard_snapshots rows`);

        // ── 4. Final leaderboard ─────────────────────────────────────────
        const { data: userRows, error: userErr } = await db.from('users').select('id, display_name').in('id', league.member_ids);
        if (userErr) throw new Error(`users query failed: ${userErr.message}`);
        const nameMap = new Map((userRows ?? []).map((u) => [u.id as string, u.display_name as string]));

        const sorted = [...finalSnaps].sort((a, b) => b.total_points - a.total_points);
        console.log('\n      ── Final Leaderboard ──');
        console.log('      Rank  Display Name                       Total  HighGame  RoundStage     Active');
        sorted.forEach((snap, i) => {
          const name = nameMap.get(snap.user_id) ?? snap.user_id;
          console.log(
            `      ${String(i + 1).padEnd(5)} ${name.padEnd(34)} ${String(snap.total_points).padEnd(6)} ` +
            `${String(snap.highest_single_game_points).padEnd(9)} ${snap.round_stage.padEnd(13)} ${snap.active_player_count}`
          );
        });
        console.log('');
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
  console.error('test-full-tournament: unhandled error:', err);
  process.exit(1);
});
