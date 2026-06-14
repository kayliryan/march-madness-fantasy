import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/client';
import { BenchOrderService } from '@/lib/services/BenchOrderService';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import type { LeagueSettings } from '@/lib/types';

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { league_id, injured_player_id, sub_player_id } = body as {
      league_id: string;
      injured_player_id: string;
      sub_player_id?: string;
    };

    if (!league_id || !injured_player_id) {
      return NextResponse.json(
        { error: 'Missing required fields: league_id, injured_player_id' },
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

    // Verify commissioner or co-commissioner
    const { data: member } = await supabase
      .from('league_members')
      .select('role')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!member || (member.role !== 'commissioner' && member.role !== 'co_commissioner')) {
      return NextResponse.json({ error: 'Commissioner access required' }, { status: 403 });
    }

    // Fetch league settings (check injury_sub_enabled)
    const { data: leagueRow } = await supabaseAdmin
      .from('leagues')
      .select('settings, season')
      .eq('id', league_id)
      .single();

    if (!leagueRow) {
      return NextResponse.json({ error: 'League not found' }, { status: 404 });
    }

    const settings = leagueRow.settings as LeagueSettings;
    if (!settings.injury_sub_enabled) {
      return NextResponse.json(
        { error: 'Injury substitutions are not enabled for this league' },
        { status: 400 }
      );
    }

    // Find the injured player's active starter slot
    const { data: injuredSlot } = await supabaseAdmin
      .from('roster_slots')
      .select('id, user_id, slot_key, slot_position, acquired_at_round_stage')
      .eq('league_id', league_id)
      .eq('player_id', injured_player_id)
      .eq('is_active', true)
      .eq('is_bench', false)
      .is('released_at_round_stage', null)
      .maybeSingle();

    if (!injuredSlot) {
      return NextResponse.json(
        { error: 'Injured player has no active starter slot in this league' },
        { status: 404 }
      );
    }

    // Determine the current round stage from this league's own active roster -
    // a global, unscoped query would pick up the most recently-synced game from
    // any league/season, which is wrong in a multi-league environment.
    const { data: activeSlots } = await supabaseAdmin
      .from('roster_slots')
      .select('player_id')
      .eq('league_id', league_id)
      .eq('is_active', true);

    const activePlayerIds = [...new Set((activeSlots ?? []).map((s: { player_id: string }) => s.player_id))];

    const { data: latestGame } = activePlayerIds.length > 0
      ? await supabaseAdmin
          .from('game_scores')
          .select('round_stage')
          .eq('season', leagueRow.season)
          .in('player_id', activePlayerIds)
          .order('created_at', { ascending: false })
          .limit(1)
          .maybeSingle()
      : { data: null };

    const current_round_stage: string = latestGame?.round_stage ?? 'r64';

    // Release the injured player's slot
    await supabaseAdmin
      .from('roster_slots')
      .update({
        is_active: false,
        released_at_round_stage: current_round_stage,
        release_reason: 'injury_sub',
      })
      .eq('id', injuredSlot.id);

    // Determine the incoming sub player
    let subPlayerId: string | null = sub_player_id ?? null;
    if (!subPlayerId) {
      const resolvedPlayer = await BenchOrderService.resolveNext(
        league_id,
        injuredSlot.user_id,
        injuredSlot.slot_position as 'G' | 'F' | 'C',
        settings.sub_eligibility_matrix
      );
      subPlayerId = resolvedPlayer?.id ?? null;
    }

    if (!subPlayerId) {
      return NextResponse.json(
        { error: 'No eligible bench player found for substitution' },
        { status: 422 }
      );
    }

    // Verify the sub player is actually on this user's bench (not already a starter)
    const { data: subBenchSlot } = await supabaseAdmin
      .from('roster_slots')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', injuredSlot.user_id)
      .eq('player_id', subPlayerId)
      .eq('is_active', true)
      .eq('is_bench', true)
      .is('released_at_round_stage', null)
      .maybeSingle();

    if (!subBenchSlot) {
      return NextResponse.json(
        { error: 'Sub player is not on this user\'s active bench' },
        { status: 422 }
      );
    }

    // Release the bench slot for the incoming player
    await supabaseAdmin
      .from('roster_slots')
      .update({
        is_active: false,
        released_at_round_stage: current_round_stage,
        release_reason: 'injury_sub',
      })
      .eq('id', subBenchSlot.id);

    // Activate the sub as a new starter, inheriting the injured player's slot_key
    await supabaseAdmin.from('roster_slots').insert({
      league_id,
      user_id: injuredSlot.user_id,
      player_id: subPlayerId,
      slot_key: injuredSlot.slot_key,
      slot_position: injuredSlot.slot_position,
      is_active: true,
      is_bench: false,
      acquired_at_round_stage: current_round_stage,
    });

    // Recompute scoring for the new starter (non-blocking)
    ScoreAccumulator.runForPlayer(subPlayerId, league_id).catch((err) =>
      console.error('[injury-sub] ScoreAccumulator.runForPlayer failed:', err)
    );

    return NextResponse.json({ ok: true, sub_player_id: subPlayerId });
  } catch (error) {
    console.error('Error in POST /api/commissioner/injury-sub:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
