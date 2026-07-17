/**
 * Seed script: Create demo league with tournament data through Elite 8
 * Usage: npx tsx --env-file=.env.local scripts/seed-demo-league.ts
 *
 * Idempotent — safe to re-run. Creates fixed-UUID demo users + demo league.
 * Requires players + teams to already be seeded (run seed-players-2026.ts first).
 */

import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import { seedDemoLeagueData } from '@/lib/utils/seedDemoData';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  console.error('Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

const SEASON = 2026;

// Fixed UUIDs so script is idempotent
const DEMO_LEAGUE_ID = process.env.DEMO_LEAGUE_ID ?? '00000000-0000-0000-0000-000000000001';

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

async function run() {
  console.log('🏀 Starting demo league seed...\n');

  // ── 1. Create demo auth users ─────────────────────────────────────────────
  console.log('👤 Creating demo users...');
  for (const u of DEMO_USERS) {
    // user_id is a valid API param but not in TS types — cast to bypass
    const { error } = await db.auth.admin.createUser({
      user_id: u.id,
      email: u.email,
      email_confirm: true,
      user_metadata: { display_name: u.display_name },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    if (error && !error.message.includes('already been registered') && !error.message.includes('already exists')) {
      console.warn(`  ⚠ User ${u.email}: ${error.message}`);
    }
    // Upsert public.users (auth trigger may have already run)
    const { error: userUpsertError } = await db.from('users').upsert(
      { id: u.id, display_name: u.display_name },
      { onConflict: 'id' }
    );
    if (userUpsertError) console.warn(`  ⚠ users upsert ${u.email}: ${userUpsertError.message}`);
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

  // ── 3. Seed draft, rosters, scores, and leaderboard ───────────────────────
  console.log('🎯 Seeding draft history, rosters, scores, and leaderboard...');
  await seedDemoLeagueData(db, DEMO_LEAGUE_ID, DEMO_USERS.map((u) => u.id), commissionerId, SEASON);
  console.log('  ✅ Seeding complete\n');

  // ── Print final standings ─────────────────────────────────────────────────
  const { data: snapshots } = await db
    .from('leaderboard_snapshots')
    .select('user_id, total_points')
    .eq('league_id', DEMO_LEAGUE_ID)
    .order('total_points', { ascending: false });

  console.log('🏆 Final leaderboard:');
  (snapshots ?? []).forEach((s, i) => {
    const name = DEMO_USERS.find((u) => u.id === s.user_id)?.display_name ?? s.user_id;
    console.log(`  ${i + 1}. ${name}: ${s.total_points} pts`);
  });

  console.log('\n✅ Demo league seed complete!');
  console.log(`   DEMO_LEAGUE_ID=${DEMO_LEAGUE_ID}`);
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
