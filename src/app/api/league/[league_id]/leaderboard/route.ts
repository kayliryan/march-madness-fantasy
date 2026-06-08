import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';

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

    // Fetch all leaderboard snapshots for this league
    const { data: snapshots } = await supabaseAdmin
      .from('leaderboard_snapshots')
      .select('*')
      .eq('league_id', league_id)
      .order('total_points', { ascending: false });

    // Fetch per-round breakdown from scoring_events
    const { data: scoringEvents } = await supabaseAdmin
      .from('scoring_events')
      .select('user_id, round_stage, points_credited')
      .eq('league_id', league_id)
      .eq('is_stale', false);

    // Group per-round points by user_id
    const perRoundByUser = new Map<string, Map<string, number>>();
    for (const ev of (scoringEvents ?? [])) {
      if (!perRoundByUser.has(ev.user_id)) perRoundByUser.set(ev.user_id, new Map());
      const roundMap = perRoundByUser.get(ev.user_id)!;
      roundMap.set(ev.round_stage, (roundMap.get(ev.round_stage) ?? 0) + ev.points_credited);
    }

    // Check if any scoring events are stale (scores still being computed)
    const { count: staleCount } = await supabaseAdmin
      .from('scoring_events')
      .select('*', { count: 'exact', head: true })
      .eq('league_id', league_id)
      .eq('is_stale', true);

    const scores_updating = (staleCount ?? 0) > 0;

    // Fetch display names for all users in the league
    const { data: members } = await supabaseAdmin
      .from('league_members')
      .select('user_id')
      .eq('league_id', league_id);

    const memberIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
    const { data: userRows } = memberIds.length > 0
      ? await supabaseAdmin.from('users').select('id, display_name').in('id', memberIds)
      : { data: [] };

    const displayNames = new Map(
      (userRows ?? []).map((u: { id: string; display_name: string }) => [u.id, u.display_name])
    );

    const standings = (snapshots ?? []).map((snap: {
      user_id: string;
      total_points: number;
      active_player_count: number;
      highest_single_game_points: number;
    }) => {
      const roundMap = perRoundByUser.get(snap.user_id) ?? new Map<string, number>();
      const per_round = Array.from(roundMap.entries()).map(([round_stage, points]) => ({
        round_stage,
        points,
      }));

      return {
        user_id: snap.user_id,
        display_name: displayNames.get(snap.user_id) ?? snap.user_id.slice(0, 6),
        total_points: snap.total_points,
        active_player_count: snap.active_player_count,
        per_round,
        highest_single_game_points: snap.highest_single_game_points,
      };
    });

    return NextResponse.json({ standings, scores_updating });
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/leaderboard:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
