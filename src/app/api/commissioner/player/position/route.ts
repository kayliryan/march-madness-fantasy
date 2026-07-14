import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import type { Player } from '@/lib/types';

interface PositionOverrideRequest {
  player_id: string;
  league_id: string;
  position: 'G' | 'F' | 'C';
  override_note: string;
}

export async function PATCH(request: NextRequest) {
  try {
    const body: PositionOverrideRequest = await request.json();

    if (!body.player_id) {
      return NextResponse.json({ error: 'Missing required field: player_id' }, { status: 400 });
    }
    if (!body.league_id) {
      return NextResponse.json({ error: 'Missing required field: league_id' }, { status: 400 });
    }
    if (!body.position || !['G', 'F', 'C'].includes(body.position)) {
      return NextResponse.json({ error: 'Invalid position' }, { status: 400 });
    }
    if (!body.override_note || !body.override_note.trim()) {
      return NextResponse.json(
        { error: 'override_note is required when overriding a position' },
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

    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', body.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    const isCommissioner =
      membership?.role === 'commissioner' || membership?.role === 'co_commissioner';

    if (!isCommissioner) {
      return NextResponse.json(
        { error: 'Only a commissioner can override player positions' },
        { status: 403 }
      );
    }

    // Scoped to this league only — players is a single row shared by every league
    // in a season, so this used to `update players set position = ...` directly,
    // which meant overriding a position in a demo league silently overrode it for
    // every real league using that same player too. Upserting into a per-league
    // table keeps the override contained to the league that made it.
    const { error: overrideError } = await supabaseAdmin
      .from('league_player_position_overrides')
      .upsert(
        {
          league_id: body.league_id,
          player_id: body.player_id,
          position: body.position,
          override_note: body.override_note.trim(),
          overridden_by: user.id,
          overridden_at: new Date().toISOString(),
        },
        { onConflict: 'league_id,player_id' }
      );

    if (overrideError) {
      console.error('Error overriding player position:', overrideError);
      return NextResponse.json({ error: 'Failed to override position' }, { status: 500 });
    }

    const { data: player, error } = await supabaseAdmin
      .from('players')
      .select('*, teams(id, name, seed, region)')
      .eq('id', body.player_id)
      .single();

    if (error || !player) {
      console.error('Error loading player after override:', error);
      return NextResponse.json({ error: 'Failed to load player' }, { status: 500 });
    }

    // Reflect the override in the response so the caller's UI shows what this
    // league will actually see, without implying it changed anywhere else.
    return NextResponse.json({
      player: {
        ...player,
        position: body.position,
        position_overridden: true,
        position_override_note: body.override_note.trim(),
      } as Player,
    });
  } catch (error) {
    console.error('Error in PATCH /api/commissioner/player/position:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
