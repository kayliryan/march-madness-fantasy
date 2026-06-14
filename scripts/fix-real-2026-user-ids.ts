/**
 * One-off fix: the real-2026 league seed script called
 * db.auth.admin.createUser({ user_id: <placeholder 20000000-...-N> }), but
 * Supabase ignores a caller-supplied `user_id` and generates a real random
 * UUID for auth.users. The auth trigger then created correct `public.users`
 * rows under the REAL ids, but league_members/roster_slots/leaderboard_snapshots/
 * scoring_events/leagues.commissioner_id still reference the PLACEHOLDER ids.
 * This means logged-in members fail the `league_members.user_id = auth.uid()`
 * membership check everywhere.
 *
 * This script remaps every reference from the placeholder id to the real
 * auth.users id (matched by email), then deletes the now-orphaned placeholder
 * rows in public.users.
 *
 * Usage: npx tsx --env-file=.env.local scripts/fix-real-2026-user-ids.ts
 */

import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';

const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

const LEAGUE_ID = '00000000-0000-0000-0000-000000000002';

const MEMBERS = [
  { placeholder: '20000000-0000-0000-0000-000000000001', email: 'spoza@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000002', email: 'babyluv@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000003', email: 'bub@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000004', email: 'sienna@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000005', email: 'bittbee@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000006', email: 'pooka@real2026.marchfantasy.app' },
  { placeholder: '20000000-0000-0000-0000-000000000007', email: 'thedad@real2026.marchfantasy.app' },
];

async function run() {
  const { data: usersResp } = await db.auth.admin.listUsers();

  const mapping: { placeholder: string; real: string; email: string }[] = [];
  for (const m of MEMBERS) {
    const u = usersResp.users.find((x) => x.email === m.email);
    if (!u) throw new Error(`auth user not found for ${m.email}`);
    mapping.push({ placeholder: m.placeholder, real: u.id, email: m.email });
  }

  for (const { placeholder, real, email } of mapping) {
    console.log(`\n${email}: ${placeholder} -> ${real}`);

    const { error: lmError } = await db
      .from('league_members')
      .update({ user_id: real })
      .eq('league_id', LEAGUE_ID)
      .eq('user_id', placeholder);
    if (lmError) throw new Error(`league_members: ${lmError.message}`);
    console.log('  league_members updated');

    const { error: rsError } = await db
      .from('roster_slots')
      .update({ user_id: real })
      .eq('league_id', LEAGUE_ID)
      .eq('user_id', placeholder);
    if (rsError) throw new Error(`roster_slots: ${rsError.message}`);
    console.log('  roster_slots updated');

    const { error: lsError } = await db
      .from('leaderboard_snapshots')
      .update({ user_id: real })
      .eq('league_id', LEAGUE_ID)
      .eq('user_id', placeholder);
    if (lsError) throw new Error(`leaderboard_snapshots: ${lsError.message}`);
    console.log('  leaderboard_snapshots updated');

    const { error: seError } = await db
      .from('scoring_events')
      .update({ user_id: real })
      .eq('league_id', LEAGUE_ID)
      .eq('user_id', placeholder);
    if (seError) throw new Error(`scoring_events: ${seError.message}`);
    console.log('  scoring_events updated');
  }

  // Fix commissioner_id on the league row (Spoza = member 1)
  const spoza = mapping.find((m) => m.placeholder === '20000000-0000-0000-0000-000000000001')!;
  const { error: leagueError } = await db
    .from('leagues')
    .update({ commissioner_id: spoza.real })
    .eq('id', LEAGUE_ID)
    .eq('commissioner_id', spoza.placeholder);
  if (leagueError) throw new Error(`leagues: ${leagueError.message}`);
  console.log(`\nleagues.commissioner_id -> ${spoza.real}`);

  // Clean up now-orphaned placeholder public.users rows
  const placeholderIds = mapping.map((m) => m.placeholder);
  const { error: delError } = await db
    .from('users')
    .delete()
    .in('id', placeholderIds);
  if (delError) throw new Error(`users delete: ${delError.message}`);
  console.log('\npublic.users placeholder rows deleted');

  console.log('\nDone.');
}

run().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
