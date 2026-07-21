import { NextRequest, NextResponse } from 'next/server';
import { createServerClient } from '@supabase/ssr';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { getLeaguePositionOverrides, resolvePosition } from '@/lib/services/PlayerPositionOverrides';
import { buildRoundEntries } from '@/lib/utils/roundEntries';
import type { RoundCell } from '@/lib/utils/roundBreakdown';

interface RoundEntry {
  user_id: string;
  display_name: string;
  player_id: string;
  player_name: string;
  team_name: string | null;
  team_seed: number | null;
  position: string;
  is_bench: boolean;
  cell: RoundCell;
}

/** counted/raw sort by value, descending; elim sinks to the bottom. */
function cellSortValue(cell: RoundCell): number {
  if (cell && (cell.kind === 'counted' || cell.kind === 'raw')) return cell.value;
  return -Infinity;
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ league_id: string }> }
) {
  try {
    const { league_id } = await params;

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

    const { data: membership } = await supabase
      .from('league_members')
      .select('id')
      .eq('league_id', league_id)
      .eq('user_id', user.id)
      .maybeSingle();

    if (!membership) {
      return NextResponse.json({ error: 'Not a member of this league' }, { status: 403 });
    }

    // First wave — everything that depends only on league_id (not on the set of
    // player_ids the roster produces): roster history, this league's position
    // overrides, scoring events, and the member list. None depend on each other.
    const [
      { data: slotRows },
      positionOverrides,
      { data: scoringEvents },
      { data: memberRows },
    ] = await Promise.all([
      // Every roster_slots row this league has ever had — including released/bench
      // history — so a player who moved from bench to starter (or was released)
      // still resolves to exactly one row per round via buildRoundEntries().
      supabaseAdmin
        .from('roster_slots')
        .select('id, user_id, player_id, is_bench, acquired_at_round_stage, released_at_round_stage')
        .eq('league_id', league_id),
      // players.position is shared across every league in a season — show THIS
      // league's override, if any, rather than the raw column.
      getLeaguePositionOverrides(supabaseAdmin, league_id),
      supabaseAdmin
        .from('scoring_events')
        .select('user_id, player_id, roster_slot_id, round_stage, points_credited')
        .eq('league_id', league_id)
        .eq('is_stale', false),
      // Display names for every league member, not just those with scoring
      // events — a bench-only member with zero counted points still has rows.
      supabaseAdmin
        .from('league_members')
        .select('user_id')
        .eq('league_id', league_id),
    ]);

    const slots = slotRows ?? [];
    const playerIds = [...new Set(slots.map((s: { player_id: string }) => s.player_id))];
    const memberIds = [...new Set((memberRows ?? []).map((m: { user_id: string }) => m.user_id))];

    // Second wave — the two player-keyed lookups (players, game_scores) need
    // playerIds from the roster query above; the user display-name lookup needs
    // memberIds. All three are mutually independent, so run them together.
    const [{ data: players }, { data: gameScores }, { data: userRows }] = await Promise.all([
      playerIds.length > 0
        ? supabaseAdmin
            .from('players')
            .select('id, name, position, teams ( name, seed )')
            .in('id', playerIds)
        : Promise.resolve({ data: [] as unknown[] }),
      playerIds.length > 0
        ? supabaseAdmin
            .from('game_scores')
            .select('player_id, round_stage, points')
            .in('player_id', playerIds)
        : Promise.resolve({ data: [] as { player_id: string; round_stage: string; points: number }[] }),
      memberIds.length > 0
        ? supabaseAdmin.from('users').select('id, display_name').in('id', memberIds)
        : Promise.resolve({ data: [] as { id: string; display_name: string }[] }),
    ]);

    const playerMap = new Map(
      ((players ?? []) as unknown as {
        id: string;
        name: string;
        position: 'G' | 'F' | 'C';
        teams: { name: string; seed: number } | null;
      }[]).map((p) => [
        p.id,
        {
          name: p.name,
          position: resolvePosition(p.id, p.position, positionOverrides),
          team_name: p.teams?.name ?? null,
          team_seed: p.teams?.seed ?? null,
        },
      ])
    );

    const displayNames = new Map(
      (userRows ?? []).map((u: { id: string; display_name: string }) => [u.id, u.display_name])
    );

    // A round is worth showing once any game has actually been played in it —
    // driven by game_scores (source of truth for "did this round happen"),
    // not scoring_events, since bench rounds may have no credited events at all.
    const playedRoundStages = new Set((gameScores ?? []).map((gs: { round_stage: string }) => gs.round_stage));
    const roundOrder: RoundStage[] = ROUND_STAGE_ORDER.filter(
      (stage) => stage !== 'draft' && playedRoundStages.has(stage)
    );

    const rounds = roundOrder.map((round_stage) => {
      const rows = buildRoundEntries(round_stage, slots, gameScores ?? [], scoringEvents ?? []);

      const entries: RoundEntry[] = rows.map((row) => {
        const player = playerMap.get(row.player_id);
        return {
          user_id: row.user_id,
          display_name: displayNames.get(row.user_id) ?? row.user_id.slice(0, 6),
          player_id: row.player_id,
          player_name: player?.name ?? row.player_id.slice(0, 8),
          team_name: player?.team_name ?? null,
          team_seed: player?.team_seed ?? null,
          position: player?.position ?? '',
          is_bench: row.is_bench,
          cell: row.cell,
        };
      });

      entries.sort((a, b) => cellSortValue(b.cell) - cellSortValue(a.cell));

      return { round_stage, entries };
    });

    return NextResponse.json({ rounds });
  } catch (error) {
    console.error('Error in GET /api/league/[league_id]/rounds:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
