import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { GetPlayersResponse } from '@/lib/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;
    const searchParams = request.nextUrl.searchParams;
    const position = searchParams.get('position');
    const search = searchParams.get('search');

    if (position && !['G', 'F', 'C'].includes(position)) {
      return NextResponse.json(
        { error: 'INVALID_POSITION', message: 'Position must be G, F, or C.' },
        { status: 400 }
      );
    }

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

    // RLS restricts this to leagues the user is a member of (or demo leagues)
    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('id, season')
      .eq('id', league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    // Step 1: most recent completed session
    const { data: session } = await supabase
      .from('draft_sessions')
      .select('id')
      .eq('league_id', league_id)
      .eq('status', 'complete')
      .order('completed_at', { ascending: false })
      .maybeSingle();

    // Step 2: drafted player IDs (only if a completed session exists)
    let excludedPlayerIds: string[] = [];
    if (session) {
      const { data: picks } = await supabase
        .from('draft_picks')
        .select('player_id')
        .eq('draft_session_id', session.id)
        .is('voided_at', null);
      excludedPlayerIds = (picks ?? []).map((p) => p.player_id);
    }

    // Step 3: query players, excluding drafted IDs and applying filters
    let query = supabase
      .from('players')
      .select('*, teams(id, name, short_name, seed, region)')
      .eq('season', league.season);

    if (excludedPlayerIds.length > 0) {
      query = query.not('id', 'in', excludedPlayerIds);
    }

    if (position) {
      query = query.eq('position', position as 'G' | 'F' | 'C');
    }

    query = query.order('avg_ppg', { ascending: false });

    const { data: players, error } = await query;

    if (error) {
      console.error('Error fetching available players:', error);
      return NextResponse.json({ error: 'Failed to fetch available players' }, { status: 500 });
    }

    let filtered = players ?? [];
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter((p) => p.name.toLowerCase().includes(searchLower));
    }

    const response: GetPlayersResponse = {
      players: filtered,
      total: filtered.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/available-players:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
