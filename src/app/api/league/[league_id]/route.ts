import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { GetLeagueResponse, League, LeagueMember } from '@/lib/types';
import { CURRENT_TOURNAMENT_SEASON } from '@/lib/constants/season';

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
          getAll() {
            return request.cookies.getAll();
          },
          setAll() {},
        },
      }
    );

    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    // RLS restricts this to leagues the user is a member of (or demo leagues)
    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    const { data: members, error: membersError } = await supabase
      .from('league_members')
      .select('*')
      .eq('league_id', league_id);

    if (membersError) {
      console.error('Error fetching league members:', membersError);
      return NextResponse.json(
        { error: 'Failed to fetch league members' },
        { status: 500 }
      );
    }

    const currentMember = (members || []).find((m) => m.user_id === user.id);

    if (!currentMember) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    const [{ data: session, error: sessionError }, { count }, { count: rosterCount }] = await Promise.all([
      // Scoped to the league's active season — without this, the demo seed's
      // "previous season" stub session (created after the real one, purely to
      // surface a season-switcher link) has a later created_at and would win
      // the "most recent" pick, handing the whole app a >1-year-stale
      // bench_lock_deadline/draft_status for the CURRENT season's draft.
      //
      // .limit(1) before .maybeSingle() is required, not cosmetic: if this
      // query ever matches more than one row (e.g. a stray extra session from
      // an earlier re-provisioning attempt), .maybeSingle() alone returns an
      // error and `data` comes back null — which silently produced
      // draft_status: null and the "No draft yet" empty state for leagues
      // that very much have a completed draft, roster, and scores already.
      supabase
        .from('draft_sessions')
        .select('id, bench_lock_deadline, status, scheduled_start')
        .eq('league_id', league_id)
        .eq('season', (league as League).season)
        .neq('status', 'cancelled')
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle(),
      supabase
        .from('game_scores')
        .select('id', { count: 'exact', head: true })
        .eq('season', (league as League).season)
        .eq('game_status', 'in_progress'),
      supabase
        .from('roster_slots')
        .select('id', { count: 'exact', head: true })
        .eq('league_id', league_id),
    ]);

    if (sessionError) {
      console.error('Error fetching draft_session for league (falling back to draft_status=null):', sessionError);
    }

    const response: GetLeagueResponse = {
      league: league as League,
      members: (members || []) as LeagueMember[],
      current_member: currentMember as LeagueMember,
      draft_session_id: session?.id ?? null,
      bench_lock_deadline: session?.bench_lock_deadline ?? null,
      draft_status: session?.status ?? null,
      scheduled_start: session?.scheduled_start ?? null,
      season_in_progress: (count ?? 0) > 0,
      is_historical: (league as League).season < CURRENT_TOURNAMENT_SEASON,
      has_roster_data: (rosterCount ?? 0) > 0,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
