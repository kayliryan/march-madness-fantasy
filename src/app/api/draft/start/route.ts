import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/admin';

export async function POST(request: NextRequest) {
  try {
    const body: { draft_session_id: string } = await request.json();

    if (!body.draft_session_id) {
      return NextResponse.json({ error: 'Missing required field: draft_session_id' }, { status: 400 });
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

    const { data: session } = await supabaseAdmin
      .from('draft_sessions')
      .select('*')
      .eq('id', body.draft_session_id)
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Draft session not found' }, { status: 404 });
    }

    // Must be commissioner of the league
    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', session.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (membership?.role !== 'commissioner' && membership?.role !== 'co_commissioner') {
      return NextResponse.json({ error: 'Only a commissioner can start the draft' }, { status: 403 });
    }

    if (session.status === 'live' || session.status === 'complete') {
      return NextResponse.json(
        { error: 'DRAFT_ALREADY_LIVE', message: 'Draft is already in progress or complete.' },
        { status: 409 }
      );
    }

    if (session.status === 'cancelled') {
      return NextResponse.json({ error: 'Draft has been cancelled' }, { status: 409 });
    }

    if (new Date(session.scheduled_start) > new Date()) {
      return NextResponse.json(
        { error: 'Draft cannot start before the scheduled time' },
        { status: 422 }
      );
    }

    if (!session.snake_order || session.snake_order.length === 0) {
      return NextResponse.json(
        { error: 'Draft order must be set before starting' },
        { status: 422 }
      );
    }

    const { data: updated, error } = await supabaseAdmin
      .from('draft_sessions')
      .update({ status: 'live', started_at: new Date().toISOString() })
      .eq('id', body.draft_session_id)
      .select()
      .single();

    if (error || !updated) {
      console.error('Error starting draft:', error);
      return NextResponse.json({ error: 'Failed to start draft' }, { status: 500 });
    }

    return NextResponse.json({ session: updated });
  } catch (error) {
    console.error('Error in POST /api/draft/start:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
