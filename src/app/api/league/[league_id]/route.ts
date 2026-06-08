import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { GetLeagueResponse, League, LeagueMember } from '@/lib/types';

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

    const response: GetLeagueResponse = {
      league: league as League,
      members: (members || []) as LeagueMember[],
      current_member: currentMember as LeagueMember,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
