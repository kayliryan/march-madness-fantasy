import { supabaseAdmin } from '@/lib/supabase/client';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { RosterSlotEnriched } from '@/components/RosterSlotList';

export interface EnrichedRoster {
  active_starters: RosterSlotEnriched[];
  active_bench: RosterSlotEnriched[];
  released_starters: RosterSlotEnriched[];
  released_bench: RosterSlotEnriched[];
}

/**
 * Fetches a member's roster slots and enriches each with player/team details,
 * per-round scoring breakdown, and "uncounted" points scored outside the
 * slot's acquired/released window. Partitions into active/released x starter/bench.
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
        .select('*, teams(id, name, seed, region)')
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

    const acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
    const releasedStage = slot.released_at_round_stage as string | undefined;
    let relIdx: number;
    if (!releasedStage) {
      relIdx = ROUND_STAGE_ORDER.length;
    } else {
      const rawRelIdx = ROUND_STAGE_ORDER.indexOf(releasedStage as RoundStage);
      relIdx = rawRelIdx === -1 ? 0 : rawRelIdx;
    }

    const countedStages = new Set(per_round.map((r) => r.round_stage));
    const uncounted_round = (gameScoresByPlayer.get(slot.player_id as string) ?? [])
      .filter((g) => {
        const gameStageIdx = ROUND_STAGE_ORDER.indexOf(g.round_stage as RoundStage);
        if (gameStageIdx === -1) return false;
        const inWindow = acqIdx <= gameStageIdx && gameStageIdx < relIdx;
        return !inWindow && !countedStages.has(g.round_stage);
      })
      .map((g) => ({ round_stage: g.round_stage, points: g.points }));

    return { ...slot, player, per_round, uncounted_round, total_points } as RosterSlotEnriched;
  });

  return {
    active_starters: enrichedSlots.filter((s) => s.is_active && !s.is_bench),
    active_bench: enrichedSlots.filter((s) => s.is_active && s.is_bench),
    released_starters: enrichedSlots.filter((s) => !s.is_active && !s.is_bench),
    released_bench: enrichedSlots.filter((s) => !s.is_active && s.is_bench),
  };
}
