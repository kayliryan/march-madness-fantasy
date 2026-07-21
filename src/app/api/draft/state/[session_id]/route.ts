import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { getActiveUserId, autoPickForUser, submitPick } from '@/lib/services/DraftEngine';
import type { DraftSession, DraftPick, Player } from '@/lib/types';

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ session_id: string }> }
) {
  try {
    const { session_id } = await params;

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

    // Load session (supabaseAdmin so we can do auto-pick logic below)
    const { data: session } = await supabaseAdmin
      .from('draft_sessions')
      .select('*')
      .eq('id', session_id)
      .single();

    if (!session) {
      return NextResponse.json({ error: 'Draft session not found' }, { status: 404 });
    }

    // Verify the user is a member of this league
    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', session.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    // ── Server-side auto-pick enforcement ────────────────────────────────────
    // If the timer has expired and the draft is live, the server auto-picks.
    // Client polling drives this; the client countdown is cosmetic only.
    if (session.status === 'live' && session.pick_timer_seconds) {
      const { data: recentPicks } = await supabaseAdmin
        .from('draft_picks')
        .select('*')
        .eq('draft_session_id', session_id)
        .is('voided_at', null)
        .order('pick_number', { ascending: false })
        .limit(1);

      const latestPick = recentPicks?.[0] as DraftPick | undefined;

      // Timer starts at session.started_at for pick 1, last pick's picked_at for subsequent
      const timer_start: Date = latestPick
        ? new Date(latestPick.picked_at)
        : session.started_at
          ? new Date(session.started_at)
          : new Date();

      // Also account for any extensions on the current pick_number
      const { data: extensions } = await supabaseAdmin
        .from('timer_extensions')
        .select('extension_seconds')
        .eq('draft_session_id', session_id)
        .eq('pick_number', session.current_pick_number);

      const bonus_seconds = (extensions ?? []).reduce(
        (sum: number, e: { extension_seconds: number | null }) => sum + (e.extension_seconds ?? 0),
        0
      );

      const deadline = new Date(
        timer_start.getTime() + (session.pick_timer_seconds + bonus_seconds) * 1000
      );

      if (new Date() > deadline) {
        const active_user_id = getActiveUserId(session.snake_order, session.current_pick_number);
        const auto_player_id = await autoPickForUser(session as DraftSession, active_user_id);

        if (auto_player_id) {
          try {
            await submitPick(session_id, auto_player_id, session.current_pick_number, active_user_id, true);
          } catch {
            // 409 = concurrent auto-pick already happened — reload below handles both cases
          }
          // Always reload session state after an auto-pick attempt so the snapshot reflects
          // the current pick_number regardless of which instance won the race.
          const { data: refreshed } = await supabaseAdmin
            .from('draft_sessions')
            .select('*')
            .eq('id', session_id)
            .single();
          if (refreshed) Object.assign(session, refreshed);
        }
      }
    }

    // ── Build snapshot ───────────────────────────────────────────────────────
    const { data: allPicks } = await supabaseAdmin
      .from('draft_picks')
      .select('*')
      .eq('draft_session_id', session_id)
      .is('voided_at', null)
      .order('pick_number', { ascending: true });

    const draftedIds = new Set((allPicks ?? []).map((p: DraftPick) => p.player_id));

    const { data: allPlayers } = await supabaseAdmin
      .from('players')
      .select('*, teams(id, name, short_name, seed, region)')
      .eq('season', session.season)
      .order('avg_ppg', { ascending: false });

    const available_players = (allPlayers ?? []).filter(
      (p: Player) => !draftedIds.has(p.id)
    ) as Player[];

    // Compute time_remaining_seconds for current turn
    let time_remaining_seconds: number | null = null;
    if (session.status === 'live' && session.pick_timer_seconds) {
      const latestPickForTimer = (allPicks ?? []).find(
        (p: DraftPick) => p.pick_number === session.current_pick_number - 1
      ) as DraftPick | undefined;

      const timer_start: Date = latestPickForTimer
        ? new Date(latestPickForTimer.picked_at)
        : session.started_at
          ? new Date(session.started_at)
          : new Date();

      const { data: extensions } = await supabaseAdmin
        .from('timer_extensions')
        .select('extension_seconds')
        .eq('draft_session_id', session_id)
        .eq('pick_number', session.current_pick_number);

      const bonus = (extensions ?? []).reduce(
        (sum: number, e: { extension_seconds: number | null }) => sum + (e.extension_seconds ?? 0),
        0
      );

      const deadline = new Date(
        timer_start.getTime() + (session.pick_timer_seconds + bonus) * 1000
      );
      time_remaining_seconds = Math.max(0, Math.round((deadline.getTime() - Date.now()) / 1000));
    }

    const n = session.snake_order.length;
    const active_user_id = session.status === 'live' && n > 0
      ? getActiveUserId(session.snake_order, session.current_pick_number)
      : null;

    const round_number = n > 0 ? Math.ceil(session.current_pick_number / n) : 1;

    // Fetch participant display names for the draft order strip
    const { data: members } = await supabaseAdmin
      .from('league_members')
      .select('user_id')
      .eq('league_id', session.league_id);

    const memberUserIds = (members ?? []).map((m: { user_id: string }) => m.user_id);
    const { data: userRows } = memberUserIds.length > 0
      ? await supabaseAdmin.from('users').select('id, display_name').in('id', memberUserIds)
      : { data: [] };

    const display_names: Record<string, string> = {};
    for (const u of (userRows ?? []) as { id: string; display_name: string }[]) {
      display_names[u.id] = u.display_name;
    }

    return NextResponse.json({
      session: session as DraftSession,
      picks: (allPicks ?? []) as DraftPick[],
      available_players,
      display_names,
      current_turn: {
        user_id: active_user_id,
        pick_number: session.current_pick_number,
        round_number,
        time_remaining_seconds,
      },
    });
  } catch (error) {
    console.error('Error in GET /api/draft/state/[session_id]:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
