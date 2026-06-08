import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { GetLeaguesResponse } from '@/lib/types';

export async function GET(request: NextRequest) {
  try {
    // Create Supabase client with authenticated user context
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

    // Get authenticated user
    const {
      data: { user },
    } = await supabase.auth.getUser();

    if (!user) {
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Fetch leagues for current user
    // RLS policy: user must be a league member
    const { data: leagueMembers, error: memberError } = await supabase
      .from('league_members')
      .select('league_id')
      .eq('user_id', user.id);

    if (memberError) {
      console.error('Error fetching league members:', memberError);
      return NextResponse.json(
        { error: 'Failed to fetch leagues' },
        { status: 500 }
      );
    }

    if (!leagueMembers || leagueMembers.length === 0) {
      const response: GetLeaguesResponse = {
        leagues: [],
      };
      return NextResponse.json(response);
    }

    const leagueIds = leagueMembers.map((m) => m.league_id);

    // Fetch league details for each league
    const { data: leagues, error: leagueError } = await supabase
      .from('leagues')
      .select('*')
      .in('id', leagueIds)
      .order('created_at', { ascending: false });

    if (leagueError) {
      console.error('Error fetching leagues:', leagueError);
      return NextResponse.json(
        { error: 'Failed to fetch leagues' },
        { status: 500 }
      );
    }

    const response: GetLeaguesResponse = {
      leagues: leagues || [],
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/leagues:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
