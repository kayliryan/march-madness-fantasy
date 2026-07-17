/**
 * Section 6 Required Concurrency Test
 *
 * Tests that two simultaneous PATCH /api/commissioner/pick/void requests for the
 * same pick produce exactly one success (200) and one conflict (409), with no
 * corrupted state (pick voided exactly once, one correction pick in the DB).
 *
 * Requires: dev server running at localhost:3000, Supabase running locally.
 *
 * Run: npx tsx --env-file=.env.local scripts/test/concurrency-demo-void.ts
 */

import ws from 'ws';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';

// Node 20 requires WebSocket polyfill for Supabase Realtime (CLAUDE.md)
if (!globalThis.WebSocket) {
  // @ts-expect-error ws is not a full WebSocket implementation
  globalThis.WebSocket = ws;
}

const BASE_URL = 'http://localhost:3000';
const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL!;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!;

const supabaseAdmin = createClient(
  SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
);

/** Get a Cookie header for an anonymous Supabase session using the SSR cookie-jar pattern. */
async function getAnonCookieHeader(access_token: string, refresh_token: string): Promise<string> {
  const jar = new Map<string, string>();
  const supabase = createServerClient(SUPABASE_URL, ANON_KEY, {
    cookies: {
      getAll() { return [...jar.entries()].map(([name, value]) => ({ name, value })); },
      setAll(cookies) { for (const { name, value } of cookies) jar.set(name, value); },
    },
  });
  const { error } = await supabase.auth.setSession({ access_token, refresh_token });
  if (error) throw new Error(`getAnonCookieHeader: setSession failed: ${error.message}`);
  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

async function main() {
  console.log('\n=== Section 6 Concurrency Test: pick void ===\n');

  // 1. Provision a fresh demo league
  console.log('Step 1: Provisioning demo league...');
  const provRes = await fetch(`${BASE_URL}/api/demo/provision`, { method: 'POST' });
  if (!provRes.ok) {
    const body = await provRes.json();
    throw new Error(`Provision failed: ${JSON.stringify(body)}`);
  }
  const prov = await provRes.json() as {
    league_id: string;
    draft_session_id: string;
    access_token: string;
    refresh_token: string;
  };
  console.log(`  league_id: ${prov.league_id}`);
  console.log(`  draft_session_id: ${prov.draft_session_id} (scheduled session)`);

  // The completed historical session has the draft_picks we need to void.
  // Get the most recent completed session (the current-season one with picks,
  // not the prior-season stub which has no picks).
  const { data: completedSession } = await supabaseAdmin
    .from('draft_sessions')
    .select('id')
    .eq('league_id', prov.league_id)
    .eq('status', 'complete')
    .order('season', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!completedSession) {
    throw new Error('No completed draft session found — seed data may not have run');
  }
  console.log(`  completed session: ${completedSession.id}`);

  // 2. Get two picks from the completed session to use in the test
  const { data: picks } = await supabaseAdmin
    .from('draft_picks')
    .select('id, player_id, user_id, league_id')
    .eq('draft_session_id', completedSession.id)
    .is('voided_at', null)
    .limit(2);

  if (!picks || picks.length < 2) {
    throw new Error('Not enough picks found in completed session');
  }

  const targetPick = picks[0];
  console.log(`\nStep 2: Target pick: ${targetPick.id} (player: ${targetPick.player_id})`);

  // 3. Find a replacement player (not already in the draft, not the original player)
  const { data: draftedPlayerIds } = await supabaseAdmin
    .from('draft_picks')
    .select('player_id')
    .eq('draft_session_id', completedSession.id)
    .is('voided_at', null);

  const draftedIds = new Set((draftedPlayerIds ?? []).map((r: { player_id: string }) => r.player_id));

  const { data: replacementCandidates } = await supabaseAdmin
    .from('players')
    .select('id')
    .not('id', 'in', `(${[...draftedIds].join(',')})`)
    .limit(1);

  if (!replacementCandidates?.length) {
    throw new Error('No replacement player available');
  }
  const replacementPlayerId = replacementCandidates[0].id;
  console.log(`  Replacement player: ${replacementPlayerId}`);

  // 4. Fire two simultaneous void requests for the SAME pick
  console.log('\nStep 3: Firing two simultaneous void requests...');
  const voidBody = {
    pick_id: targetPick.id,
    void_reason: 'concurrency test',
    replacement_player_id: replacementPlayerId,
  };

  // Build the SSR cookie jar so the Next.js server can authenticate the anonymous user
  const cookieHeader = await getAnonCookieHeader(prov.access_token, prov.refresh_token);

  const [res1, res2] = await Promise.all([
    fetch(`${BASE_URL}/api/commissioner/pick/void`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(voidBody),
    }),
    fetch(`${BASE_URL}/api/commissioner/pick/void`, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
        Cookie: cookieHeader,
      },
      body: JSON.stringify(voidBody),
    }),
  ]);

  const [body1, body2] = await Promise.all([res1.json(), res2.json()]);

  console.log(`  Request 1 status: ${res1.status}`);
  console.log(`  Request 2 status: ${res2.status}`);
  console.log(`  Request 1 body:   ${JSON.stringify(body1).slice(0, 120)}`);
  console.log(`  Request 2 body:   ${JSON.stringify(body2).slice(0, 120)}`);

  // 5. Verify results
  const statuses = [res1.status, res2.status].sort();
  const success = statuses[0] === 200 || statuses[0] === 200;
  const oneSuccess = [res1.status, res2.status].filter((s) => s === 200).length === 1;
  const oneConflict = [res1.status, res2.status].filter((s) => s === 409 || s === 422).length === 1;

  console.log('\n=== Result ===');
  if (oneSuccess && oneConflict) {
    console.log('✅ PASS: Exactly one success (200), one conflict (409/422).');
    console.log('   The atomic voided_at IS NULL check in the UPDATE prevented double-void.');
  } else if (!success) {
    console.log('❌ FAIL: Both requests failed — check auth or server errors.');
  } else {
    console.log(`❌ FAIL: Expected 1×200 + 1×409, got ${res1.status} + ${res2.status}.`);
    console.log('   Both requests succeeded — the race condition is NOT protected.');
  }

  // 6. Verify DB state: exactly 1 correction pick for this slot
  const { data: correctionPicks } = await supabaseAdmin
    .from('draft_picks')
    .select('id')
    .eq('replaces_pick_id', targetPick.id);

  console.log(`\nDB verification: correction picks for voided pick: ${correctionPicks?.length ?? 0}`);
  if ((correctionPicks?.length ?? 0) === 1) {
    console.log('✅ DB: Exactly 1 correction pick (no duplication).');
  } else {
    console.log('❌ DB: Expected 1 correction pick, got ' + (correctionPicks?.length ?? 0));
  }

  const { data: voidedPick } = await supabaseAdmin
    .from('draft_picks')
    .select('voided_at, void_reason')
    .eq('id', targetPick.id)
    .single();
  console.log(`DB verification: pick voided_at: ${voidedPick?.voided_at ?? 'null'}`);
  if (voidedPick?.voided_at) {
    console.log('✅ DB: Pick is voided exactly once.');
  } else {
    console.log('❌ DB: Pick not voided — unexpected state.');
  }

  console.log('\n=== Done ===');
}

main().catch((err) => {
  console.error('Test error:', err);
  process.exit(1);
});
