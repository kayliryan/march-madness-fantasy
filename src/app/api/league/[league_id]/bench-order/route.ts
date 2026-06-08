import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';

interface BenchOrderRequest {
  user_id: string;
  ordered_player_ids: string[];
}

/**
 * Sets (or replaces) a participant's bench order. RLS
 * ("users_can_manage/update_bench_orders") permits the row owner or the league
 * commissioner, so a commissioner can override any participant's order.
 */
export async function PUT(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;
    const body: BenchOrderRequest = await request.json();

    if (!body.user_id || !Array.isArray(body.ordered_player_ids)) {
      return NextResponse.json(
        { error: 'Missing required fields: user_id, ordered_player_ids' },
        { status: 400 }
      );
    }

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

    const { data: existing } = await supabase
      .from('bench_orders')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', body.user_id)
      .maybeSingle();

    const now = new Date().toISOString();
    let benchOrder;

    if (existing) {
      const { data, error } = await supabase
        .from('bench_orders')
        .update({
          ordered_player_ids: body.ordered_player_ids,
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
          league_id,
          user_id: body.user_id,
          ordered_player_ids: body.ordered_player_ids,
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
    console.error('Error in PUT /api/league/[league_id]/bench-order:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
