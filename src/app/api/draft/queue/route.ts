import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { AddToQueueRequest, AddToQueueResponse } from '@/lib/types';

export async function GET(request: NextRequest) {
  try {
    const sessionId = request.nextUrl.searchParams.get('session_id');

    if (!sessionId) {
      return NextResponse.json(
        { error: 'Missing required query param: session_id' },
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

    // RLS restricts draft_queues reads to user_id = auth.uid(), keeping each
    // participant's queue private from the rest of the league
    const { data: queue, error } = await supabase
      .from('draft_queues')
      .select('*, players(*, teams(id, name, seed, region))')
      .eq('user_id', user.id)
      .eq('draft_session_id', sessionId)
      .is('removed_at', null)
      .order('queue_position', { ascending: true });

    if (error) {
      console.error('Error fetching queue:', error);
      return NextResponse.json({ error: 'Failed to fetch queue' }, { status: 500 });
    }

    const response: AddToQueueResponse = { queue: queue || [] };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in GET /api/draft/queue:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body: AddToQueueRequest = await request.json();

    if (!body.draft_session_id || !body.player_id) {
      return NextResponse.json(
        { error: 'Missing required fields: draft_session_id, player_id' },
        { status: 400 }
      );
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

    // Look up the league_id for this draft session
    const { data: draftSession, error: sessionError } = await supabase
      .from('draft_sessions')
      .select('league_id, status')
      .eq('id', body.draft_session_id)
      .single();

    if (sessionError || !draftSession) {
      return NextResponse.json(
        { error: 'Draft session not found' },
        { status: 404 }
      );
    }

    if (draftSession.status === 'complete') {
      return NextResponse.json(
        { error: 'DRAFT_COMPLETE', message: 'Cannot modify your queue after the draft has completed.' },
        { status: 422 }
      );
    }

    // Check if player is already drafted
    const { data: existingPicks } = await supabase
      .from('draft_picks')
      .select('id')
      .eq('player_id', body.player_id)
      .eq('draft_session_id', body.draft_session_id)
      .is('voided_at', null);

    if (existingPicks && existingPicks.length > 0) {
      return NextResponse.json(
        { error: 'Player already drafted' },
        { status: 422 }
      );
    }

    // Get current queue position count
    const { data: currentQueue, error: queueError } = await supabase
      .from('draft_queues')
      .select('queue_position', { count: 'exact' })
      .eq('user_id', user.id)
      .eq('draft_session_id', body.draft_session_id)
      .is('removed_at', null);

    if (queueError) {
      console.error('Error fetching queue:', queueError);
      return NextResponse.json(
        { error: 'Failed to add to queue' },
        { status: 500 }
      );
    }

    const nextPosition = (currentQueue?.length ?? 0) + 1;

    // Add to queue
    const { error: insertError } = await supabase
      .from('draft_queues')
      .insert({
        league_id: draftSession.league_id,
        draft_session_id: body.draft_session_id,
        user_id: user.id,
        player_id: body.player_id,
        queue_position: body.queue_position ?? nextPosition,
        added_at: new Date().toISOString(),
      })
      .select();

    if (insertError) {
      console.error('Error adding to queue:', insertError);
      return NextResponse.json(
        { error: 'Failed to add to queue' },
        { status: 500 }
      );
    }

    // Fetch updated queue
    const { data: updatedQueue, error: fetchError } = await supabase
      .from('draft_queues')
      .select('*, players(*, teams(id, name, seed, region))')
      .eq('user_id', user.id)
      .eq('draft_session_id', body.draft_session_id)
      .is('removed_at', null)
      .order('queue_position', { ascending: true });

    if (fetchError) {
      console.error('Error fetching updated queue:', fetchError);
      return NextResponse.json(
        { error: 'Failed to fetch updated queue' },
        { status: 500 }
      );
    }

    const response: AddToQueueResponse = {
      queue: updatedQueue || [],
    };

    return NextResponse.json(response, { status: 201 });
  } catch (error) {
    console.error('Error in POST /api/draft/queue:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
