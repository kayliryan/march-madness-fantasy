/**
 * Idempotent correction of teams.is_eliminated / eliminated_in_round_stage for the
 * REAL 2026 season, derived ONLY from real game_scores.
 *
 * Usage: npx tsx --env-file=.env.local scripts/fix-team-eliminations-2026.ts
 *
 * WHY THIS EXISTS
 * ---------------
 * The season-2026 teams table is SHARED (game_scores has no league_id; every demo
 * league drafts from the same global player/team pool). An earlier version of the
 * demo seed ran a RANDOM bracket simulation and overwrote each team's
 * eliminated_in_round_stage with the sim result — corrupting the global rows so they
 * disagreed with the real per-round scores that are actually displayed. This script
 * recomputes the truth and is safe to re-run.
 *
 * THE RULE (the oracle)
 * ---------------------
 * E (a team's elimination round) = the last (highest ROUND_STAGE_ORDER) round_stage
 * in which ANY of that team's players has a real game_scores row — the round they lost.
 *   - Non-finalists: is_eliminated = true, eliminated_in_round_stage = E.
 *   - Both championship finalists reach 'championship'. The CHAMPION is the finalist
 *     with the higher total championship game_scores points →
 *       is_eliminated = false, eliminated_in_round_stage = null.
 *     The runner-up → is_eliminated = true, eliminated_in_round_stage = 'championship'.
 *     If the two finalists' championship totals tie (truly ambiguous), BOTH are left
 *     with is_eliminated = false / null — acceptable since neither should show an Elim
 *     cell, and we never fabricate a winner.
 *
 * SCOPING: only real ESPN teams (teams.espn_team_id is not null) and only the
 * authoritative ESPN feed (game_scores.source = 'espn_api'). This excludes the
 * imported "Historical" family league AND any 'manual' rows (uncleaned test
 * fixtures on the shared season). In prod, real 2026 teams have only espn_api
 * rows, so the source filter is a no-op there and a corruption guard locally.
 *
 * EQUIVALENT SQL TO REPLAY ON PROD (idempotent):
 *
 *   with elig as (   -- real ESPN teams + authoritative feed only
 *     select gs.round_stage, gs.points, p.team_id
 *     from game_scores gs
 *     join players p on p.id = gs.player_id
 *     join teams t on t.id = p.team_id
 *     where gs.season = 2026 and gs.source = 'espn_api' and t.espn_team_id is not null
 *   ),
 *   team_max as (
 *     select team_id,
 *            max(array_position(
 *              array['draft','play_in','r64','r32','s16','e8','f4','championship'],
 *              round_stage)) as max_idx
 *     from elig group by team_id
 *   ),
 *   champ_pts as (   -- total championship points per finalist
 *     select team_id, sum(points) as pts
 *     from elig where round_stage = 'championship' group by team_id
 *   ),
 *   champion as (    -- single highest-scoring finalist; null on a tie
 *     select team_id from champ_pts order by pts desc limit 1
 *   )
 *   update teams t set
 *     is_eliminated = case
 *        when tm.max_idx >= array_position(array['draft','play_in','r64','r32','s16','e8','f4','championship'],'championship')
 *             and t.id = (select team_id from champion) then false
 *        when tm.max_idx is null then false
 *        else true end,
 *     eliminated_in_round_stage = case
 *        when tm.max_idx >= array_position(array['draft','play_in','r64','r32','s16','e8','f4','championship'],'championship')
 *             and t.id = (select team_id from champion) then null
 *        when tm.max_idx is null then null
 *        else (array['draft','play_in','r64','r32','s16','e8','f4','championship'])[tm.max_idx] end
 *   from team_max tm
 *   where tm.team_id = t.id and t.season = 2026 and t.espn_team_id is not null;
 *
 * (The TypeScript below does exactly this, plus the tie guard, and prints a summary.)
 */

import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);
const SEASON = 2026;
const CHAMPIONSHIP_IDX = ROUND_STAGE_ORDER.indexOf('championship');

async function main(): Promise<void> {
  // 0. real tournament teams only — teams carry an espn_team_id; the shared season
  //    also holds an imported "Historical" family league (espn_team_id null) that we
  //    leave untouched (it isn't part of the real ESPN bracket and its is_eliminated
  //    was set by its own import).
  const { data: allTeams0, error: t0Err } = await db
    .from('teams')
    .select('id, espn_team_id')
    .eq('season', SEASON);
  if (t0Err) throw new Error(`teams read failed: ${t0Err.message}`);
  const realTeamIds = new Set((allTeams0 ?? []).filter((t) => t.espn_team_id != null).map((t) => t.id as string));

  // 1. players → team map (real teams only)
  const { data: players, error: pErr } = await db
    .from('players')
    .select('id, team_id')
    .eq('season', SEASON);
  if (pErr) throw new Error(`players read failed: ${pErr.message}`);
  const playerTeam = new Map(
    (players ?? []).filter((p) => realTeamIds.has(p.team_id as string)).map((p) => [p.id as string, p.team_id as string])
  );

  // 2. real ESPN game_scores (paginated — dataset exceeds the 1000-row default).
  //    source='espn_api' pins to the authoritative feed and ignores any 'manual'
  //    rows (test-harness fixtures on the shared season that are never cleaned up).
  type GS = { player_id: string; round_stage: string; points: number };
  const gameScores: GS[] = [];
  const PAGE = 1000;
  for (let from = 0; ; from += PAGE) {
    const { data, error } = await db
      .from('game_scores')
      .select('player_id, round_stage, points')
      .eq('season', SEASON)
      .eq('source', 'espn_api')
      .range(from, from + PAGE - 1);
    if (error) throw new Error(`game_scores read failed: ${error.message}`);
    if (!data || data.length === 0) break;
    gameScores.push(...(data as GS[]));
    if (data.length < PAGE) break;
  }
  console.log(`Read ${realTeamIds.size} real teams, ${playerTeam.size} players, ${gameScores.length} espn_api game_scores for season ${SEASON}.`);

  // 3. per-team last round + championship points
  const teamMaxIdx = new Map<string, number>();
  const teamChampPts = new Map<string, number>();
  for (const gs of gameScores) {
    const teamId = playerTeam.get(gs.player_id);
    if (!teamId) continue;
    const idx = ROUND_STAGE_ORDER.indexOf(gs.round_stage as RoundStage);
    if (idx === -1) continue;
    if (idx > (teamMaxIdx.get(teamId) ?? -1)) teamMaxIdx.set(teamId, idx);
    if (idx === CHAMPIONSHIP_IDX) {
      teamChampPts.set(teamId, (teamChampPts.get(teamId) ?? 0) + (gs.points ?? 0));
    }
  }

  // 4. champion = the single highest-scoring finalist; null on a tie
  const finalists = [...teamChampPts.entries()].sort((a, b) => b[1] - a[1]);
  let championTeamId: string | null = null;
  if (finalists.length >= 1) {
    const tie = finalists.length >= 2 && finalists[0][1] === finalists[1][1];
    if (!tie) championTeamId = finalists[0][0];
  }

  // 5. current teams (real ESPN teams only — Historical family teams left untouched)
  const { data: teams, error: tErr } = await db
    .from('teams')
    .select('id, name, is_eliminated, eliminated_in_round_stage, espn_team_id')
    .eq('season', SEASON);
  if (tErr) throw new Error(`teams read failed: ${tErr.message}`);

  let updated = 0;
  let unchanged = 0;
  const changes: string[] = [];

  for (const t of teams ?? []) {
    if (!realTeamIds.has(t.id as string)) continue; // skip Historical/imported teams
    const maxIdx = teamMaxIdx.get(t.id as string);
    let is_eliminated: boolean;
    let elim: RoundStage | null;

    if (maxIdx === undefined) {
      // No games at all — treat as never eliminated (degenerate; shouldn't happen for 2026).
      is_eliminated = false;
      elim = null;
    } else if (maxIdx >= CHAMPIONSHIP_IDX) {
      // Reached the final. Champion (or ambiguous tie) → not eliminated; runner-up → eliminated at championship.
      if (championTeamId === null || t.id === championTeamId) {
        is_eliminated = false;
        elim = null;
      } else {
        is_eliminated = true;
        elim = 'championship';
      }
    } else {
      is_eliminated = true;
      elim = ROUND_STAGE_ORDER[maxIdx] as RoundStage;
    }

    const curElim = (t.eliminated_in_round_stage as string | null) ?? null;
    if (t.is_eliminated === is_eliminated && curElim === elim) {
      unchanged++;
      continue;
    }

    const { error: uErr } = await db
      .from('teams')
      .update({ is_eliminated, eliminated_in_round_stage: elim })
      .eq('id', t.id);
    if (uErr) throw new Error(`teams update failed for ${t.id}: ${uErr.message}`);
    updated++;
    changes.push(`  ${t.name}: ${t.is_eliminated}/${curElim ?? 'null'} → ${is_eliminated}/${elim ?? 'null'}`);
  }

  console.log(`\nChampion: ${championTeamId ?? '(ambiguous tie — both finalists left un-eliminated)'}`);
  console.log(`Updated ${updated} team(s), ${unchanged} already correct.`);
  if (changes.length) console.log('Changes:\n' + changes.join('\n'));
}

main().catch((err) => {
  console.error('fix-team-eliminations-2026: unhandled error:', err);
  process.exit(1);
});
