import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import { getEnrichedRoster } from '@/lib/services/RosterEnrichment';

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

    const rosters = await Promise.all(
      memberIds.map(async (user_id) => {
        const roster = await getEnrichedRoster(league_id, user_id);
        const total_points = [
          ...roster.active_starters,
          ...roster.active_bench,
          ...roster.released_starters,
          ...roster.released_bench,
        ].reduce((sum, s) => sum + s.total_points, 0);

        return {
          user_id,
          display_name: displayNames.get(user_id) ?? user_id.slice(0, 6),
          total_points,
          ...roster,
        };
      })
    );

    rosters.sort((a, b) => b.total_points - a.total_points);

    return NextResponse.json({ members: rosters });
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/rosters:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
