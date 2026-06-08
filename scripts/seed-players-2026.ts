/**
 * Seed script: Populate teams and players for 2026 season
 * Usage: npx tsx scripts/seed-players-2026.ts
 *
 * Uses service role key to bypass RLS.
 * Idempotent: safe to run multiple times.
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import teamsData from '@/mocks/fixtures/espn/teams-2026.json';

// Node < 22 has no global WebSocket; supabase-js constructs a realtime client
// (which needs one) eagerly, even though this script never uses realtime.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket ??= ws;
import playersData from '@/mocks/fixtures/espn/players-2026.json';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

const SEASON = 2026;

async function seedTeams() {
  console.log('🏀 Seeding teams...');

  const teamInserts = teamsData.map((team) => ({
    season: SEASON,
    name: team.name,
    seed: team.seed,
    region: team.region,
    is_eliminated: false,
    espn_team_id: `espn-${team.name.replace(/\s+/g, '-').toLowerCase()}`,
  }));

  // Upsert to avoid duplicates
  const { data: teams, error: teamError } = await supabase
    .from('teams')
    .upsert(teamInserts, {
      onConflict: 'espn_team_id',
    })
    .select();

  if (teamError) {
    console.error('❌ Error seeding teams:', teamError);
    return [];
  }

  console.log(`✅ Seeded ${teams.length} teams`);
  return teams;
}

interface SeededTeam {
  id: string;
  name: string;
}

async function seedPlayers(teams: SeededTeam[]) {
  console.log('👥 Seeding players...');

  // Map team names to team IDs
  const teamMap = new Map(teams.map((t) => [t.name, t.id]));

  const playerInserts = playersData
    .map((player, index) => {
      const teamId = teamMap.get(player.espn_team_name);
      if (!teamId) {
        console.warn(`⚠️  Team not found for player ${player.name}`);
        return null;
      }

      return {
        season: SEASON,
        name: player.name,
        team_id: teamId,
        position: player.position,
        position_overridden: false,
        avg_ppg: Math.round(player.avg_ppg * 100) / 100, // Round to 2 decimals
        injury_status: null,
        injury_note: null,
        espn_player_id: `espn-player-${index}-${SEASON}`,
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  // Upsert to avoid duplicates
  const { data: players, error: playerError } = await supabase
    .from('players')
    .upsert(playerInserts, {
      onConflict: 'espn_player_id',
    })
    .select();

  if (playerError) {
    console.error('❌ Error seeding players:', playerError);
    return [];
  }

  console.log(`✅ Seeded ${players.length} players`);
  return players;
}

async function main() {
  console.log(`🌱 Starting seed for season ${SEASON}\n`);

  try {
    const teams = await seedTeams();
    if (teams.length === 0) {
      console.error('Failed to seed teams');
      process.exit(1);
    }

    const players = await seedPlayers(teams);
    if (players.length === 0) {
      console.error('Failed to seed players');
      process.exit(1);
    }

    console.log('\n✨ Seed completed successfully!');
    console.log(`📊 Final counts: ${teams.length} teams, ${players.length} players`);
  } catch (error) {
    console.error('❌ Seed failed:', error);
    process.exit(1);
  }
}

main();
