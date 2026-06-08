import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import type { DraftPick } from '@/lib/types';

interface VoidPickRequest {
  pick_id: string;
  void_reason: string;
  replacement_player_id: string;
}

export async function PATCH(request: NextRequest) {
  try {
    const body: VoidPickRequest = await request.json();

    if (!body.pick_id || !body.void_reason?.trim() || !body.replacement_player_id) {
      return NextResponse.json(
        { error: 'Missing required fields: pick_id, void_reason, replacement_player_id' },
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

    // Load the pick to void
    const { data: pick } = await supabaseAdmin
      .from('draft_picks')
      .select('*')
      .eq('id', body.pick_id)
      .single();

    if (!pick) {
      return NextResponse.json({ error: 'Pick not found' }, { status: 404 });
    }
    if (pick.voided_at) {
      return NextResponse.json({ error: 'Pick is already voided' }, { status: 409 });
    }

    // Commissioner only
    const { data: membership } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', pick.league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (membership?.role !== 'commissioner' && membership?.role !== 'co_commissioner') {
      return NextResponse.json({ error: 'Only a commissioner can void picks' }, { status: 403 });
    }

    // Replacement player must not already be drafted (non-voided)
    const { data: existingReplacementPick } = await supabaseAdmin
      .from('draft_picks')
      .select('id')
      .eq('draft_session_id', pick.draft_session_id)
      .eq('player_id', body.replacement_player_id)
      .is('voided_at', null)
      .maybeSingle();

    if (existingReplacementPick) {
      return NextResponse.json(
        { error: 'Replacement player is already drafted' },
        { status: 409 }
      );
    }

    const now = new Date().toISOString();

    // Void the original pick
    const { data: voidedPick, error: voidErr } = await supabaseAdmin
      .from('draft_picks')
      .update({ voided_at: now, voided_by: user.id, void_reason: body.void_reason.trim() })
      .eq('id', body.pick_id)
      .select()
      .single();

    if (voidErr) {
      console.error('Error voiding pick:', voidErr);
      return NextResponse.json({ error: 'Failed to void pick' }, { status: 500 });
    }

    // Release the old roster_slot
    await supabaseAdmin
      .from('roster_slots')
      .update({
        is_active: false,
        released_at_round_stage: 'draft',
        release_reason: 'correction',
        override_by: user.id,
        override_reason: body.void_reason.trim(),
      })
      .eq('league_id', pick.league_id)
      .eq('user_id', pick.user_id)
      .eq('player_id', pick.player_id)
      .is('released_at_round_stage', null);

    // Load replacement player position for slot
    const { data: replacementPlayer } = await supabaseAdmin
      .from('players')
      .select('position')
      .eq('id', body.replacement_player_id)
      .single();

    // Insert correction pick (same pick_number = self-referential void+replace)
    const { data: correctionPick, error: corrErr } = await supabaseAdmin
      .from('draft_picks')
      .insert({
        draft_session_id: pick.draft_session_id,
        league_id: pick.league_id,
        pick_number: pick.pick_number,
        round_number: pick.round_number,
        user_id: pick.user_id,
        player_id: body.replacement_player_id,
        picked_at: now,
        was_auto_picked: false,
        replaces_pick_id: body.pick_id,
      })
      .select()
      .single();

    if (corrErr) {
      console.error('Error inserting correction pick:', corrErr);
      return NextResponse.json({ error: 'Failed to insert correction pick' }, { status: 500 });
    }

    // Insert new roster_slot for replacement player
    // Inherit the slot_key from the voided slot
    const { data: oldSlot } = await supabaseAdmin
      .from('roster_slots')
      .select('slot_key, is_bench')
      .eq('league_id', pick.league_id)
      .eq('user_id', pick.user_id)
      .eq('player_id', pick.player_id)
      .single();

    if (oldSlot && replacementPlayer) {
      await supabaseAdmin.from('roster_slots').insert({
        league_id: pick.league_id,
        user_id: pick.user_id,
        player_id: body.replacement_player_id,
        slot_key: oldSlot.slot_key,
        slot_position: replacementPlayer.position,
        is_active: true,
        is_bench: oldSlot.is_bench,
        acquired_at_round_stage: 'draft',
      });
    }

    return NextResponse.json({
      voided_pick: voidedPick as DraftPick,
      correction_pick: correctionPick as DraftPick,
    });
  } catch (error) {
    console.error('Error in PATCH /api/commissioner/pick/void:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
