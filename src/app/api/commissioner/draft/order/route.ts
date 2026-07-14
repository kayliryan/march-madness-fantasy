import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { DraftSession } from '@/lib/types';

interface DraftOrderRequest {
  league_id: string;
  order?: string[];
}

function shuffle<T>(arr: T[]): T[] {
  const result = [...arr];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

export async function POST(request: NextRequest) {
  try {
    const body: DraftOrderRequest = await request.json();

    if (!body.league_id) {
      return NextResponse.json({ error: 'Missing required field: league_id' }, { status: 400 });
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

    // Resolve the snake_order: use provided order or generate random from members
    let snakeOrder: string[];
    if (body.order && body.order.length > 0) {
      snakeOrder = body.order;
    } else {
      const { data: members } = await supabase
        .from('league_members')
        .select('user_id')
        .eq('league_id', body.league_id);

      if (!members || members.length === 0) {
        return NextResponse.json({ error: 'No members found in league' }, { status: 404 });
      }
      snakeOrder = shuffle(members.map((m) => m.user_id));
    }

    // Get league for season
    const { data: league } = await supabase
      .from('leagues')
      .select('season')
      .eq('id', body.league_id)
      .single();

    if (!league) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    // Upsert the draft session (RLS enforces commissioner-only) — scoped to the
    // league's active season so the demo seed's "previous season" stub session
    // (created after the real one, purely for a season-switcher link) can't be
    // picked up as "the" session just because it has a later created_at.
    const { data: existing } = await supabase
      .from('draft_sessions')
      .select('id')
      .eq('league_id', body.league_id)
      .eq('season', league.season)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let session: DraftSession | null = null;

    if (existing) {
      const { data, error } = await supabase
        .from('draft_sessions')
        .update({ snake_order: snakeOrder })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating snake_order:', error);
        return NextResponse.json({ error: 'Failed to update draft order' }, { status: 500 });
      }
      session = data as DraftSession;
    } else {
      const { data, error } = await supabase
        .from('draft_sessions')
        .insert({
          league_id: body.league_id,
          season: league.season,
          status: 'scheduled',
          draft_type: 'snake',
          scheduled_start: new Date().toISOString(),
          snake_order: snakeOrder,
          current_pick_number: 1,
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating draft session with order:', error);
        return NextResponse.json({ error: 'Failed to create draft session' }, { status: 500 });
      }
      session = data as DraftSession;
    }

    return NextResponse.json({ draft_session: session });
  } catch (error) {
    console.error('Error in POST /api/commissioner/draft/order:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
