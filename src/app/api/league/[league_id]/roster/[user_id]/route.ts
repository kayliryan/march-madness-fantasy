import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string; user_id: string }> }
) {
  try {
    const { league_id, user_id } = await params;

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

    // Verify caller is a member of this league
    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    // Fetch all roster slots for the target user
    const { data: slots } = await supabaseAdmin
      .from('roster_slots')
      .select('*')
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .order('created_at', { ascending: true });

    if (!slots) {
      return NextResponse.json({ error: 'Failed to fetch roster' }, { status: 500 });
    }

    // Fetch player details (with team join) for all slot player_ids
    const playerIds = [...new Set(slots.map((s: { player_id: string }) => s.player_id))];
    const { data: players } = playerIds.length > 0
      ? await supabaseAdmin
          .from('players')
          .select('*, teams(id, name, seed, region)')
          .in('id', playerIds)
      : { data: [] };

    const playerMap = new Map(
      (players ?? []).map((p: { id: string }) => [p.id, p])
    );

    // Fetch scoring events for per-round breakdown
    const { data: scoringEvents } = await supabaseAdmin
      .from('scoring_events')
      .select('player_id, round_stage, points_credited')
      .eq('league_id', league_id)
      .eq('user_id', user_id)
      .eq('is_stale', false);

    // Group scoring events by player_id
    const pointsByPlayer = new Map<string, { round_stage: string; points: number }[]>();
    for (const ev of (scoringEvents ?? [])) {
      if (!pointsByPlayer.has(ev.player_id)) pointsByPlayer.set(ev.player_id, []);
      pointsByPlayer.get(ev.player_id)!.push({
        round_stage: ev.round_stage,
        points: ev.points_credited,
      });
    }

    type EnrichedSlot = {
      is_active: boolean;
      is_bench: boolean;
      player_id: string;
      player: unknown;
      per_round: { round_stage: string; points: number }[];
      total_points: number;
      [key: string]: unknown;
    };

    // Enrich slots with player details and per-round points
    const enrichedSlots: EnrichedSlot[] = slots.map((slot: Record<string, unknown>) => {
      const player = playerMap.get(slot.player_id as string) ?? null;
      const per_round = pointsByPlayer.get(slot.player_id as string) ?? [];
      const total_points = per_round.reduce((sum, r) => sum + r.points, 0);
      return { ...slot, player, per_round, total_points } as EnrichedSlot;
    });

    // Partition into four groups
    const active_starters = enrichedSlots.filter((s) => s.is_active && !s.is_bench);
    const active_bench = enrichedSlots.filter((s) => s.is_active && s.is_bench);
    const released_starters = enrichedSlots.filter((s) => !s.is_active && !s.is_bench);
    const released_bench = enrichedSlots.filter((s) => !s.is_active && s.is_bench);

    return NextResponse.json({
      active_starters,
      active_bench,
      released_starters,
      released_bench,
    });
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/roster/[user_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
