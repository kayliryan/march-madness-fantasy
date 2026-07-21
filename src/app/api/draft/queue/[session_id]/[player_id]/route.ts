import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { AddToQueueResponse } from '@/lib/types';

// Reorders a single queue entry (drag-and-drop). Body: { queue_position: number }
export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ session_id: string; player_id: string }> }
) {
  try {
    const { session_id, player_id } = await params;
    const body: { queue_position?: number } = await request.json();

    if (typeof body.queue_position !== 'number') {
      return NextResponse.json(
        { error: 'Missing required field: queue_position' },
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

    const { error: updateError } = await supabase
      .from('draft_queues')
      .update({ queue_position: body.queue_position })
      .eq('user_id', user.id)
      .eq('draft_session_id', session_id)
      .eq('player_id', player_id)
      .is('removed_at', null);

    if (updateError) {
      console.error('Error reordering queue:', updateError);
      return NextResponse.json({ error: 'Failed to reorder queue' }, { status: 500 });
    }

    const { data: updatedQueue, error: fetchError } = await supabase
      .from('draft_queues')
      .select('*, players(*, teams(id, name, short_name, seed, region))')
      .eq('user_id', user.id)
      .eq('draft_session_id', session_id)
      .is('removed_at', null)
      .order('queue_position', { ascending: true });

    if (fetchError) {
      console.error('Error fetching updated queue:', fetchError);
      return NextResponse.json({ error: 'Failed to fetch updated queue' }, { status: 500 });
    }

    const response: AddToQueueResponse = { queue: updatedQueue || [] };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in PATCH /api/draft/queue/[session_id]/[player_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ session_id: string; player_id: string }> }
) {
  try {
    const { session_id, player_id } = await params;

    if (!session_id || !player_id) {
      return NextResponse.json(
        { error: 'Missing required parameters: session_id, player_id' },
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

    // Soft delete: set removed_at timestamp
    const { error: updateError } = await supabase
      .from('draft_queues')
      .update({
        removed_at: new Date().toISOString(),
      })
      .eq('user_id', user.id)
      .eq('draft_session_id', session_id)
      .eq('player_id', player_id)
      .is('removed_at', null);

    if (updateError) {
      console.error('Error removing from queue:', updateError);
      return NextResponse.json(
        { error: 'Failed to remove from queue' },
        { status: 500 }
      );
    }

    // Fetch updated queue
    const { data: updatedQueue, error: fetchError } = await supabase
      .from('draft_queues')
      .select('*, players(*, teams(id, name, short_name, seed, region))')
      .eq('user_id', user.id)
      .eq('draft_session_id', session_id)
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

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error in DELETE /api/draft/queue/[session_id]/[player_id]:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
