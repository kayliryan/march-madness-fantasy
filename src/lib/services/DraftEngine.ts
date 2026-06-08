import { supabaseAdmin } from '@/lib/supabase/client';
import { getActiveUserId, computeMaxPicks } from '@/lib/utils/draft';
import type { DraftPick, DraftSession, LeagueSettings } from '@/lib/types';

export interface PositionValidationResult {
  valid: boolean;
  unfilled_positions: string[];
  is_bench: boolean;
  slot_key: string;
  slot_position: 'G' | 'F' | 'C';
}

export interface PickResult {
  pick: DraftPick;
  next_pick_number: number;
  active_user_id: string | null;
  is_complete: boolean;
}

// Re-export pure helpers so callers can import from one place
export { getActiveUserId, computeMaxPicks };

// ─── DB-backed helpers ───────────────────────────────────────────────────────

/**
 * Validates whether a player at the given position can be drafted.
 * Returns the slot_key and slot_position to use if valid.
 * Uses supabaseAdmin to bypass RLS — caller must verify auth.
 */
export async function validatePositionEnforcement(
  user_id: string,
  league_id: string,
  player_position: 'G' | 'F' | 'C',
  settings: LeagueSettings
): Promise<PositionValidationResult> {
  const { data: slots } = await supabaseAdmin
    .from('roster_slots')
    .select('slot_position, is_bench')
    .eq('league_id', league_id)
    .eq('user_id', user_id)
    .eq('is_active', true)
    .is('released_at_round_stage', null);

  const activeSlots = slots ?? [];

  const filled: Record<'G' | 'F' | 'C', number> = { G: 0, F: 0, C: 0 };
  let bench_filled = 0;
  for (const s of activeSlots) {
    if (s.is_bench) {
      bench_filled++;
    } else {
      filled[s.slot_position as 'G' | 'F' | 'C']++;
    }
  }

  const required = settings.starter_slots;
  const is_starters_complete =
    (Object.keys(required) as ('G' | 'F' | 'C')[]).every(
      (pos) => filled[pos] >= (required[pos] ?? 0)
    );

  if (!is_starters_complete) {
    const open = (required[player_position] ?? 0) - filled[player_position];
    if (open > 0) {
      const slot_key = `${player_position}${filled[player_position] + 1}`;
      return { valid: true, unfilled_positions: [], is_bench: false, slot_key, slot_position: player_position };
    }
    // Player's position is already filled — find which starters are still open
    const unfilled_positions = (Object.keys(required) as ('G' | 'F' | 'C')[]).filter(
      (pos) => filled[pos] < (required[pos] ?? 0)
    );
    return { valid: false, unfilled_positions, is_bench: false, slot_key: '', slot_position: player_position };
  }

  // Starters complete — this is a bench pick
  if (bench_filled >= settings.bench_slots) {
    return { valid: false, unfilled_positions: [], is_bench: true, slot_key: '', slot_position: player_position };
  }
  const slot_key = `B${bench_filled + 1}`;
  return { valid: true, unfilled_positions: [], is_bench: true, slot_key, slot_position: player_position };
}

// ─── Core pick submission ────────────────────────────────────────────────────

/**
 * Submits a draft pick with full concurrency and position enforcement.
 * Throws typed errors the route handler maps to HTTP responses.
 */
export async function submitPick(
  draft_session_id: string,
  player_id: string,
  expected_pick_number: number,
  user_id: string,
  was_auto_picked = false
): Promise<PickResult> {
  // 1. Load session
  const { data: session, error: sessionErr } = await supabaseAdmin
    .from('draft_sessions')
    .select('*')
    .eq('id', draft_session_id)
    .single();

  if (sessionErr || !session) throw { code: 404, message: 'Draft session not found' };
  if (session.status !== 'live') throw { code: 409, message: 'Draft is not live' };

  // 2. Optimistic lock: current_pick_number must match
  if (session.current_pick_number !== expected_pick_number) {
    throw { code: 409, message: 'Pick number mismatch — another pick was just submitted' };
  }

  // 3. Verify it is the submitting user's turn (skip for auto-picks — engine already verified)
  if (!was_auto_picked) {
    const active_user = getActiveUserId(session.snake_order, session.current_pick_number);
    if (active_user !== user_id) {
      throw { code: 403, message: "It is not your turn to pick" };
    }
  }

  // 4. Player not already drafted
  const { data: existingPick } = await supabaseAdmin
    .from('draft_picks')
    .select('id')
    .eq('draft_session_id', draft_session_id)
    .eq('player_id', player_id)
    .is('voided_at', null)
    .maybeSingle();

  if (existingPick) throw { code: 409, message: 'Player is already drafted' };

  // 5. Load league settings for position enforcement
  const { data: league } = await supabaseAdmin
    .from('leagues')
    .select('settings')
    .eq('id', session.league_id)
    .single();

  if (!league) throw { code: 500, message: 'League not found' };

  const { data: playerRow } = await supabaseAdmin
    .from('players')
    .select('position')
    .eq('id', player_id)
    .single();

  if (!playerRow) throw { code: 404, message: 'Player not found' };

  const settings = league.settings as LeagueSettings;
  const validation = await validatePositionEnforcement(
    user_id,
    session.league_id,
    playerRow.position,
    settings
  );

  if (!validation.valid) {
    throw {
      code: 422,
      error: 'POSITION_ENFORCEMENT',
      message: validation.unfilled_positions.length > 0
        ? `Must fill starter positions first: ${validation.unfilled_positions.join(', ')}`
        : 'Roster is already full',
      unfilled_positions: validation.unfilled_positions,
    };
  }

  // 6. Compute round_number and time_taken_seconds
  const n = session.snake_order.length;
  const round_number = Math.ceil(session.current_pick_number / n);
  const now = new Date();
  const nowIso = now.toISOString();

  let time_taken_seconds: number | undefined;
  if (session.current_pick_number === 1) {
    if (session.started_at) {
      time_taken_seconds = Math.round((now.getTime() - new Date(session.started_at).getTime()) / 1000);
    }
  } else {
    const { data: prevPick } = await supabaseAdmin
      .from('draft_picks')
      .select('picked_at')
      .eq('draft_session_id', draft_session_id)
      .eq('pick_number', session.current_pick_number - 1)
      .is('voided_at', null)
      .maybeSingle();
    if (prevPick) {
      time_taken_seconds = Math.round((now.getTime() - new Date(prevPick.picked_at).getTime()) / 1000);
    }
  }

  // 7. INSERT draft_picks (UNIQUE constraint on session_id+pick_number is the concurrency guard)
  const { data: pick, error: pickErr } = await supabaseAdmin
    .from('draft_picks')
    .insert({
      draft_session_id,
      league_id: session.league_id,
      pick_number: session.current_pick_number,
      round_number,
      user_id,
      player_id,
      picked_at: nowIso,
      time_taken_seconds,
      was_auto_picked,
    })
    .select()
    .single();

  if (pickErr) {
    // Duplicate pick_number means another pick raced ahead — 409
    throw { code: 409, message: 'Pick number already taken — concurrent pick detected' };
  }

  // 8. INSERT roster_slot
  await supabaseAdmin.from('roster_slots').insert({
    league_id: session.league_id,
    user_id,
    player_id,
    slot_key: validation.slot_key,
    slot_position: validation.slot_position,
    is_active: true,
    is_bench: validation.is_bench,
    acquired_at_round_stage: 'draft',
  });

  // 9. Advance current_pick_number
  // NOTE: steps 7–9 are sequential, not wrapped in a Postgres transaction.
  // The UNIQUE constraint on (draft_session_id, pick_number) prevents double-picks.
  // If step 9 fails, current_pick_number stays stale; the next submitter will see
  // their expected_pick_number already has a pick and receive a 409.
  const new_pick_number = session.current_pick_number + 1;
  await supabaseAdmin
    .from('draft_sessions')
    .update({ current_pick_number: new_pick_number })
    .eq('id', draft_session_id);

  // 10. Check for draft completion
  const { count: member_count } = await supabaseAdmin
    .from('league_members')
    .select('*', { count: 'exact', head: true })
    .eq('league_id', session.league_id);

  const max_picks = computeMaxPicks(settings, member_count ?? n);
  const is_complete = new_pick_number > max_picks;

  if (is_complete) {
    await supabaseAdmin
      .from('draft_sessions')
      .update({ status: 'complete', completed_at: nowIso })
      .eq('id', draft_session_id);
  }

  // 11. Compute next active user
  const next_active_user_id = is_complete
    ? null
    : getActiveUserId(session.snake_order, new_pick_number);

  // 12. Broadcast (fire-and-forget — client polling provides fallback)
  void broadcastPickMade(draft_session_id, pick as DraftPick, new_pick_number, next_active_user_id, [player_id], is_complete);

  return {
    pick: pick as DraftPick,
    next_pick_number: new_pick_number,
    active_user_id: next_active_user_id,
    is_complete,
  };
}

// ─── Auto-pick ───────────────────────────────────────────────────────────────

/**
 * Picks the best available player for a user — checks their queue first,
 * then falls back to highest avg_ppg among undrafted players.
 * Returns null if the roster is already complete.
 */
export async function autoPickForUser(
  session: DraftSession,
  user_id: string
): Promise<string | null> {
  // Check if roster is already full
  const { data: league } = await supabaseAdmin
    .from('leagues')
    .select('settings')
    .eq('id', session.league_id)
    .single();
  if (!league) return null;

  const settings = league.settings as LeagueSettings;

  // Get all non-voided picks in the session (to exclude drafted players)
  const { data: picks } = await supabaseAdmin
    .from('draft_picks')
    .select('player_id')
    .eq('draft_session_id', session.id)
    .is('voided_at', null);
  const drafted = new Set((picks ?? []).map((p: { player_id: string }) => p.player_id));

  // Try queue first — fetch player_ids then look up positions separately to avoid join type issues
  const { data: queueItems } = await supabaseAdmin
    .from('draft_queues')
    .select('player_id')
    .eq('draft_session_id', session.id)
    .eq('user_id', user_id)
    .is('removed_at', null)
    .order('queue_position', { ascending: true });

  for (const item of (queueItems ?? []) as { player_id: string }[]) {
    if (drafted.has(item.player_id)) continue;
    const { data: pRow } = await supabaseAdmin
      .from('players')
      .select('position')
      .eq('id', item.player_id)
      .single();
    if (!pRow) continue;
    const position = pRow.position as 'G' | 'F' | 'C';
    const validation = await validatePositionEnforcement(user_id, session.league_id, position, settings);
    if (validation.valid) return item.player_id;
  }

  // Fallback: highest avg_ppg undrafted player that passes position enforcement
  const { data: players } = await supabaseAdmin
    .from('players')
    .select('id, position')
    .eq('season', session.season)
    .order('avg_ppg', { ascending: false });

  for (const p of players ?? []) {
    if (drafted.has(p.id)) continue;
    const validation = await validatePositionEnforcement(user_id, session.league_id, p.position as 'G' | 'F' | 'C', settings);
    if (validation.valid) return p.id;
  }

  return null;
}

// ─── Realtime broadcast ──────────────────────────────────────────────────────

async function broadcastPickMade(
  session_id: string,
  pick: DraftPick,
  next_pick_number: number,
  active_user_id: string | null,
  removed_player_ids: string[],
  is_complete: boolean
) {
  try {
    const channel = supabaseAdmin.channel(`draft:${session_id}`);
    await channel.send({
      type: 'broadcast',
      event: 'PICK_MADE',
      payload: { pick, next_pick_number, active_user_id, available_player_ids_removed: removed_player_ids },
    });
    if (is_complete) {
      await channel.send({
        type: 'broadcast',
        event: 'DRAFT_COMPLETE',
        payload: { session_id },
      });
    }
  } catch {
    // Broadcast failure is non-fatal — client polling provides fallback
  }
}
