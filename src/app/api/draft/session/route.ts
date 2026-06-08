import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import type { DraftSession } from '@/lib/types';

interface UpsertDraftSessionRequest {
  league_id: string;
  season: number;
  scheduled_start?: string;
  pick_timer_seconds?: number;
  draft_type?: DraftSession['draft_type'];
  snake_order?: string[];
}

/**
 * Creates or updates the draft session for a league (commissioner-only).
 * RLS ("commissioners_can_create/update_draft_sessions") enforces that only a
 * commissioner or co-commissioner may write.
 */
export async function POST(request: NextRequest) {
  try {
    const body: UpsertDraftSessionRequest = await request.json();

    if (!body.league_id || !body.season) {
      return NextResponse.json(
        { error: 'Missing required fields: league_id, season' },
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

    // Build the set of fields to write, omitting undefined ones
    const fields: Partial<DraftSession> = {};
    if (body.scheduled_start !== undefined) fields.scheduled_start = body.scheduled_start;
    if (body.pick_timer_seconds !== undefined) fields.pick_timer_seconds = body.pick_timer_seconds;
    if (body.draft_type !== undefined) fields.draft_type = body.draft_type;
    if (body.snake_order !== undefined) fields.snake_order = body.snake_order;

    // Is there already a draft session for this league?
    const { data: existing } = await supabase
      .from('draft_sessions')
      .select('id')
      .eq('league_id', body.league_id)
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();

    let session: DraftSession | null = null;

    if (existing) {
      const { data, error } = await supabase
        .from('draft_sessions')
        .update(fields)
        .eq('id', existing.id)
        .select()
        .single();

      if (error) {
        console.error('Error updating draft session:', error);
        return NextResponse.json({ error: 'Failed to update draft session' }, { status: 500 });
      }
      session = data as DraftSession;
    } else {
      const { data, error } = await supabase
        .from('draft_sessions')
        .insert({
          league_id: body.league_id,
          season: body.season,
          status: 'scheduled',
          draft_type: body.draft_type ?? 'snake',
          scheduled_start: body.scheduled_start ?? new Date().toISOString(),
          snake_order: body.snake_order ?? [],
          current_pick_number: 1,
          pick_timer_seconds: body.pick_timer_seconds,
        })
        .select()
        .single();

      if (error) {
        console.error('Error creating draft session:', error);
        return NextResponse.json({ error: 'Failed to create draft session' }, { status: 500 });
      }
      session = data as DraftSession;
    }

    return NextResponse.json({ draft_session: session }, { status: 200 });
  } catch (error) {
    console.error('Error in POST /api/draft/session:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
