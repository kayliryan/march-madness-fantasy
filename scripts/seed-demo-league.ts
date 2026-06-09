/**
 * Seed script: Create demo league with tournament data through Elite 8
 * Usage: npx tsx --env-file=.env.local scripts/seed-demo-league.ts
 *
 * Idempotent — safe to re-run. Creates fixed-UUID demo users + demo league.
 * Requires players + teams to already be seeded (run seed-players-2026.ts first).
 */

import { createClient } from '@supabase/supabase-js';
import ws from 'ws';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).WebSocket ??= ws;

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SEASON = 2026;

// Fixed UUIDs so script is idempotent
const DEMO_LEAGUE_ID = process.env.DEMO_LEAGUE_ID ?? '00000000-demo-0000-0000-000000000001';

const DEMO_USERS = [
  { id: '10000000-0000-0000-0000-000000000001', display_name: 'Alex Thompson', email: 'alex@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000002', display_name: 'Jordan Lee', email: 'jordan@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000003', display_name: 'Sam Rivera', email: 'sam@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000004', display_name: 'Casey Morgan', email: 'casey@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000005', display_name: 'Morgan Chen', email: 'morgan@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000006', display_name: 'Riley Park', email: 'riley@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000007', display_name: 'Avery Johnson', email: 'avery@demo.marchfantasy.app' },
  { id: '10000000-0000-0000-0000-000000000008', display_name: 'Taylor Kim', email: 'taylor@demo.marchfantasy.app' },
];

// Rounds in which each seed tier is eliminated (null = not eliminated through E8)
// Seeds 1-2: survive to E8 (eliminated in E8 except seed 1s which go to F4 — but we seed through E8 so they're alive)
// Seeds 3-4: eliminated in S16
// Seeds 5-8: eliminated in R32
// Seeds 9-12: eliminated in R64
// Seeds 13-16 + play-in losers: eliminated in play_in or R64
function getEliminationRound(seed: number, isPlayInLoser: boolean): string | null {
  if (isPlayInLoser) return 'play_in';
  if (seed <= 2) return null;   // alive through E8
  if (seed <= 4) return 's16';
  if (seed <= 8) return 'r32';
  if (seed <= 12) return 'r64';
  return 'r64';
}

// Rounds a team plays in (based on when they're eliminated)
function roundsPlayed(eliminatedIn: string | null): string[] {
  const all = ['play_in', 'r64', 'r32', 's16', 'e8'];
  if (!eliminatedIn) return ['r64', 'r32', 's16', 'e8']; // seeds 1-2: no play-in, survive through e8
  const idx = all.indexOf(eliminatedIn);
  // Team plays up to and including the elimination round
  // Seeds that get play-in: only play play_in then eliminated (or advance to r64)
  // Seeds 1-4 skip play_in
  if (eliminatedIn === 'play_in') return ['play_in'];
  return all.filter((r, i) => r !== 'play_in' && i <= idx);
}

// Deterministic points: avg_ppg * round_multiplier with minor seed-based variance
function gamePoints(avgPpg: number, seed: number, round: string): number {
  const multipliers: Record<string, number> = {
    play_in: 0.9, r64: 1.0, r32: 1.05, s16: 1.1, e8: 1.15
  };
  // Minor variance based on seed (lower seed = slightly more consistent)
  const variance = 1 - (seed - 1) * 0.005;
  return Math.round(avgPpg * (multipliers[round] ?? 1.0) * variance * 10) / 10;
}

// Game dates per round
const GAME_DATES: Record<string, string> = {
  play_in: '2026-03-19',
  r64: '2026-03-21',
  r32: '2026-03-23',
  s16: '2026-03-27',
  e8: '2026-03-29',
};

async function run() {
  console.log('🏀 Starting demo league seed...\n');

  // ── 1. Create demo auth users ─────────────────────────────────────────────
  console.log('👤 Creating demo users...');
  for (const u of DEMO_USERS) {
    // user_id is a valid API param but not in TS types — cast to bypass
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { error } = await db.auth.admin.createUser({
      user_id: u.id,
      email: u.email,
      email_confirm: true,
      user_metadata: { display_name: u.display_name },
    } as any);
    if (error && !error.message.includes('already been registered') && !error.message.includes('already exists')) {
      console.warn(`  ⚠ User ${u.email}: ${error.message}`);
    }
    // Upsert public.users (auth trigger may have already run)
    await db.from('users').upsert(
      { id: u.id, display_name: u.display_name, email: u.email },
      { onConflict: 'id' }
    );
  }
  console.log(`  ✅ ${DEMO_USERS.length} demo users ready\n`);

  // ── 2. Create demo league ─────────────────────────────────────────────────
  console.log('🏆 Creating demo league...');
  const commissionerId = DEMO_USERS[0].id;

  const { error: leagueError } = await db.from('leagues').upsert(
    {
      id: DEMO_LEAGUE_ID,
      name: 'March Madness Fantasy Demo 2026',
      season: SEASON,
      commissioner_id: commissionerId,
      is_demo: true,
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
  if (leagueError) { console.error('  ❌ League:', leagueError); process.exit(1); }

  // League members
  for (const u of DEMO_USERS) {
    await db.from('league_members').upsert(
      {
        league_id: DEMO_LEAGUE_ID,
        user_id: u.id,
        role: u.id === commissionerId ? 'commissioner' : 'member',
      },
      { onConflict: 'league_id,user_id' }
    );
  }
  console.log(`  ✅ Demo league + ${DEMO_USERS.length} members ready\n`);

  // ── 3. Load teams from DB ─────────────────────────────────────────────────
  console.log('📊 Loading teams and players...');
  const { data: teams } = await db
    .from('teams')
    .select('id, name, seed, region, is_eliminated, eliminated_in_round_stage')
    .eq('season', SEASON)
    .order('region')
    .order('seed');

  if (!teams?.length) {
    console.error('  ❌ No teams found — run seed-players-2026.ts first');
    process.exit(1);
  }

  // Identify play-in duplicate seeds per region
  type TeamRow = typeof teams[number];
  const teamsByRegionSeed = new Map<string, TeamRow[]>();
  for (const t of teams) {
    const key = `${t.region}:${t.seed}`;
    const arr = teamsByRegionSeed.get(key) ?? [];
    arr.push(t);
    teamsByRegionSeed.set(key, arr);
  }

  // Determine which teams are play-in losers (duplicate seed — pick the second one)
  const playInLoserIds = new Set<string>();
  for (const [, arr] of teamsByRegionSeed) {
    if (arr.length > 1) {
      playInLoserIds.add(arr[1].id); // second team is the play-in loser
    }
  }

  // Assign elimination rounds to teams (if not already set)
  for (const t of teams) {
    const isLoser = playInLoserIds.has(t.id);
    const elimRound = getEliminationRound(t.seed, isLoser);
    if (!t.is_eliminated && elimRound) {
      await db
        .from('teams')
        .update({ is_eliminated: true, eliminated_in_round_stage: elimRound })
        .eq('id', t.id);
    }
  }

  // Build map: team_id → elimination round
  const teamElimMap = new Map<string, string | null>();
  for (const t of teams) {
    const isLoser = playInLoserIds.has(t.id);
    teamElimMap.set(t.id, getEliminationRound(t.seed, isLoser));
  }

  // Load all players with their team info
  const { data: allPlayers } = await db
    .from('players')
    .select('id, name, position, avg_ppg, team_id, teams(seed, region)')
    .eq('season', SEASON)
    .order('avg_ppg', { ascending: false });

  if (!allPlayers?.length) {
    console.error('  ❌ No players found — run seed-players-2026.ts first');
    process.exit(1);
  }

  type PlayerRow = typeof allPlayers[number] & { teams: { seed: number; region: string } | { seed: number; region: string }[] | null };

  console.log(`  ✅ Loaded ${teams.length} teams, ${allPlayers.length} players\n`);

  // ── 4. Build draft pool — sorted by tournament value ─────────────────────
  // Survival score: higher = deeper tournament run (more game points for their owners)
  const survivalScore = (teamId: string): number => {
    const elim = teamElimMap.get(teamId);
    if (!elim) return 5;          // alive through E8 (seeds 1-2)
    if (elim === 'e8') return 4;
    if (elim === 's16') return 3;
    if (elim === 'r32') return 2;
    if (elim === 'r64') return 1;
    return 0; // play_in loser
  };

  // Sort players by survival score desc, then avg_ppg desc
  const sortedPlayers = (allPlayers as PlayerRow[]).sort((a, b) => {
    const survA = survivalScore(a.team_id);
    const survB = survivalScore(b.team_id);
    if (survB !== survA) return survB - survA;
    return b.avg_ppg - a.avg_ppg;
  });

  // Separate by position for positionally-aware drafting
  const byPos = { G: [] as PlayerRow[], F: [] as PlayerRow[], C: [] as PlayerRow[] };
  for (const p of sortedPlayers) {
    if (p.position in byPos) byPos[p.position as keyof typeof byPos].push(p);
  }

  // ── 5. Simulate snake draft ───────────────────────────────────────────────
  console.log('🎯 Simulating snake draft...');

  // Roster structure: 2G + 2F + 1C starters + 3 bench (1G, 1F, 1C mix)
  // We'll draft 8 rounds, slots: G1, G2, F1, F2, C1, bench1, bench2, bench3
  const SLOT_KEYS = ['G1', 'G2', 'F1', 'F2', 'C1', 'B1', 'B2', 'B3'] as const;
  const SLOT_POSITIONS: Record<string, 'G' | 'F' | 'C'> = {
    G1: 'G', G2: 'G', F1: 'F', F2: 'F', C1: 'C', B1: 'G', B2: 'F', B3: 'C',
  };
  const SLOT_IS_BENCH: Record<string, boolean> = {
    G1: false, G2: false, F1: false, F2: false, C1: false, B1: true, B2: true, B3: true,
  };

  const N = DEMO_USERS.length; // 8
  const ROUNDS = SLOT_KEYS.length; // 8 rounds = 64 total picks

  // Track what's been assigned
  const usedPlayerIds = new Set<string>();
  const posCounters = { G: 0, F: 0, C: 0 };

  // roster[userId] = { slot_key: playerId }
  const roster: Record<string, Record<string, string>> = {};
  for (const u of DEMO_USERS) roster[u.id] = {};

  for (let round = 0; round < ROUNDS; round++) {
    const slotKey = SLOT_KEYS[round];
    const slotPos = SLOT_POSITIONS[slotKey];
    const pool = byPos[slotPos].filter((p) => !usedPlayerIds.has(p.id));

    // Snake order: odd rounds forward, even rounds reverse
    const pickOrder = round % 2 === 0
      ? DEMO_USERS.map((u) => u.id)
      : [...DEMO_USERS].reverse().map((u) => u.id);

    for (let pick = 0; pick < N; pick++) {
      const userId = pickOrder[pick];
      const globalPickIdx = round * N + (round % 2 === 0 ? pick : N - 1 - pick);
      // Assign the player at the corresponding index in the pool
      const player = pool[globalPickIdx % pool.length];
      if (player && !usedPlayerIds.has(player.id)) {
        roster[userId][slotKey] = player.id;
        usedPlayerIds.add(player.id);
      }
    }
    posCounters[slotPos]++;
  }

  // ── 6. Create draft_session + roster_slots ────────────────────────────────
  // Create a completed draft session
  const DRAFT_SESSION_ID = '00000000-demo-0000-0000-000000000002';
  await db.from('draft_sessions').upsert(
    {
      id: DRAFT_SESSION_ID,
      league_id: DEMO_LEAGUE_ID,
      season: SEASON,
      status: 'complete',
      pick_timer_seconds: 60,
      snake_order: DEMO_USERS.map((u) => u.id),
      current_pick_number: ROUNDS * N + 1,
      started_at: '2026-03-15T18:00:00Z',
      completed_at: '2026-03-15T19:30:00Z',
    },
    { onConflict: 'id' }
  );

  // Clear existing roster_slots for demo league (for idempotency)
  await db.from('roster_slots').delete().eq('league_id', DEMO_LEAGUE_ID);

  let slotCount = 0;
  for (const u of DEMO_USERS) {
    for (const slotKey of SLOT_KEYS) {
      const playerId = roster[u.id][slotKey];
      if (!playerId) continue;

      const teamRow = (allPlayers as PlayerRow[]).find((p) => p.id === playerId);
      const team = Array.isArray(teamRow?.teams) ? teamRow?.teams[0] : teamRow?.teams;
      const teamId = allPlayers.find((p) => p.id === playerId)?.team_id;
      const elimRound = teamId ? teamElimMap.get(teamId) : null;

      const isActive = !elimRound; // alive through E8 means currently active
      const slotPos = SLOT_POSITIONS[slotKey];
      const isBench = SLOT_IS_BENCH[slotKey];

      await db.from('roster_slots').insert({
        league_id: DEMO_LEAGUE_ID,
        user_id: u.id,
        player_id: playerId,
        slot_key: slotKey,
        slot_position: slotPos,
        is_bench: isBench,
        is_active: isActive,
        acquired_at_round_stage: 'draft',
        released_at_round_stage: elimRound ?? null,
        release_reason: elimRound ? 'eliminated' : null,
      });
      slotCount++;
    }
  }
  console.log(`  ✅ Created ${slotCount} roster slots\n`);

  // ── 7. Create game_scores ─────────────────────────────────────────────────
  console.log('📈 Creating game scores...');

  // Delete existing game_scores for demo players
  const demoPlayerIds = [...usedPlayerIds];
  await db.from('game_scores').delete().in('player_id', demoPlayerIds);

  let scoreCount = 0;
  for (const playerId of demoPlayerIds) {
    const player = (allPlayers as PlayerRow[]).find((p) => p.id === playerId);
    if (!player) continue;

    const teamElim = teamElimMap.get(player.team_id);
    const played = roundsPlayed(teamElim ?? null);
    const team = Array.isArray(player.teams) ? player.teams[0] : player.teams;
    const seed = team?.seed ?? 8;

    for (const round of played) {
      const pts = gamePoints(player.avg_ppg, seed, round);
      await db.from('game_scores').insert({
        player_id: playerId,
        season: SEASON,
        round_stage: round,
        round_number: 1,
        game_date: GAME_DATES[round],
        game_status: 'final',
        points: pts,
        source: 'manual',
        synced_at: new Date().toISOString(),
      });
      scoreCount++;
    }
  }
  console.log(`  ✅ Created ${scoreCount} game score entries\n`);

  // ── 8. Run ScoreAccumulator ───────────────────────────────────────────────
  console.log('🔢 Computing scoring events and leaderboard snapshots...');

  // Import ScoreAccumulator inline to avoid module resolution issues
  // We'll directly compute this here rather than importing the service
  // (avoids Next.js server-only module issues in tsx context)

  // Fetch all game_scores for demo players
  const { data: gameScores } = await db
    .from('game_scores')
    .select('id, player_id, round_stage, points, game_status')
    .in('player_id', demoPlayerIds)
    .eq('game_status', 'final');

  const ROUND_ORDER = [...ROUND_STAGE_ORDER];

  // Process each game score
  const snapshotData: Record<string, { total: number; perRound: Record<string, number> }> = {};

  for (const u of DEMO_USERS) {
    snapshotData[u.id] = { total: 0, perRound: {} };
  }

  // Delete existing scoring events for demo league
  await db.from('scoring_events').delete().eq('league_id', DEMO_LEAGUE_ID);

  const scoringEventBatch: Record<string, unknown>[] = [];

  for (const gs of (gameScores ?? [])) {
    const gsIdx = ROUND_ORDER.indexOf(gs.round_stage);
    if (gsIdx === -1) continue;

    // Find roster_slots for this player in demo league
    const { data: slots } = await db
      .from('roster_slots')
      .select('id, user_id, acquired_at_round_stage, released_at_round_stage')
      .eq('league_id', DEMO_LEAGUE_ID)
      .eq('player_id', gs.player_id);

    for (const slot of (slots ?? [])) {
      const acqIdx = ROUND_ORDER.indexOf(slot.acquired_at_round_stage);
      let relIdx: number;
      if (!slot.released_at_round_stage) {
        relIdx = ROUND_ORDER.length;
      } else {
        const raw = ROUND_ORDER.indexOf(slot.released_at_round_stage);
        relIdx = raw === -1 ? 0 : raw;
      }

      if (acqIdx <= gsIdx && gsIdx < relIdx) {
        scoringEventBatch.push({
          league_id: DEMO_LEAGUE_ID,
          user_id: slot.user_id,
          player_id: gs.player_id,
          game_score_id: gs.id,
          round_stage: gs.round_stage,
          points_credited: gs.points,
          roster_slot_id: slot.id,
          is_stale: false,
        });
        snapshotData[slot.user_id].total += gs.points;
        snapshotData[slot.user_id].perRound[gs.round_stage] =
          (snapshotData[slot.user_id].perRound[gs.round_stage] ?? 0) + gs.points;
      }
    }
  }

  // Insert scoring events in batches
  for (let i = 0; i < scoringEventBatch.length; i += 100) {
    await db.from('scoring_events').insert(scoringEventBatch.slice(i, i + 100));
  }
  console.log(`  ✅ Created ${scoringEventBatch.length} scoring events`);

  // Upsert leaderboard snapshots
  for (const u of DEMO_USERS) {
    const data = snapshotData[u.id];
    const orderedStr = ROUND_ORDER as unknown as string[];
    const stages = Object.keys(data.perRound).filter((s) => orderedStr.includes(s));
    const maxStage = stages.length > 0
      ? stages.reduce((m, s) => orderedStr.indexOf(s) > orderedStr.indexOf(m) ? s : m)
      : 'r64';

    const { data: activeCount } = await db
      .from('roster_slots')
      .select('id', { count: 'exact', head: true })
      .eq('league_id', DEMO_LEAGUE_ID)
      .eq('user_id', u.id)
      .eq('is_active', true);

    const perRoundPts = Object.values(data.perRound);
    const bestGame = perRoundPts.length > 0 ? Math.max(...perRoundPts) : 0;

    await db.from('leaderboard_snapshots').upsert(
      {
        league_id: DEMO_LEAGUE_ID,
        user_id: u.id,
        total_points: data.total,
        active_player_count: (activeCount as unknown as number) ?? 0,
        highest_single_game_points: bestGame,
        round_stage: maxStage,
        last_computed_at: new Date().toISOString(),
      },
      { onConflict: 'league_id,user_id' }
    );
  }
  console.log('  ✅ Leaderboard snapshots upserted\n');

  // ── Print final standings ─────────────────────────────────────────────────
  console.log('🏆 Final leaderboard:');
  const standings = DEMO_USERS
    .map((u) => ({ name: u.display_name, points: snapshotData[u.id].total }))
    .sort((a, b) => b.points - a.points);

  standings.forEach((s, i) => {
    console.log(`  ${i + 1}. ${s.name}: ${s.points.toFixed(1)} pts`);
  });

  console.log('\n✅ Demo league seed complete!');
  console.log(`   DEMO_LEAGUE_ID=${DEMO_LEAGUE_ID}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
