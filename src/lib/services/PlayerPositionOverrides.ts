import type { SupabaseClient } from '@supabase/supabase-js';

/**
 * League-scoped player position overrides.
 *
 * `players.position` is a single row shared by every league in a season — it is
 * NOT league-specific. A commissioner "correcting" a player's position in one
 * league must not silently change what every other league sees for that same
 * player. All game logic that enforces or displays a position (draft slot
 * enforcement, bench-sub eligibility, roster/leaderboard display) should read
 * the *effective* position for the calling league via the helpers below rather
 * than trusting `players.position` directly.
 */

export type Position = 'G' | 'F' | 'C';

/** Fetches this league's position overrides as a player_id -> position map. */
export async function getLeaguePositionOverrides(
  supabase: SupabaseClient,
  leagueId: string
): Promise<Map<string, Position>> {
  const { data } = await supabase
    .from('league_player_position_overrides')
    .select('player_id, position')
    .eq('league_id', leagueId);

  return new Map((data ?? []).map((row) => [row.player_id as string, row.position as Position]));
}

/** Resolves a single player's effective position for a league (override, else canonical). */
export function resolvePosition(
  playerId: string,
  canonicalPosition: Position,
  overrides: Map<string, Position>
): Position {
  return overrides.get(playerId) ?? canonicalPosition;
}

/**
 * Returns a copy of `player` with `position` (and `position_overridden`) swapped
 * to reflect this league's override, if one exists. Leaves everything else as-is.
 */
export function applyLeaguePositionOverride<T extends { id: string; position: Position; position_overridden?: boolean }>(
  player: T,
  overrides: Map<string, Position>
): T {
  const override = overrides.get(player.id);
  if (!override) return player;
  return { ...player, position: override, position_overridden: true };
}
