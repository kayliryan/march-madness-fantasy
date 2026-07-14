import { supabaseAdmin } from '@/lib/supabase/client';
import type { RosterSlotEnriched } from '@/components/RosterSlotList';

export interface EnrichedRoster {
  active_starters: RosterSlotEnriched[];
  active_bench: RosterSlotEnriched[];
  released_starters: RosterSlotEnriched[];
  released_bench: RosterSlotEnriched[];
}

/**
 * Fetches a member's roster slots and enriches each with player/team details
 * and per-round scoring (both credited and raw game-by-game). Partitions into
 * active/released x starter/bench.
 */
export async function getEnrichedRoster(league_id: string, user_id: string): Promise<EnrichedRoster> {
  const { data: slots } = await supabaseAdmin
    .from('roster_slots')
    .select('*')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .order('created_at', { ascending: true });

  const safeSlots = slots ?? [];

  const playerIds = [...new Set(safeSlots.map((s: { player_id: string }) => s.player_id))];
  const { data: players } = playerIds.length > 0
    ? await supabaseAdmin
        .from('players')
        .select('*, teams(id, name, seed, region, is_eliminated)')
        .in('id', playerIds)
    : { data: [] };

  const playerMap = new Map(
    (players ?? []).map((p: { id: string }) => [p.id, p])
  );

  const { data: scoringEvents } = await supabaseAdmin
    .from('scoring_events')
    .select('player_id, round_stage, points_credited')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .eq('is_stale', false);

  const pointsByPlayer = new Map<string, { round_stage: string; points: number }[]>();
  for (const ev of (scoringEvents ?? [])) {
    if (!pointsByPlayer.has(ev.player_id)) pointsByPlayer.set(ev.player_id, []);
    pointsByPlayer.get(ev.player_id)!.push({
      round_stage: ev.round_stage,
      points: ev.points_credited,
    });
  }

  const { data: allGameScores } = playerIds.length > 0
    ? await supabaseAdmin
        .from('game_scores')
        .select('player_id, round_stage, points')
        .in('player_id', playerIds)
    : { data: [] };

  const gameScoresByPlayer = new Map<string, { round_stage: string; points: number }[]>();
  for (const gs of (allGameScores ?? [])) {
    if (!gameScoresByPlayer.has(gs.player_id)) gameScoresByPlayer.set(gs.player_id, []);
    gameScoresByPlayer.get(gs.player_id)!.push({ round_stage: gs.round_stage, points: gs.points });
  }

  const enrichedSlots: RosterSlotEnriched[] = safeSlots.map((slot: Record<string, unknown>) => {
    const player = playerMap.get(slot.player_id as string) ?? null;
    const per_round = pointsByPlayer.get(slot.player_id as string) ?? [];
    const total_points = per_round.reduce((sum, r) => sum + r.points, 0);

    // Full raw game-by-game scores for this player, regardless of acquired/released
    // window — the shared getRoundCell() helper (src/lib/utils/roundBreakdown.ts)
    // decides which rounds to surface as bench/elim/counted using this plus
    // acquired_at_round_stage / released_at_round_stage on the slot itself.
    const raw_round = gameScoresByPlayer.get(slot.player_id as string) ?? [];

    return { ...slot, player, per_round, raw_round, total_points } as RosterSlotEnriched;
  });

  return {
    active_starters: enrichedSlots.filter((s) => s.is_active && !s.is_bench),
    active_bench: enrichedSlots.filter((s) => s.is_active && s.is_bench),
    released_starters: enrichedSlots.filter((s) => !s.is_active && !s.is_bench),
    released_bench: enrichedSlots.filter((s) => !s.is_active && s.is_bench),
  };
}
