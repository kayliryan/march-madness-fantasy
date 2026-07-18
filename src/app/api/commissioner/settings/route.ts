import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { isScoringAffectingSetting } from '@/lib/constants/settings';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import type { League, LeagueSettings } from '@/lib/types';

interface UpdateSettingsRequest {
  league_id: string;
  settings: Partial<LeagueSettings>;
}

export async function PATCH(request: NextRequest) {
  try {
    const body: UpdateSettingsRequest = await request.json();

    if (!body.league_id || !body.settings || typeof body.settings !== 'object') {
      return NextResponse.json(
        { error: 'Missing required fields: league_id, settings' },
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

    const { data: league, error: leagueError } = await supabase
      .from('leagues')
      .select('*')
      .eq('id', body.league_id)
      .single();

    if (leagueError || !league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    // Defense-in-depth: explicit role check ahead of the RLS backstop, matching every
    // other commissioner route (e.g. /api/commissioner/pick/void).
    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', body.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (membership?.role !== 'commissioner' && membership?.role !== 'co_commissioner') {
      return NextResponse.json({ error: 'Only a commissioner can update league settings' }, { status: 403 });
    }

    const mergedSettings: LeagueSettings = {
      ...(league.settings as LeagueSettings),
      ...body.settings,
    };

    // RLS "commissioners_can_update_leagues" enforces commissioner-only access
    const { data: updatedLeague, error: updateError } = await supabase
      .from('leagues')
      .update({ settings: mergedSettings })
      .eq('id', body.league_id)
      .select()
      .single();

    if (updateError || !updatedLeague) {
      console.error('Error updating league settings:', updateError);
      return NextResponse.json({ error: 'Failed to update league settings' }, { status: 500 });
    }

    // If any scoring-affecting setting changed, trigger score recalculation (fire-and-forget)
    const changedKeys = Object.keys(body.settings) as (keyof LeagueSettings)[];
    const scoringAffected = changedKeys.some(isScoringAffectingSetting);
    if (scoringAffected) {
      ScoreAccumulator.runForLeague(body.league_id).catch((err) =>
        console.error('[settings route] ScoreAccumulator.runForLeague failed:', err)
      );
    }

    return NextResponse.json({ league: updatedLeague as League });
  } catch (error) {
    console.error('Error in PATCH /api/commissioner/settings:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
