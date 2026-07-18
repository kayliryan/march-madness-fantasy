import { supabaseAdmin } from '@/lib/supabase/admin';
import { getLeaguePositionOverrides, resolvePosition } from '@/lib/services/PlayerPositionOverrides';
import type { LeagueSettings, Player } from '@/lib/types';

/**
 * Resolves the next bench player to activate for an open starter slot.
 * Algorithm (Section 5.4):
 *   1. Load user's bench_order for the league.
 *   2. Filter bench_order.ordered_player_ids by sub_eligibility_matrix[open_slot_position].
 *   3. Skip players whose team has already been eliminated.
 *   4. Return first player who still has an active bench roster_slot.
 *   5. If no bench_order or submitted_at is null, fall back to highest avg_ppg bench player.
 */
export const BenchOrderService = {
  async resolveNext(
    league_id: string,
    user_id: string,
    open_slot_position: 'G' | 'F' | 'C',
    sub_eligibility_matrix: LeagueSettings['sub_eligibility_matrix']
  ): Promise<Player | null> {
    const eligible_positions = sub_eligibility_matrix[open_slot_position] ?? [];

    // Get current active bench players for this user
    const { data: benchSlots } = await supabaseAdmin
      .from('roster_slots')
      .select('player_id')
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .eq('is_active', true)
      .eq('is_bench', true)
      .is('released_at_round_stage', null);

    const activeBenchIds = new Set(
      (benchSlots ?? []).map((s: { player_id: string }) => s.player_id)
    );

    if (activeBenchIds.size === 0) return null;

    // Eligibility must respect THIS league's position overrides — players.position
    // is a single row shared by every league in a season.
    const positionOverrides = await getLeaguePositionOverrides(supabaseAdmin, league_id);

    // Teams already eliminated this season are ineligible as substitutes
    const { data: league } = await supabaseAdmin
      .from('leagues')
      .select('season')
      .eq('id', league_id)
      .single();

    const { data: eliminatedTeams } = await supabaseAdmin
      .from('teams')
      .select('id')
      .eq('season', league?.season)
      .eq('is_eliminated', true);

    const eliminatedTeamIds = new Set(
      (eliminatedTeams ?? []).map((t: { id: string }) => t.id)
    );

    // Load bench_order for this user
    const { data: benchOrder } = await supabaseAdmin
      .from('bench_orders')
      .select('ordered_player_ids, submitted_at')
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .maybeSingle();

    const hasSubmittedOrder = benchOrder && benchOrder.submitted_at && benchOrder.ordered_player_ids?.length > 0;

    if (hasSubmittedOrder) {
      // Try ordered_player_ids in user-submitted order
      for (const player_id of benchOrder.ordered_player_ids as string[]) {
        if (!activeBenchIds.has(player_id)) continue;

        const { data: player } = await supabaseAdmin
          .from('players')
          .select('*')
          .eq('id', player_id)
          .single();

        if (!player) continue;
        const effectivePosition = resolvePosition(player.id, player.position as 'G' | 'F' | 'C', positionOverrides);
        if (!eligible_positions.includes(effectivePosition)) continue;
        if (eliminatedTeamIds.has(player.team_id)) continue;

        return { ...player, position: effectivePosition } as Player;
      }
    }

    // Fallback: highest avg_ppg bench player eligible for the slot, on a team still
    // alive. Eligibility depends on the league-scoped position, so fetch candidates
    // by id only and filter/sort in JS rather than filtering `position` in the query.
    const benchPlayerIds = [...activeBenchIds];
    const { data: players } = await supabaseAdmin
      .from('players')
      .select('*')
      .in('id', benchPlayerIds)
      .order('avg_ppg', { ascending: false });

    const eligiblePlayers = (players ?? [])
      .map((p: Player) => ({ ...p, position: resolvePosition(p.id, p.position, positionOverrides) }))
      .filter(
        (p: Player) => eligible_positions.includes(p.position) && !eliminatedTeamIds.has(p.team_id)
      );

    if (eligiblePlayers.length > 0) {
      return eligiblePlayers[0] as Player;
    }

    return null;
  },
};
