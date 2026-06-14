/**
 * Seed script: recreate the user's real 2026 family fantasy league using real
 * March 2026 NCAA tournament data fetched by fetch-real-2026-tournament.ts.
 *
 * Usage:
 *   npx tsx scripts/fetch-real-2026-tournament.ts   (run once, or to refresh)
 *   npx tsx --env-file=.env.local scripts/seed-real-2026-league.ts
 *
 * Idempotent — safe to re-run. Uses season=2025 as a sentinel value, distinct from
 * the fictional season=2026 fixtures used by /demo/league, /demo/draft, etc.
 * (/api/players hardcodes .eq('season', 2026), so this real data won't show up there.)
 */

import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { TEAMS, ROSTER } from './data/real-2026-roster';
import realData from './data/real-2026-data.json';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SEASON = 2025;
const LEAGUE_ID = '00000000-0000-0000-0000-000000000002';

const MEMBERS = [
  { id: '20000000-0000-0000-0000-000000000001', display_name: 'Spoza', email: 'spoza@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000002', display_name: 'Baby Luv', email: 'babyluv@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000003', display_name: 'Bub', email: 'bub@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000004', display_name: 'Sienna', email: 'sienna@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000005', display_name: 'Bit T Bee', email: 'bittbee@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000006', display_name: 'Pooka', email: 'pooka@real2026.marchfantasy.app' },
  { id: '20000000-0000-0000-0000-000000000007', display_name: 'The Dad', email: 'thedad@real2026.marchfantasy.app' },
];

async function seedTeams(): Promise<Map<string, string>> {
  console.log('Seeding teams...');
  const inserts = TEAMS.map((t) => ({
    season: SEASON,
    name: t.name,
    seed: t.seed,
    region: t.region,
    is_eliminated: t.is_eliminated,
    eliminated_in_round_stage: t.eliminated_in_round_stage,
    eliminated_in_round_number: t.eliminated_in_round_number,
    espn_team_id: t.espn_id,
  }));

  const { data, error } = await db.from('teams').upsert(inserts, { onConflict: 'espn_team_id' }).select('id, espn_team_id');
  if (error) throw new Error(`teams upsert: ${error.message}`);

  const map = new Map<string, string>(); // team key -> team uuid
  for (const t of TEAMS) {
    const row = data!.find((r) => r.espn_team_id === t.espn_id);
    if (!row) throw new Error(`team not found after upsert: ${t.key}`);
    map.set(t.key, row.id);
  }
  console.log(`  ${data!.length} teams ready`);
  return map;
}

async function seedPlayers(teamIdByKey: Map<string, string>): Promise<Map<string, string>> {
  console.log('Seeding players...');
  const inserts = ROSTER.map((r) => {
    const espnId = (realData.players as { member: string; slot_key: string; espn_player_id: string | null }[]).find(
      (p) => p.member === r.member && p.slot_key === r.slot_key
    )?.espn_player_id;
    if (!espnId) throw new Error(`missing espn_player_id for ${r.member}/${r.slot_key}`);
    return {
      season: SEASON,
      name: r.player,
      team_id: teamIdByKey.get(r.team),
      position: r.slot_position,
      avg_ppg: r.avg_ppg,
      espn_player_id: espnId,
    };
  });

  const { data, error } = await db.from('players').upsert(inserts, { onConflict: 'espn_player_id' }).select('id, espn_player_id');
  if (error) throw new Error(`players upsert: ${error.message}`);

  const map = new Map<string, string>(); // "member|slot_key" -> player uuid
  for (let i = 0; i < ROSTER.length; i++) {
    const r = ROSTER[i];
    const espnId = inserts[i].espn_player_id;
    const row = data!.find((d) => d.espn_player_id === espnId);
    if (!row) throw new Error(`player not found after upsert: ${r.player}`);
    map.set(`${r.member}|${r.slot_key}`, row.id);
  }
  console.log(`  ${data!.length} players ready`);
  return map;
}

async function seedUsersAndLeague() {
  console.log('Seeding users + league...');

  // Supabase ignores a caller-supplied `user_id` on admin.createUser — it always
  // generates its own UUID for auth.users. So we resolve the real id by email
  // (creating the user first if needed) and use that everywhere downstream,
  // instead of the MEMBERS[].id placeholders.
  const { data: existingUsers } = await db.auth.admin.listUsers();

  for (const m of MEMBERS) {
    let userId = existingUsers.users.find((u) => u.email === m.email)?.id;

    if (!userId) {
      const { data: created, error } = await db.auth.admin.createUser({
        email: m.email,
        email_confirm: true,
        user_metadata: { display_name: m.display_name },
      });
      if (error || !created?.user) throw new Error(`createUser ${m.email}: ${error?.message}`);
      userId = created.user.id;
    }

    m.id = userId;

    const { error: upsertError } = await db.from('users').upsert({ id: m.id, display_name: m.display_name }, { onConflict: 'id' });
    if (upsertError) console.warn(`  users upsert ${m.email}: ${upsertError.message}`);
  }

  const commissionerId = MEMBERS[0].id;
  const { error: leagueError } = await db.from('leagues').upsert(
    {
      id: LEAGUE_ID,
      name: 'Madness 2026 (Real Validation League)',
      season: SEASON,
      commissioner_id: commissionerId,
      is_demo: false,
      settings: {
        draft_type: 'snake',
        pick_timer_seconds: 60,
        starter_slots: { G: 2, F: 2, C: 1 },
        bench_slots: 3,
        scoring_includes_play_in: false,
        activation_timing: 'immediate',
        sub_eligibility_matrix: { G: ['G'], F: ['F', 'G'], C: ['C', 'F'] },
        injury_sub_enabled: false,
        injury_sub_reversible: false,
      },
    },
    { onConflict: 'id' }
  );
  if (leagueError) throw new Error(`league upsert: ${leagueError.message}`);

  // No unique constraint on (league_id, user_id) — clear and re-insert for idempotency
  const { error: delError } = await db.from('league_members').delete().eq('league_id', LEAGUE_ID);
  if (delError) throw new Error(`league_members delete: ${delError.message}`);

  const { error } = await db.from('league_members').insert(
    MEMBERS.map((m) => ({ league_id: LEAGUE_ID, user_id: m.id, role: m.id === commissionerId ? 'commissioner' : 'member' }))
  );
  if (error) throw new Error(`league_members insert: ${error.message}`);
  console.log(`  league + ${MEMBERS.length} members ready`);
}

async function seedRosterSlots(playerIdByKey: Map<string, string>) {
  console.log('Seeding roster_slots...');
  const inserts = ROSTER.map((r) => {
    const member = MEMBERS.find((m) => m.display_name === r.member);
    if (!member) throw new Error(`unknown member: ${r.member}`);
    return {
      league_id: LEAGUE_ID,
      user_id: member.id,
      player_id: playerIdByKey.get(`${r.member}|${r.slot_key}`),
      slot_key: r.slot_key,
      slot_position: r.slot_position,
      is_active: true,
      is_bench: r.is_bench,
      acquired_at_round_stage: 'draft',
    };
  });

  // Clear any existing slots for this league first (idempotent re-seed)
  const { error: delError } = await db.from('roster_slots').delete().eq('league_id', LEAGUE_ID);
  if (delError) throw new Error(`roster_slots delete: ${delError.message}`);

  const { error } = await db.from('roster_slots').insert(inserts);
  if (error) throw new Error(`roster_slots insert: ${error.message}`);
  console.log(`  ${inserts.length} roster_slots ready`);
}

async function seedGameScores(playerIdByKey: Map<string, string>) {
  console.log('Seeding game_scores...');
  const inserts = (realData.game_scores as { member: string; slot_key: string; round_stage: string; game_date: string; points: number }[]).map(
    (g) => ({
      player_id: playerIdByKey.get(`${g.member}|${g.slot_key}`),
      season: SEASON,
      round_stage: g.round_stage,
      round_number: 1,
      game_date: g.game_date,
      game_status: 'final' as const,
      points: g.points,
      source: 'espn_api' as const,
    })
  );

  const { error } = await db.from('game_scores').upsert(inserts, { onConflict: 'player_id,round_stage,round_number,game_date' });
  if (error) throw new Error(`game_scores upsert: ${error.message}`);
  console.log(`  ${inserts.length} game_scores ready`);
}

async function run() {
  const teamIdByKey = await seedTeams();
  const playerIdByKey = await seedPlayers(teamIdByKey);
  await seedUsersAndLeague();
  await seedRosterSlots(playerIdByKey);
  await seedGameScores(playerIdByKey);

  console.log('Running ScoreAccumulator.runForLeague...');
  await ScoreAccumulator.runForLeague(LEAGUE_ID);

  const { data: snapshots } = await db
    .from('leaderboard_snapshots')
    .select('user_id, total_points')
    .eq('league_id', LEAGUE_ID)
    .order('total_points', { ascending: false });

  console.log('\nFinal leaderboard (compare against your manual spreadsheet totals):');
  (snapshots ?? []).forEach((s, i) => {
    const name = MEMBERS.find((m) => m.id === s.user_id)?.display_name ?? s.user_id;
    console.log(`  ${i + 1}. ${name}: ${s.total_points} pts`);
  });

  console.log(`\nDone. LEAGUE_ID=${LEAGUE_ID}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
