import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';

interface TimerExtendRequest {
  draft_session_id: string;
  pick_number: number;
  extension_seconds: number | null;
}

export async function POST(request: NextRequest) {
  try {
    const body: TimerExtendRequest = await request.json();

    if (!body.draft_session_id || body.pick_number == null) {
      return NextResponse.json(
        { error: 'Missing required fields: draft_session_id, pick_number' },
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

    // Load session to get league_id
    const { data: session } = await supabaseAdmin
      .from('draft_sessions')
      .select('league_id, pick_timer_seconds')
      .eq('id', body.draft_session_id)
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Draft session not found' }, { status: 404 });
    }

    // Commissioner or co-commissioner only
    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', session.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (membership?.role !== 'commissioner' && membership?.role !== 'co_commissioner') {
      return NextResponse.json({ error: 'Only commissioners can extend the timer' }, { status: 403 });
    }

    const { data: extension, error } = await supabaseAdmin
      .from('timer_extensions')
      .insert({
        draft_session_id: body.draft_session_id,
        pick_number: body.pick_number,
        extended_by: user.id,
        extension_seconds: body.extension_seconds,
      })
      .select()
      .single();

    if (error) {
      console.error('Error creating timer extension:', error);
      return NextResponse.json({ error: 'Failed to create timer extension' }, { status: 500 });
    }

    // Broadcast TIMER_EXTENDED (fire-and-forget)
    void (async () => {
      try {
        await supabaseAdmin.channel(`draft:${body.draft_session_id}`).send({
          type: 'broadcast',
          event: 'TIMER_EXTENDED',
          payload: { pick_number: body.pick_number, extension_seconds: body.extension_seconds },
        });
      } catch { /* non-fatal */ }
    })();

    return NextResponse.json({ timer_extension: extension });
  } catch (error) {
    console.error('Error in POST /api/draft/timer/extend:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
