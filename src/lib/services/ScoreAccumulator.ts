import { supabaseAdmin } from '@/lib/supabase/client';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { GameScore, LeagueSettings } from '@/lib/types';

// PostgREST/Kong enforce a request-line length limit, so .in() filters with large
// ID arrays (e.g. a full-season game_scores lookup) must be chunked.
const IN_FILTER_CHUNK_SIZE = 100;

export const ScoreAccumulator = {
  /**
   * Recomputes scoring_events and leaderboard_snapshots for the given game_score IDs.
   * Idempotent — safe to call multiple times for the same IDs.
   * Does NOT advance leaderboard_snapshots.round_stage (use runForLeague for full-round completion).
   */
  async runForGames(game_score_ids: string[]): Promise<void> {
    await this._runForGamesInternal(game_score_ids, false);
  },

  async _runForGamesInternal(game_score_ids: string[], updateRoundStage: boolean): Promise<void> {
    if (game_score_ids.length === 0) return;

    const gameScores: GameScore[] = [];
    for (let i = 0; i < game_score_ids.length; i += IN_FILTER_CHUNK_SIZE) {
      const { data } = await supabaseAdmin
        .from('game_scores')
        .select('*')
        .in('id', game_score_ids.slice(i, i + IN_FILTER_CHUNK_SIZE));
      if (data) gameScores.push(...data);
    }

    if (!gameScores.length) return;

    // Track which (league_id, user_id) pairs need snapshot updates
    const affectedPairs = new Set<string>();

    for (const game of gameScores) {
      const gameStageIdx = ROUND_STAGE_ORDER.indexOf(game.round_stage as RoundStage);
      if (gameStageIdx === -1) continue;

      // Find all roster_slots for this player across all leagues
      const { data: slots } = await supabaseAdmin
        .from('roster_slots')
        .select('id, league_id, user_id, acquired_at_round_stage, released_at_round_stage')
        .eq('player_id', game.player_id);

      for (const slot of (slots ?? [])) {
        const acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
        if (acqIdx === -1) continue;

        // released_at_round_stage null = still active, treat as after the last round.
        // If the value is set but not a known stage (indexOf=-1, e.g. a data error or future stage),
        // treat as immediately released (relIdx=0) so the slot never scores — explicit rather
        // than relying on gameStageIdx < -1 being accidentally false.
        let relIdx: number;
        if (!slot.released_at_round_stage) {
          relIdx = ROUND_STAGE_ORDER.length;
        } else {
          const rawRelIdx = ROUND_STAGE_ORDER.indexOf(slot.released_at_round_stage as RoundStage);
          relIdx = rawRelIdx === -1 ? 0 : rawRelIdx;
        }

        // Player must have been active during this game: acquired at or before game, released after
        if (!(acqIdx <= gameStageIdx && gameStageIdx < relIdx)) continue;

        // Check league settings for play_in scoring
        if (game.round_stage === 'play_in') {
          const { data: leagueRow } = await supabaseAdmin
            .from('leagues')
            .select('settings')
            .eq('id', slot.league_id)
            .single();

          const settings = leagueRow?.settings as LeagueSettings | undefined;
          if (settings && !settings.scoring_includes_play_in) continue;
        }

        // Upsert scoring_event (unique on game_score_id + league_id + user_id)
        await supabaseAdmin
          .from('scoring_events')
          .upsert(
            {
              league_id: slot.league_id,
              user_id: slot.user_id,
              player_id: game.player_id,
              game_score_id: game.id,
              round_stage: game.round_stage,
              points_credited: game.points,
              roster_slot_id: slot.id,
              is_stale: false,
            },
            { onConflict: 'game_score_id,league_id,user_id' }
          );

        affectedPairs.add(`${slot.league_id}:${slot.user_id}`);
      }
    }

    // Update leaderboard_snapshots for all affected users.
    // round_stage only advances on full-league recomputes, not incremental game runs.
    for (const key of affectedPairs) {
      const [league_id, user_id] = key.split(':');
      await this._upsertSnapshot(league_id, user_id, updateRoundStage);
    }
  },

  /**
   * Full recompute for a league — used when scoring-affecting settings change.
   * Clears existing scoring_events and rebuilds from game_scores.
   * runForLeague() always performs a full recompute regardless of is_stale.
   */
  async runForLeague(league_id: string): Promise<void> {
    // Mark all existing events stale so "updating" banner shows immediately
    await supabaseAdmin
      .from('scoring_events')
      .update({ is_stale: true })
      .eq('league_id', league_id);

    // Get all unique player_ids that have ever been in this league
    const { data: slots } = await supabaseAdmin
      .from('roster_slots')
      .select('player_id')
      .eq('league_id', league_id);

    const playerIds = [...new Set((slots ?? []).map((s: { player_id: string }) => s.player_id))];
    if (playerIds.length === 0) return;

    // Delete existing events for clean recompute
    await supabaseAdmin
      .from('scoring_events')
      .delete()
      .eq('league_id', league_id);

    // Find all game_scores for these players
    const { data: gameScores } = await supabaseAdmin
      .from('game_scores')
      .select('id')
      .in('player_id', playerIds);

    const ids = (gameScores ?? []).map((g: { id: string }) => g.id);
    // runForLeague is a full recompute — allow round_stage to advance in the snapshot
    await this._runForGamesInternal(ids, true);
  },

  /**
   * Recomputes scoring for a single player in a single league.
   * Used after roster activation (bench sub comes online).
   */
  async runForPlayer(player_id: string, league_id: string): Promise<void> {
    const { data: gameScores } = await supabaseAdmin
      .from('game_scores')
      .select('id')
      .eq('player_id', player_id);

    const ids = (gameScores ?? []).map((g: { id: string }) => g.id);
    await this.runForGames(ids);
  },

  async _upsertSnapshot(league_id: string, user_id: string, updateRoundStage: boolean): Promise<void> {
    const { data: events } = await supabaseAdmin
      .from('scoring_events')
      .select('points_credited, round_stage')
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .eq('is_stale', false);

    const evts = events ?? [];
    const total_points = evts.reduce((sum: number, e: { points_credited: number }) => sum + (e.points_credited ?? 0), 0);
    const highest_single_game_points = evts.reduce((max: number, e: { points_credited: number }) => Math.max(max, e.points_credited ?? 0), 0);

    const { count: active_player_count } = await supabaseAdmin
      .from('roster_slots')
      .select('*', { count: 'exact', head: true })
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .eq('is_active', true)
      .is('released_at_round_stage', null);

    // round_stage is NOT NULL in the schema — always required.
    // On full recomputes (updateRoundStage=true): derive from max scoring event stage.
    // On incremental runs: read the existing snapshot stage to avoid advancing the marker
    // mid-round (partial-round corrections should not change the round_stage).
    let round_stage: RoundStage = 'draft';

    if (updateRoundStage) {
      const stages = evts
        .map((e: { round_stage: string }) => e.round_stage)
        .filter((s: string) => ROUND_STAGE_ORDER.includes(s as RoundStage)) as RoundStage[];

      if (stages.length > 0) {
        round_stage = stages.reduce((max, s) =>
          ROUND_STAGE_ORDER.indexOf(s) > ROUND_STAGE_ORDER.indexOf(max) ? s : max
        );
      }
    } else {
      // Preserve the existing snapshot's round_stage; fall back to 'draft' for new rows
      const { data: existing } = await supabaseAdmin
        .from('leaderboard_snapshots')
        .select('round_stage')
        .eq('league_id', league_id)
        .eq('user_id', user_id)
        .maybeSingle();
      if (existing?.round_stage && ROUND_STAGE_ORDER.includes(existing.round_stage as RoundStage)) {
        round_stage = existing.round_stage as RoundStage;
      }
    }

    await supabaseAdmin
      .from('leaderboard_snapshots')
      .upsert(
        {
          league_id,
          user_id,
          total_points,
          active_player_count: active_player_count ?? 0,
          highest_single_game_points,
          round_stage,
          last_computed_at: new Date().toISOString(),
        },
        { onConflict: 'league_id,user_id' }
      );
  },
};
