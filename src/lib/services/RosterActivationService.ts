import { supabaseAdmin } from '@/lib/supabase/admin';
import { BenchOrderService } from './BenchOrderService';
import { ScoreAccumulator } from './ScoreAccumulator';
import type { LeagueSettings } from '@/lib/types';

const RETRY_DELAYS_MS = [1000, 4000, 16000];

// PostgREST/Kong enforce a request-line length limit, so .in() filters with large
// ID arrays must be chunked (same convention as ScoreAccumulator).
const IN_FILTER_CHUNK_SIZE = 100;

async function withRetry<T>(fn: () => Promise<T>, label: string): Promise<T | null> {
  for (let attempt = 0; attempt < RETRY_DELAYS_MS.length + 1; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt < RETRY_DELAYS_MS.length) {
        await new Promise((r) => setTimeout(r, RETRY_DELAYS_MS[attempt]));
      } else {
        console.error(`[RosterActivationService] ${label} failed after ${attempt + 1} attempts:`, err);
        return null;
      }
    }
  }
  return null;
}

/**
 * Activates the next eligible bench player for a released starter slot.
 * Returns the newly activated player_id or null.
 */
async function activateSlot(
  league_id: string,
  user_id: string,
  released_slot_id: string,
  slot_position: 'G' | 'F' | 'C',
  slot_key: string,
  current_round_stage: string,
  settings: LeagueSettings
): Promise<string | null> {
  const next_player = await BenchOrderService.resolveNext(
    league_id,
    user_id,
    slot_position,
    settings.sub_eligibility_matrix
  );

  if (!next_player) {
    console.warn(`[RosterActivationService] No eligible bench sub for ${user_id} in ${league_id} slot ${slot_key}`);
    return null;
  }

  // Release the bench slot for the incoming player
  await supabaseAdmin
    .from('roster_slots')
    .update({
      is_active: false,
      released_at_round_stage: current_round_stage,
      release_reason: 'eliminated',
    })
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .eq('player_id', next_player.id)
    .eq('is_bench', true)
    .eq('is_active', true)
    .is('released_at_round_stage', null);

  // Activate new starter slot inheriting the slot_key of the released slot
  await supabaseAdmin.from('roster_slots').insert({
    league_id,
    user_id,
    player_id: next_player.id,
    slot_key,
    slot_position,
    is_active: true,
    is_bench: false,
    acquired_at_round_stage: current_round_stage,
  });

  return next_player.id;
}

export const RosterActivationService = {
  /**
   * Immediate activation when a team is eliminated mid-round.
   * Only called when league.settings.activation_timing === 'immediate'.
   */
  async activateImmediate(league_id: string, eliminated_team_id: string): Promise<void> {
    const { data: leagueRow } = await supabaseAdmin
      .from('leagues')
      .select('settings')
      .eq('id', league_id)
      .single();

    if (!leagueRow) return;
    const settings = leagueRow.settings as LeagueSettings;

    // Determine current round stage from the eliminated team
    const { data: team } = await supabaseAdmin
      .from('teams')
      .select('eliminated_in_round_stage')
      .eq('id', eliminated_team_id)
      .single();

    const current_round_stage = team?.eliminated_in_round_stage ?? 'r64';

    // Find all players from the eliminated team who have active starter slots in this league
    const { data: eliminatedPlayers } = await supabaseAdmin
      .from('players')
      .select('id')
      .eq('team_id', eliminated_team_id);

    const eliminatedPlayerIds = (eliminatedPlayers ?? []).map((p: { id: string }) => p.id);
    if (eliminatedPlayerIds.length === 0) return;

    const { data: activeStarterSlots } = await supabaseAdmin
      .from('roster_slots')
      .select('id, user_id, slot_key, slot_position')
      .eq('league_id', league_id)
      .eq('is_active', true)
      .eq('is_bench', false)
      .is('released_at_round_stage', null)
      .in('player_id', eliminatedPlayerIds);

    for (const slot of (activeStarterSlots ?? [])) {
      // Mark the eliminated player's slot as released
      await supabaseAdmin
        .from('roster_slots')
        .update({
          is_active: false,
          released_at_round_stage: current_round_stage,
          release_reason: 'eliminated',
        })
        .eq('id', slot.id);

      const activated_player_id = await withRetry(
        () =>
          activateSlot(
            league_id,
            slot.user_id,
            slot.id,
            slot.slot_position as 'G' | 'F' | 'C',
            slot.slot_key,
            current_round_stage,
            settings
          ),
        `activateSlot league=${league_id} user=${slot.user_id} slot=${slot.slot_key}`
      );

      if (activated_player_id) {
        // Kick off score recompute for the newly active player (non-blocking)
        ScoreAccumulator.runForPlayer(activated_player_id, league_id).catch((err) =>
          console.error('[RosterActivationService] ScoreAccumulator.runForPlayer failed:', err)
        );
      }
    }
  },

  /**
   * Batch activation at round end — used when activation_timing === 'end_of_round'.
   * next_round_stage: the round that just started (e.g. 'r32' when r64 completed). Incoming
   * bench players are acquired at this stage so they score from the new round onwards.
   */
  async activateBatch(league_ids: string[], next_round_stage: string): Promise<void> {
    for (const league_id of league_ids) {
      const { data: leagueRow } = await supabaseAdmin
        .from('leagues')
        .select('settings, season')
        .eq('id', league_id)
        .single();

      if (!leagueRow) continue;
      const settings = leagueRow.settings as LeagueSettings;

      // For end_of_round leagues nothing releases eliminated starters mid-round
      // (activateImmediate only runs for 'immediate' leagues), so perform the
      // release here first: find active, unreleased starter slots whose player's
      // team is eliminated and release them exactly the way activateImmediate
      // does — released_at_round_stage is the team's actual elimination round
      // (not the batch's next_round_stage), so the elimination round itself
      // stops scoring per the strict `game < release` boundary.
      const { data: eliminatedTeams } = await supabaseAdmin
        .from('teams')
        .select('id, eliminated_in_round_stage')
        .eq('season', leagueRow.season)
        .eq('is_eliminated', true);

      const elimStageByTeamId = new Map<string, string | null>(
        (eliminatedTeams ?? []).map((t: { id: string; eliminated_in_round_stage: string | null }) => [
          t.id,
          t.eliminated_in_round_stage,
        ])
      );

      if (elimStageByTeamId.size > 0) {
        const { data: elimPlayers } = await supabaseAdmin
          .from('players')
          .select('id, team_id')
          .in('team_id', [...elimStageByTeamId.keys()]);

        const teamIdByPlayerId = new Map<string, string>(
          (elimPlayers ?? []).map((p: { id: string; team_id: string }) => [p.id, p.team_id])
        );
        const elimPlayerIds = [...teamIdByPlayerId.keys()];

        for (let i = 0; i < elimPlayerIds.length; i += IN_FILTER_CHUNK_SIZE) {
          const { data: unreleasedSlots } = await supabaseAdmin
            .from('roster_slots')
            .select('id, player_id')
            .eq('league_id', league_id)
            .eq('is_active', true)
            .eq('is_bench', false)
            .is('released_at_round_stage', null)
            .in('player_id', elimPlayerIds.slice(i, i + IN_FILTER_CHUNK_SIZE));

          for (const slot of (unreleasedSlots ?? [])) {
            const teamId = teamIdByPlayerId.get(slot.player_id);
            // Same fallback as activateImmediate's `?? 'r64'` when the
            // elimination round was never recorded.
            const released_at_round_stage =
              (teamId ? elimStageByTeamId.get(teamId) : null) ?? 'r64';

            await supabaseAdmin
              .from('roster_slots')
              .update({
                is_active: false,
                released_at_round_stage,
                release_reason: 'eliminated',
              })
              .eq('id', slot.id);
          }
        }
      }

      // Find all inactive starter slots (eliminated but not yet replaced) in this league
      const { data: releasedSlots } = await supabaseAdmin
        .from('roster_slots')
        .select('id, user_id, slot_key, slot_position, released_at_round_stage')
        .eq('league_id', league_id)
        .eq('is_active', false)
        .eq('is_bench', false)
        .eq('release_reason', 'eliminated')
        .not('released_at_round_stage', 'is', null);

      // Find which of those don't have a replacement yet (no active slot for the same slot_key)
      for (const slot of (releasedSlots ?? [])) {
        const { data: existingActive } = await supabaseAdmin
          .from('roster_slots')
          .select('id')
          .eq('league_id', league_id)
          .eq('user_id', slot.user_id)
          .eq('slot_key', slot.slot_key)
          .eq('is_active', true)
          .is('released_at_round_stage', null)
          .maybeSingle();

        if (existingActive) continue; // Already replaced

        const activated_player_id = await withRetry(
          () =>
            activateSlot(
              league_id,
              slot.user_id,
              slot.id,
              slot.slot_position as 'G' | 'F' | 'C',
              slot.slot_key,
              next_round_stage,
              settings
            ),
          `activateBatch league=${league_id} user=${slot.user_id} slot=${slot.slot_key}`
        );

        if (activated_player_id) {
          ScoreAccumulator.runForPlayer(activated_player_id, league_id).catch((err) =>
            console.error('[RosterActivationService] ScoreAccumulator.runForPlayer failed:', err)
          );
        }
      }
    }
  },
};
