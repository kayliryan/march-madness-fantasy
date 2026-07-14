import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { getLeaguePositionOverrides, resolvePosition } from '@/lib/services/PlayerPositionOverrides';

interface RoundEntry {
  user_id: string;
  display_name: string;
  player_id: string;
  player_name: string;
  team_name: string | null;
  team_seed: number | null;
  position: string;
  points: number;
  is_bench: boolean;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;

    const supabase = createServerClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        cookies: {
          getAll() { return request.cookies.getAll(); },
          setAll() {},
        },
      }
    );

    const { data: { user } } = await supabase.auth.getUser();
    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    const { data: events } = await supabaseAdmin
      .from('scoring_events')
      .select(`
        user_id,
        round_stage,
        points_credited,
        player_id,
        players ( name, position, teams ( name, seed ) ),
        roster_slots ( is_bench )
      `)
      .eq('league_id', league_id)
      .eq('is_stale', false);

    const memberIds = [...new Set((events ?? []).map((e: { user_id: string }) => e.user_id))];
    const { data: userRows } = memberIds.length > 0
      ? await supabaseAdmin.from('users').select('id, display_name').in('id', memberIds)
      : { data: [] };

    const displayNames = new Map(
      (userRows ?? []).map((u: { id: string; display_name: string }) => [u.id, u.display_name])
    );

    // players.position is shared across every league in a season — show THIS
    // league's override, if any, rather than the raw column.
    const positionOverrides = await getLeaguePositionOverrides(supabaseAdmin, league_id);

    const roundOrder: RoundStage[] = ROUND_STAGE_ORDER.filter((stage) => stage !== 'draft');
    const entriesByRound = new Map<RoundStage, RoundEntry[]>();

    for (const ev of (events ?? []) as unknown as {
      user_id: string;
      round_stage: RoundStage;
      points_credited: number;
      player_id: string;
      players: { name: string; position: string; teams: { name: string; seed: number } | null } | null;
      roster_slots: { is_bench: boolean } | null;
    }[]) {
      if (!roundOrder.includes(ev.round_stage)) continue;
      if (!entriesByRound.has(ev.round_stage)) entriesByRound.set(ev.round_stage, []);
      entriesByRound.get(ev.round_stage)!.push({
        user_id: ev.user_id,
        display_name: displayNames.get(ev.user_id) ?? ev.user_id.slice(0, 6),
        player_id: ev.player_id,
        player_name: ev.players?.name ?? ev.player_id.slice(0, 8),
        team_name: ev.players?.teams?.name ?? null,
        team_seed: ev.players?.teams?.seed ?? null,
        position: ev.players?.position
          ? resolvePosition(ev.player_id, ev.players.position as 'G' | 'F' | 'C', positionOverrides)
          : '',
        points: ev.points_credited,
        is_bench: ev.roster_slots?.is_bench ?? false,
      });
    }

    const rounds = roundOrder
      .filter((stage) => entriesByRound.has(stage))
      .map((round_stage) => ({
        round_stage,
        entries: entriesByRound.get(round_stage)!.sort((a, b) => b.points - a.points),
      }));

    return NextResponse.json({ rounds });
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/rounds:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
