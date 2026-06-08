import { supabaseAdmin } from '@/lib/supabase/client';
import type { LeagueSettings, Player } from '@/lib/types';

/**
 * Resolves the next bench player to activate for an open starter slot.
 * Algorithm (Section 5.4):
 *   1. Load user's bench_order for the league.
 *   2. Filter bench_order.ordered_player_ids by sub_eligibility_matrix[open_slot_position].
 *   3. Return first player who still has an active bench roster_slot.
 *   4. If no bench_order or submitted_at is null, fall back to highest avg_ppg bench player.
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
        if (!eligible_positions.includes(player.position as 'G' | 'F' | 'C')) continue;

        return player as Player;
      }
    }

    // Fallback: highest avg_ppg bench player eligible for the slot
    const benchPlayerIds = [...activeBenchIds];
    const { data: players } = await supabaseAdmin
      .from('players')
      .select('*')
      .in('id', benchPlayerIds)
      .in('position', eligible_positions)
      .order('avg_ppg', { ascending: false });

    if (players && players.length > 0) {
      return players[0] as Player;
    }

    return null;
  },
};
