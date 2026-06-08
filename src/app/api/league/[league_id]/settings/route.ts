import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { League, LeagueSettings } from '@/lib/types';

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;
    const body: Partial<LeagueSettings> = await request.json();

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

    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    // Merge incoming settings with existing settings (shallow merge of top-level keys)
    const mergedSettings: LeagueSettings = {
      ...(league.settings as LeagueSettings),
      ...body,
    };

    // RLS "commissioners_can_update_leagues" enforces that only the commissioner
    // (or a co-commissioner) may successfully update this row
    const { data: updatedLeague, error: updateError } = await supabase
      .from('leagues')
      .update({ settings: mergedSettings })
      .eq('id', league_id)
      .select()
      .single();

    if (updateError || !updatedLeague) {
      console.error('Error updating league settings:', updateError);
      return NextResponse.json(
        { error: 'Failed to update league settings' },
        { status: 500 }
      );
    }

    return NextResponse.json({ league: updatedLeague as League });
  } catch (error) {
    console.error('Error in PATCH /api/league/[league_id]/settings:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
