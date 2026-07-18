import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import type { GameScore } from '@/lib/types';

interface ManualScoreRequest {
  player_id: string;
  round_stage: string;
  round_number: number;
  game_date: string;
  points: number;
}

const VALID_ROUND_STAGES = ['play_in', 'r64', 'r32', 's16', 'e8', 'f4', 'championship'];

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;
    const body: ManualScoreRequest = await request.json();

    if (
      !body.player_id ||
      !body.round_stage ||
      !VALID_ROUND_STAGES.includes(body.round_stage) ||
      typeof body.round_number !== 'number' ||
      !body.game_date ||
      typeof body.points !== 'number' ||
      body.points < 0
    ) {
      return NextResponse.json(
        { error: 'Missing or invalid fields: player_id, round_stage, round_number, game_date, points' },
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

    // Commissioner only
    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (membership?.role !== 'commissioner' && membership?.role !== 'co_commissioner') {
      return NextResponse.json({ error: 'Only a commissioner can enter manual scores' }, { status: 403 });
    }

    // Verify player exists
    const { data: player } = await supabaseAdmin
      .from('players')
      .select('id, season')
      .eq('id', body.player_id)
      .single();

    if (!player) {
      return NextResponse.json({ error: 'Player not found' }, { status: 404 });
    }

    // Mark any existing scoring_events for this player/league as stale (will be recomputed)
    await supabaseAdmin
      .from('scoring_events')
      .update({ is_stale: true })
      .eq('league_id', league_id)
      .eq('player_id', body.player_id);

    // Upsert game_score (unique on player_id + round_stage + round_number + game_date)
    const { data: gameScore, error: gsError } = await supabaseAdmin
      .from('game_scores')
      .upsert(
        {
          player_id: body.player_id,
          season: player.season,
          round_stage: body.round_stage,
          round_number: body.round_number,
          game_date: body.game_date,
          game_status: 'final',
          points: body.points,
          source: 'manual',
          synced_at: new Date().toISOString(),
        },
        { onConflict: 'player_id,round_stage,round_number,game_date' }
      )
      .select()
      .single();

    if (gsError || !gameScore) {
      console.error('Error upserting game_score:', gsError);
      return NextResponse.json({ error: 'Failed to save game score' }, { status: 500 });
    }

    // Trigger score recomputation (fire-and-forget)
    ScoreAccumulator.runForGames([gameScore.id]).catch((err) =>
      console.error('[manual scores] ScoreAccumulator.runForGames failed:', err)
    );

    return NextResponse.json({ game_score: gameScore as GameScore });
  } catch (error) {
    console.error('Error in POST /api/league/[league_id]/scores/manual:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
