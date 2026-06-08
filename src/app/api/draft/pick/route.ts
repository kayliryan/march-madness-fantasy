import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { submitPick } from '@/lib/services/DraftEngine';

export async function POST(request: NextRequest) {
  try {
    const body: {
      draft_session_id: string;
      player_id: string;
      expected_pick_number: number;
    } = await request.json();

    if (!body.draft_session_id || !body.player_id || body.expected_pick_number == null) {
      return NextResponse.json(
        { error: 'Missing required fields: draft_session_id, player_id, expected_pick_number' },
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

    const result = await submitPick(
      body.draft_session_id,
      body.player_id,
      body.expected_pick_number,
      user.id
    );

    return NextResponse.json({
      pick: result.pick,
      next_pick_number: result.next_pick_number,
      active_user_id: result.active_user_id,
    });
  } catch (err: unknown) {
    const e = err as { code?: number; error?: string; message?: string; unfilled_positions?: string[] };
    if (e.code === 409) {
      return NextResponse.json({ error: e.message }, { status: 409 });
    }
    if (e.code === 403) {
      return NextResponse.json({ error: e.message }, { status: 403 });
    }
    if (e.code === 422) {
      return NextResponse.json(
        { error: e.error ?? 'UNPROCESSABLE', message: e.message, unfilled_positions: e.unfilled_positions ?? [] },
        { status: 422 }
      );
    }
    console.error('Error in POST /api/draft/pick:', err);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
