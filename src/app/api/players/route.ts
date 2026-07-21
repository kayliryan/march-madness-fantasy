import { NextRequest, NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import { getLeaguePositionOverrides, applyLeaguePositionOverride } from '@/lib/services/PlayerPositionOverrides';
import type { GetPlayersResponse, Player } from '@/lib/types';

export async function GET(request: NextRequest) {
  try {
    const searchParams = request.nextUrl.searchParams;
    const position = searchParams.get('position') as 'G' | 'F' | 'C' | null;
    const teamId = searchParams.get('team_id');
    const search = searchParams.get('search');
    const sort = searchParams.get('sort') || 'avg_ppg_desc';
    const leagueId = searchParams.get('league_id');

    let query = supabase
      .from('players')
      .select('*, teams(id, name, short_name, seed, region)')
      .eq('season', 2026);

    // Position filtering is applied in JS below (after league overrides are merged
    // in), not here — filtering the raw column would ignore a league's override.
    if (teamId) {
      query = query.eq('team_id', teamId);
    }

    // Apply sorting
    if (sort === 'name') {
      query = query.order('name', { ascending: true });
    } else if (sort === 'team_seed') {
      query = query.order('seed', { ascending: true, referencedTable: 'teams' });
    } else {
      query = query.order('avg_ppg', { ascending: false });
    }

    const { data: players, error } = await query;

    if (error) {
      return NextResponse.json(
        { error: 'Failed to fetch players' },
        { status: 500 }
      );
    }

    // Merge in this league's position overrides, if a league_id was provided —
    // players.position is a single row shared by every league in a season, so the
    // raw column may not reflect what THIS league sees.
    let withOverrides: Player[] = players ?? [];
    if (leagueId) {
      const overrides = await getLeaguePositionOverrides(supabase, leagueId);
      if (overrides.size > 0) {
        withOverrides = withOverrides.map((p) => applyLeaguePositionOverride(p, overrides));
      }
    }

    if (position) {
      withOverrides = withOverrides.filter((p) => p.position === position);
    }

    // Apply search filter by player name or team name
    let filtered = withOverrides;
    if (search) {
      const searchLower = search.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          p.name.toLowerCase().includes(searchLower) ||
          (p.teams as { name?: string } | null)?.name?.toLowerCase().includes(searchLower)
      );
    }

    const response: GetPlayersResponse = {
      players: filtered,
      total: filtered.length,
    };

    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching players:', error);
    return NextResponse.json(
      { error: 'Internal server error' },
      { status: 500 }
    );
  }
}
