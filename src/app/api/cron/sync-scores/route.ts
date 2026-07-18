import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ESPNStatsProvider } from '@/lib/providers/stats/ESPNStatsProvider';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { RosterActivationService } from '@/lib/services/RosterActivationService';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { CURRENT_TOURNAMENT_SEASON } from '@/lib/constants/season';

const JOB_NAME = 'sync-scores';
const PLAYABLE_STAGES = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];

// The live ESPN feed only ever reflects the current tournament. Historical
// leagues (season < CURRENT_TOURNAMENT_SEASON) share players by espn_player_id
// with the current roster, so without this filter the sync would overwrite
// their completed game_scores with current-season data.

export async function GET(request: NextRequest) {
  // Auth: Vercel calls with Authorization: Bearer {CRON_SECRET}
  if (!process.env.CRON_SECRET) {
    console.error('[sync-scores] CRON_SECRET not configured');
    return NextResponse.json({ error: 'CRON_SECRET not configured' }, { status: 500 });
  }
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const instanceId = crypto.randomUUID();

  // Acquire cron lock (Section 3.18). No row returned = another instance holds a fresh lock.
  const { data: lockRows } = await supabaseAdmin.rpc('acquire_cron_lock', {
    p_job_name: JOB_NAME,
    p_instance_id: instanceId,
  });

  if (!lockRows || lockRows.length === 0) {
    return NextResponse.json({ skipped: true, reason: 'lock_held' });
  }

  let anyInProgress = false;

  try {
    // ----------------------------------------------------------------
    // Responsibility 1: Score Sync
    // ----------------------------------------------------------------
    const statsProvider = new ESPNStatsProvider();

    // The active season is always CURRENT_TOURNAMENT_SEASON — this used to be
    // inferred from whichever draft_sessions row was created most recently, but
    // every demo league provision (src/lib/utils/seedDemoData.ts) also creates a
    // "previous season" stub row *after* the real one purely to power a
    // season-switcher link in the UI. That stub's created_at is always the
    // latest, so it would silently hijack the sync into fetching/overwriting
    // scores for the WRONG season app-wide every time someone clicked
    // "Try as Commissioner" — a portfolio demo feature breaking live production
    // scoring is exactly the kind of bug worth naming: single source of truth
    // beats "infer it from whatever row happens to be newest."
    const season: number = CURRENT_TOURNAMENT_SEASON;

    // Collect all game status data across all playable round stages
    const allGameStatuses: Awaited<ReturnType<typeof statsProvider.getGameStatus>> = [];
    for (const stage of PLAYABLE_STAGES) {
      const statuses = await statsProvider.getGameStatus(season, stage);
      allGameStatuses.push(...statuses);
    }

    anyInProgress = allGameStatuses.some((g) => g.game_status === 'in_progress');

    // Resolve which of these players belong to the current tournament season —
    // historical players sharing an espn_player_id with a current player must
    // not have their (already-final) game_scores overwritten.
    const candidatePlayerIds = [...new Set(allGameStatuses.map((gs) => gs.player_id))];
    const { data: candidatePlayers } = await supabaseAdmin
      .from('players')
      .select('id, season')
      .in('id', candidatePlayerIds);

    const currentSeasonPlayerIds = new Set(
      (candidatePlayers ?? [])
        .filter((p) => p.season === CURRENT_TOURNAMENT_SEASON)
        .map((p) => p.id)
    );

    // Upsert game_scores for all returned statuses
    const upsertedGameScoreIds: string[] = [];
    for (const gs of allGameStatuses) {
      if (!currentSeasonPlayerIds.has(gs.player_id)) continue;

      const { data: upserted } = await supabaseAdmin
        .from('game_scores')
        .upsert(
          {
            player_id: gs.player_id,
            season,
            round_stage: gs.round_stage,
            round_number: gs.round_number,
            game_date: gs.game_date,
            game_status: gs.game_status,
            points: gs.points,
            source: 'espn_api',
            synced_at: new Date().toISOString(),
          },
          { onConflict: 'player_id,round_stage,round_number,game_date' }
        )
        .select('id');

      if (upserted) {
        for (const row of upserted) upsertedGameScoreIds.push(row.id);
      }
    }

    // Mark affected scoring_events stale before recomputing
    if (upsertedGameScoreIds.length > 0) {
      await supabaseAdmin
        .from('scoring_events')
        .update({ is_stale: true })
        .in('game_score_id', upsertedGameScoreIds);

      await ScoreAccumulator.runForGames(upsertedGameScoreIds);
    }

    // Detect newly eliminated teams and trigger immediate activation
    const eliminations = await statsProvider.getTeamEliminations(season);
    const newlyEliminated: string[] = [];

    for (const elim of eliminations) {
      if (!elim.is_eliminated || !elim.eliminated_in_round_stage) continue;

      const { data: existing } = await supabaseAdmin
        .from('teams')
        .select('id, is_eliminated')
        .eq('id', elim.team_id)
        .maybeSingle();

      if (!existing || existing.is_eliminated) continue; // Already marked or not found

      await supabaseAdmin
        .from('teams')
        .update({
          is_eliminated: true,
          eliminated_in_round_stage: elim.eliminated_in_round_stage,
        })
        .eq('id', elim.team_id);

      newlyEliminated.push(elim.team_id);
    }

    // Immediate activation for leagues that use real-time substitution
    if (newlyEliminated.length > 0) {
      const { data: immediateLeagues } = await supabaseAdmin
        .from('leagues')
        .select('id, settings')
        .neq('settings->activation_timing', 'end_of_round');

      // Filter in JS — Supabase JSON path filtering is not reliable across all versions
      const immediateLeagueIds = (immediateLeagues ?? [])
        .filter((l) => {
          const s = l.settings as { activation_timing?: string } | null;
          return !s?.activation_timing || s.activation_timing === 'immediate';
        })
        .map((l) => l.id);

      for (const teamId of newlyEliminated) {
        for (const leagueId of immediateLeagueIds) {
          await RosterActivationService.activateImmediate(leagueId, teamId);
        }
      }
    }

    // ----------------------------------------------------------------
    // Responsibility 2: Bench Lock Enforcement
    // ----------------------------------------------------------------
    const { data: sessionsToLock } = await supabaseAdmin
      .from('draft_sessions')
      .select('league_id, bench_lock_deadline')
      .not('bench_lock_deadline', 'is', null)
      .lt('bench_lock_deadline', new Date().toISOString());

    for (const session of (sessionsToLock ?? [])) {
      await supabaseAdmin
        .from('bench_orders')
        .update({ locked_at: session.bench_lock_deadline })
        .eq('league_id', session.league_id)
        .is('locked_at', null);
    }

    // ----------------------------------------------------------------
    // Responsibility 3: End-of-Round Detection (activation_timing = 'end_of_round')
    // ----------------------------------------------------------------
    // Find the current "active" round stage — highest stage with any non-final game_scores this season
    const { data: inProgressOrScheduled } = await supabaseAdmin
      .from('game_scores')
      .select('round_stage')
      .eq('season', season)
      .in('game_status', ['in_progress', 'scheduled'])
      .limit(1);

    // Also check for the most recently completed round (last stage with any final games)
    const { data: finalGames } = await supabaseAdmin
      .from('game_scores')
      .select('round_stage')
      .eq('season', season)
      .eq('game_status', 'final')
      .order('created_at', { ascending: false })
      .limit(1);

    if (!inProgressOrScheduled?.length && finalGames?.length) {
      // All games in the most recent round are final — check if it just completed
      const completedStage = finalGames[0].round_stage as RoundStage;
      const completedStageIdx = ROUND_STAGE_ORDER.indexOf(completedStage);
      if (completedStageIdx === -1) {
        // Not a known stage — skip
      } else {
        // Verify ALL game_scores for this stage and season are final
        const { count: totalCount } = await supabaseAdmin
          .from('game_scores')
          .select('*', { count: 'exact', head: true })
          .eq('season', season)
          .eq('round_stage', completedStage);

        const { count: finalCount } = await supabaseAdmin
          .from('game_scores')
          .select('*', { count: 'exact', head: true })
          .eq('season', season)
          .eq('round_stage', completedStage)
          .eq('game_status', 'final');

        if (totalCount && finalCount && totalCount === finalCount && totalCount > 0) {
          // Round is fully complete — batch-activate for end_of_round leagues
          const { data: endOfRoundLeagues } = await supabaseAdmin
            .from('leagues')
            .select('id, settings');

          const endOfRoundLeagueIds = (endOfRoundLeagues ?? [])
            .filter((l) => {
              const s = l.settings as { activation_timing?: string } | null;
              return s?.activation_timing === 'end_of_round';
            })
            .map((l) => l.id);

          if (endOfRoundLeagueIds.length > 0) {
            // Championship edge case: if championship completed, use 'championship' for sub stage
            const nextStage: string =
              completedStageIdx < ROUND_STAGE_ORDER.length - 1
                ? ROUND_STAGE_ORDER[completedStageIdx + 1]
                : 'championship';

            await RosterActivationService.activateBatch(endOfRoundLeagueIds, nextStage);
          }
        }
      }
    }
  } catch (error) {
    console.error('[sync-scores] Execution error:', error);
    // Release lock even on failure so the next run can proceed
    await supabaseAdmin
      .from('cron_locks')
      .delete()
      .eq('job_name', JOB_NAME)
      .eq('locked_by', instanceId);

    return NextResponse.json({ error: 'Sync failed', detail: String(error) }, { status: 500 });
  }

  // Release cron lock
  await supabaseAdmin
    .from('cron_locks')
    .delete()
    .eq('job_name', JOB_NAME)
    .eq('locked_by', instanceId);

  // Heartbeat: record the successful run so the commissioner page can show
  // "Scores last synced Xm ago" — a silently-dead cron (bad secret, scheduler
  // misconfig, provider returning nothing) is otherwise invisible until
  // someone wonders why standings stopped moving. Best-effort: a heartbeat
  // write failure must not fail the sync itself.
  try {
    await supabaseAdmin.from('sync_heartbeats').upsert(
      {
        job_name: JOB_NAME,
        last_success_at: new Date().toISOString(),
        last_result: { in_progress: anyInProgress },
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'job_name' }
    );
  } catch (err) {
    console.error('[sync-scores] heartbeat write failed:', err);
  }

  return NextResponse.json({ ok: true, in_progress: anyInProgress });
}
