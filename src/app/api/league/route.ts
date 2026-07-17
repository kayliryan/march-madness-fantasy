import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import { CURRENT_TOURNAMENT_SEASON } from '@/lib/constants/season';
import type { CreateLeagueRequest, CreateLeagueResponse, League, LeagueMember, LeagueSettings } from '@/lib/types';

// Default league settings from Section 4.3 of design doc
const DEFAULT_SETTINGS: LeagueSettings = {
  draft_type: 'snake',
  draft_order_lock_days_before: 3,
  pick_timer_seconds: 90,
  starter_slots: { G: 2, F: 2, C: 1 },
  bench_slots: 3,
  sub_eligibility_matrix: {
    G: ['G', 'F'],
    F: ['G', 'F'],
    C: ['C'],
  },
  bench_lock_mode: 'before_first_game',
  activation_timing: 'immediate',
  injury_sub_enabled: false,
  // injury_sub_reversible is deferred — has no effect in current implementation.
  injury_sub_reversible: false,
  tiebreaker_strategies: ['highest_single_active_game'],
  scoring_includes_play_in: true,
  stats_provider: 'espn',
  notifications: {
    round_end_email: true,
    daily_digest: false,
    ai_summary: true,
  },
  email_tone: 'playful',
};

export async function POST(request: NextRequest) {
  try {
    const body: CreateLeagueRequest = await request.json();

    // Validate input
    if (!body.name || !body.season) {
      return NextResponse.json(
        { error: 'Missing required fields: name, season' },
        { status: 400 }
      );
    }

    // Determine the only season leagues can be created for:
    // if the current season has in-progress games it's still active → use it;
    // otherwise the upcoming season (current + 1) is the target.
    const { count: activeCount } = await supabaseAdmin
      .from('game_scores')
      .select('id', { count: 'exact', head: true })
      .eq('season', CURRENT_TOURNAMENT_SEASON)
      .eq('game_status', 'in_progress');

    const allowedSeason = (activeCount ?? 0) > 0
      ? CURRENT_TOURNAMENT_SEASON
      : CURRENT_TOURNAMENT_SEASON + 1;

    if (body.season !== allowedSeason) {
      return NextResponse.json(
        { error: `Leagues can only be created for the ${allowedSeason === CURRENT_TOURNAMENT_SEASON ? 'active' : 'upcoming'} season (${allowedSeason}).` },
        { status: 400 }
      );
    }

    // Block creation if play-in games have already started for the active season
    if (allowedSeason === CURRENT_TOURNAMENT_SEASON) {
      const { count: playInCount } = await supabaseAdmin
        .from('game_scores')
        .select('id', { count: 'exact', head: true })
        .eq('season', allowedSeason)
        .eq('round_stage', 'play_in')
        .neq('game_status', 'scheduled');

      if ((playInCount ?? 0) > 0) {
        return NextResponse.json(
          { error: 'The season has already started. Leagues cannot be created after the first play-in game.' },
          { status: 409 }
        );
      }
    }

    // Get authenticated user
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
      return NextResponse.json(
        { error: 'Unauthorized' },
        { status: 401 }
      );
    }

    // Merge custom settings with defaults
    const settings = {
      ...DEFAULT_SETTINGS,
      ...body.settings,
    };

    // Generate unique invite token
    const inviteToken = `league_${crypto.randomUUID()}`;

    // Create league using service role key (admin operation)
    const { data: league, error: leagueError } = await supabaseAdmin
      .from('leagues')
      .insert({
        name: body.name,
        season: body.season,
        commissioner_id: user.id,
        settings,
        invite_token: inviteToken,
        is_demo: false,
        stats_sync_status: 'ok',
      })
      .select()
      .single();

    if (leagueError) {
      console.error('Error creating league:', leagueError);
      return NextResponse.json(
        { error: 'Failed to create league' },
        { status: 500 }
      );
    }

    // Create league_members row for commissioner
    const { data: member, error: memberError } = await supabaseAdmin
      .from('league_members')
      .insert({
        league_id: league.id,
        user_id: user.id,
        role: 'commissioner',
        joined_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (memberError) {
      console.error('Error creating league member:', memberError);
      // Clean up league if member creation fails
      await supabaseAdmin
        .from('leagues')
        .delete()
        .eq('id', league.id);

      return NextResponse.json(
        { error: 'Failed to create league membership' },
        { status: 500 }
      );
    }

    const response: CreateLeagueResponse = {
      league: league as League,
      league_member: member as LeagueMember,
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('Error in POST /api/league:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
