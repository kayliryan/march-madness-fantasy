/**
 * Seed script: replaces the fictional demo season (season=2026 in `teams`/
 * `players`/`game_scores`) with the real 2026 NCAA tournament data fetched by
 * fetch-full-2026-tournament.ts + backfill-positions-2026.ts +
 * backfill-full-2026-metadata.ts (scripts/data/full-2026-tournament-data.json).
 *
 * After this runs, `seedDemoData.ts` needs zero changes to source teams/players
 * from the real pool — it already queries `teams`/`players` live by `season`,
 * not from the old fixture JSON files (those are now unused, not deleted by
 * this script, in case you want them back later — just no longer referenced).
 *
 * IMPORTANT — this deletes data:
 * 1. Every currently-provisioned demo league (is_demo=true), regardless of
 *    TTL/orphan status, and everything under it (draft state, rosters,
 *    scoring). This is unavoidable: those leagues' roster_slots/draft_picks
 *    reference the OLD fictional player/team rows by id, and Postgres will
 *    reject deleting a referenced row (no ON DELETE CASCADE on those FKs).
 *    If you have a demo league open right now that you care about, note its
 *    league_id before running this — it will not survive.
 * 2. The old fictional teams/players themselves (season=2026, matched by
 *    their synthetic `espn-*`/`espn-player-*` id pattern from
 *    seed-players-2026.ts — real ESPN ids are numeric, so there's no
 *    collision risk with what this script inserts).
 *
 * Idempotent from that point on: re-running upserts the same real teams/
 * players/game_scores by their real (numeric) espn ids.
 *
 * Usage:
 *   npx tsx --env-file=.env.local scripts/seed-full-2026-tournament.ts
 */

import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import fullData from './data/full-2026-tournament-data.json';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SEASON = 2026;

async function purgeDemoLeagues() {
  console.log('Purging existing demo leagues (they reference the fictional pool we are about to delete)...');

  const { data: demoLeagues, error: leaguesError } = await db
    .from('leagues')
    .select('id')
    .eq('is_demo', true);
  if (leaguesError) throw new Error(`select demo leagues: ${leaguesError.message}`);

  const leagueIds = (demoLeagues ?? []).map((l) => l.id);
  if (leagueIds.length === 0) {
    console.log('  no demo leagues found');
    return;
  }

  const { data: sessions, error: sessionsError } = await db
    .from('draft_sessions')
    .select('id')
    .in('league_id', leagueIds);
  if (sessionsError) throw new Error(`select draft_sessions: ${sessionsError.message}`);
  const sessionIds = (sessions ?? []).map((s) => s.id);

  if (sessionIds.length > 0) {
    const { error } = await db.from('timer_extensions').delete().in('draft_session_id', sessionIds);
    if (error) throw new Error(`delete timer_extensions: ${error.message}`);
  }

  const leagueScopedTables = [
    'scoring_events',
    'leaderboard_snapshots',
    'roster_slots',
    'draft_picks',
    'draft_queues',
    'bench_orders',
    'league_notifications',
    'draft_sessions',
    'league_invites',
    'league_player_position_overrides',
    'league_members',
  ] as const;

  for (const table of leagueScopedTables) {
    const { error } = await db.from(table).delete().in('league_id', leagueIds);
    if (error) throw new Error(`delete ${table}: ${error.message}`);
  }

  const { error: deleteLeaguesError } = await db.from('leagues').delete().in('id', leagueIds);
  if (deleteLeaguesError) throw new Error(`delete leagues: ${deleteLeaguesError.message}`);

  console.log(`  purged ${leagueIds.length} demo league(s)`);
}

async function purgeFictionalPool() {
  console.log('Purging old fictional season=2026 teams/players...');

  const { data: fictionalPlayers, error: selError } = await db
    .from('players')
    .select('id')
    .eq('season', SEASON)
    .like('espn_player_id', 'espn-player-%');
  if (selError) throw new Error(`select fictional players: ${selError.message}`);

  const fictionalPlayerIds = (fictionalPlayers ?? []).map((p) => p.id);
  // Batched: a single .in() with 300+ UUIDs serializes into the request URL
  // and can exceed the server's max URI length ("URI too long").
  const BATCH = 100;
  for (let i = 0; i < fictionalPlayerIds.length; i += BATCH) {
    const batch = fictionalPlayerIds.slice(i, i + BATCH);
    const { error } = await db.from('game_scores').delete().in('player_id', batch);
    if (error) throw new Error(`delete fictional game_scores (batch ${i}): ${error.message}`);
  }
  for (let i = 0; i < fictionalPlayerIds.length; i += BATCH) {
    const batch = fictionalPlayerIds.slice(i, i + BATCH);
    const { error } = await db.from('players').delete().in('id', batch);
    if (error) throw new Error(`delete fictional players (batch ${i}): ${error.message}`);
  }
  console.log(`  removed ${fictionalPlayerIds.length} fictional players (+ their game_scores)`);

  const { error: teamsDeleteError, count } = await db
    .from('teams')
    .delete({ count: 'exact' })
    .eq('season', SEASON)
    .like('espn_team_id', 'espn-%');
  if (teamsDeleteError) throw new Error(`delete fictional teams: ${teamsDeleteError.message}`);
  console.log(`  removed ${count ?? 0} fictional teams`);
}

interface RealTeam {
  espn_team_id: string;
  name: string;
  seed: number;
  region: string;
  is_eliminated: boolean;
  eliminated_in_round_stage: string | null;
}
interface RealPlayer {
  espn_player_id: string;
  name: string;
  espn_team_id: string;
  position: 'G' | 'F' | 'C';
  avg_ppg: number;
}
interface RealGameStat {
  espn_player_id: string;
  round_stage: string;
  game_date: string;
  points: number;
}

async function seedRealTeams(): Promise<Map<string, string>> {
  console.log('Seeding real teams...');
  const teams = fullData.teams as RealTeam[];
  const inserts = teams.map((t) => ({
    season: SEASON,
    name: t.name,
    seed: t.seed,
    region: t.region,
    is_eliminated: t.is_eliminated,
    eliminated_in_round_stage: t.eliminated_in_round_stage,
    espn_team_id: t.espn_team_id,
    synced_at: new Date().toISOString(),
  }));

  const { data, error } = await db.from('teams').upsert(inserts, { onConflict: 'espn_team_id' }).select('id, espn_team_id');
  if (error) throw new Error(`teams upsert: ${error.message}`);

  const map = new Map<string, string>(); // espn_team_id -> team uuid
  for (const row of data ?? []) map.set(row.espn_team_id, row.id);
  console.log(`  ${data?.length ?? 0} teams ready`);
  return map;
}

async function seedRealPlayers(teamIdByEspnId: Map<string, string>): Promise<Map<string, string>> {
  console.log('Seeding real players...');
  const players = fullData.players as RealPlayer[];
  const inserts = players.map((p) => {
    const teamId = teamIdByEspnId.get(p.espn_team_id);
    if (!teamId) throw new Error(`no team found for player ${p.name} (espn_team_id ${p.espn_team_id})`);
    return {
      season: SEASON,
      name: p.name,
      team_id: teamId,
      position: p.position,
      position_overridden: false,
      avg_ppg: p.avg_ppg,
      espn_player_id: p.espn_player_id,
      synced_at: new Date().toISOString(),
    };
  });

  const map = new Map<string, string>(); // espn_player_id -> player uuid
  const BATCH = 200;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const { data, error } = await db.from('players').upsert(batch, { onConflict: 'espn_player_id' }).select('id, espn_player_id');
    if (error) throw new Error(`players upsert (batch ${i}): ${error.message}`);
    for (const row of data ?? []) map.set(row.espn_player_id, row.id);
  }
  console.log(`  ${map.size} players ready`);
  return map;
}

async function seedRealGameScores(playerIdByEspnId: Map<string, string>) {
  console.log('Seeding real game_scores...');
  const stats = fullData.game_stats as RealGameStat[];
  const inserts = stats
    .map((gs) => {
      const playerId = playerIdByEspnId.get(gs.espn_player_id);
      if (!playerId) return null;
      return {
        player_id: playerId,
        season: SEASON,
        round_stage: gs.round_stage,
        round_number: 1,
        game_date: gs.game_date,
        game_status: 'final' as const,
        points: gs.points,
        source: 'espn_api' as const,
        synced_at: new Date().toISOString(),
      };
    })
    .filter((x): x is NonNullable<typeof x> => x !== null);

  const BATCH = 200;
  for (let i = 0; i < inserts.length; i += BATCH) {
    const batch = inserts.slice(i, i + BATCH);
    const { error } = await db
      .from('game_scores')
      .upsert(batch, { onConflict: 'player_id,round_stage,round_number,game_date' });
    if (error) throw new Error(`game_scores upsert (batch ${i}): ${error.message}`);
  }
  console.log(`  ${inserts.length} game_scores ready`);
}

async function run() {
  await purgeDemoLeagues();
  await purgeFictionalPool();

  const teamIdByEspnId = await seedRealTeams();
  const playerIdByEspnId = await seedRealPlayers(teamIdByEspnId);
  await seedRealGameScores(playerIdByEspnId);

  console.log('\nDone. Demo leagues provisioned from now on will draft from the real 2026 tournament pool.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
