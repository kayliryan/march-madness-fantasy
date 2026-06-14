import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { getEnrichedRoster } from '@/lib/services/RosterEnrichment';

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

    const roster = await getEnrichedRoster(league_id, user_id);
    return NextResponse.json(roster);
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/roster/[user_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
