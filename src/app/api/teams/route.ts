import { NextResponse } from 'next/server';
import { supabase } from '@/lib/supabase/client';
import type { GetTeamsResponse } from '@/lib/types';

export async function GET() {
  try {
    const { data: teams, error } = await supabase
      .from('teams')
      .select('id, name, seed, region')
      .eq('season', 2026)
      .order('region', { ascending: true })
      .order('seed', { ascending: true });

    if (error) {
      return NextResponse.json({ error: 'Failed to fetch teams' }, { status: 500 });
    }

    const response: GetTeamsResponse = { teams: teams ?? [] };
    return NextResponse.json(response);
  } catch (error) {
    console.error('Error fetching teams:', error);
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 });
  }
}
