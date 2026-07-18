import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

interface BenchOrderRequest {
  league_id: string;
  user_id: string;
  ordered_player_ids: string[];
}

export async function PATCH(request: NextRequest) {
  try {
    const body: BenchOrderRequest = await request.json();

    if (!body.league_id || !body.user_id || !Array.isArray(body.ordered_player_ids)) {
      return NextResponse.json(
        { error: 'Missing required fields: league_id, user_id, ordered_player_ids' },
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

    const isCommissioner = membership?.role === 'commissioner' || membership?.role === 'co_commissioner';

    // Authz: a caller may only submit their own bench order, unless they're a
    // commissioner/co-commissioner of this league. Without this check `body.user_id`
    // is fully caller-controlled and this route would rely solely on RLS to reject
    // writes for other users' bench orders.
    if (user.id !== body.user_id && !isCommissioner) {
      return NextResponse.json(
        { error: 'You can only update your own bench order' },
        { status: 403 }
      );
    }

    const { data: existing } = await supabase
      .from('bench_orders')
      .select('id')
      .eq('league_id', body.league_id)
      .eq('user_id', body.user_id)
      .maybeSingle();

    const { data: leagueRow } = await supabase
      .from('leagues')
      .select('season')
      .eq('id', body.league_id)
      .maybeSingle();

    // Check the lock deadline directly (rather than bench_orders.locked_at) so the lock
    // applies even to a user's first-ever submission, when no bench_orders row exists yet.
    // Scoped to the league's active season — the demo seed's "previous season" stub
    // session (created after the real one, purely for a season-switcher link) has a
    // later created_at and would otherwise win the "most recent" pick, handing back a
    // bench_lock_deadline over a year in the past.
    const { data: draftSession } = await supabase
      .from('draft_sessions')
      .select('bench_lock_deadline')
      .eq('league_id', body.league_id)
      .eq('season', leagueRow?.season ?? 0)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    const isLocked = !!draftSession?.bench_lock_deadline && new Date(draftSession.bench_lock_deadline) < new Date();

    if (isLocked && !isCommissioner) {
      return NextResponse.json(
        { error: 'BENCH_ORDER_LOCKED', message: 'Bench order is locked for this league.' },
        { status: 422 }
      );
    }

    const now = new Date().toISOString();
    let benchOrder;

    if (existing) {
      const { data, error } = await supabase
        .from('bench_orders')
        .update({
          ordered_player_ids: body.ordered_player_ids,
          submitted_at: now,
          last_edited_by: user.id,
          last_edited_at: now,
        })
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating bench order:', error);
        return NextResponse.json({ error: 'Failed to update bench order' }, { status: 500 });
      }
      benchOrder = data;
    } else {
      const { data, error } = await supabase
        .from('bench_orders')
        .insert({
          league_id: body.league_id,
          user_id: body.user_id,
          ordered_player_ids: body.ordered_player_ids,
          submitted_at: now,
          last_edited_by: user.id,
          last_edited_at: now,
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating bench order:', error);
        return NextResponse.json({ error: 'Failed to create bench order' }, { status: 500 });
      }
      benchOrder = data;
    }

    return NextResponse.json({ bench_order: benchOrder });
  } catch (error) {
    console.error('Error in PATCH /api/commissioner/bench-order:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
