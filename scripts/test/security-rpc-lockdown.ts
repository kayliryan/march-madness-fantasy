import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import { db, assert, createTestLeague, cleanupTestLeague } from './utils/testHelpers';

// Regression test for migration 20260717000001_revoke_rpc_execute_and_guard_demo_delete.sql.
//
// Before that migration, six SECURITY DEFINER functions in `public` were directly
// callable by anon/authenticated over PostgREST (POST /rest/v1/rpc/<fn>) because
// Postgres grants EXECUTE to PUBLIC by default and no earlier migration ever
// revoked it. This script proves: (1) the anon key can no longer call any of them,
// (2) the service-role client still can (the cron path is unaffected), and (3) even
// a service-role caller can't use delete_orphaned_demo_leagues to wipe a real
// (non-demo) league — the function body now filters its input to is_demo = true.

// ── Test runner ────────────────────────────────────────────────────────────

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
  }
}

// ── Setup ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !ANON_KEY) {
  throw new Error(
    'security-rpc-lockdown: NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are required ' +
    '(run with `npx tsx --env-file=.env.local`)'
  );
}

const anon = createClient(SUPABASE_URL, ANON_KEY);

/** PostgREST's error code for a Postgres "permission denied" (42501) error. */
const PERMISSION_DENIED = '42501';

function assertPermissionDenied(
  error: { code?: string; message?: string } | null,
  fnName: string
): void {
  assert(error !== null, `${fnName}: expected anon RPC call to error, but it succeeded`);
  const code = error?.code;
  const message = error?.message ?? '';
  assert(
    code === PERMISSION_DENIED || /permission denied/i.test(message),
    `${fnName}: expected a permission-denied (${PERMISSION_DENIED}) error, got code=${code} message="${message}"`
  );
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Shared non-demo test league used by cases 1 and 3.
  const league = await createTestLeague({ memberCount: 1, activationTiming: 'immediate' });

  try {
    // Case 1 — anon cannot call delete_orphaned_demo_leagues; league untouched.
    await runCase(
      'Case 1 — anon delete_orphaned_demo_leagues is permission-denied, league untouched',
      async () => {
        const { error } = await anon.rpc('delete_orphaned_demo_leagues', {
          p_league_ids: [league.league_id],
        });
        assertPermissionDenied(error, 'delete_orphaned_demo_leagues');

        const { data: stillThere, error: fetchErr } = await db
          .from('leagues')
          .select('id')
          .eq('id', league.league_id)
          .maybeSingle();
        if (fetchErr) throw new Error(`post-check query failed: ${fetchErr.message}`);
        assert(stillThere !== null, 'league was deleted despite anon RPC being permission-denied');
      }
    );

    // Case 2 — anon cannot call provision_demo_league, acquire_cron_lock,
    // increment_demo_daily_ai_usage.
    await runCase(
      'Case 2 — anon provision_demo_league is permission-denied',
      async () => {
        const { error } = await anon.rpc('provision_demo_league', {
          p_commissioner_id: crypto.randomUUID(),
          p_ai_member_ids: [crypto.randomUUID()],
          p_ai_display_names: ['Attacker AI'],
          p_draft_order: [crypto.randomUUID()],
          p_season: 2026,
        });
        assertPermissionDenied(error, 'provision_demo_league');
      }
    );

    await runCase(
      'Case 2 — anon acquire_cron_lock is permission-denied',
      async () => {
        const { error } = await anon.rpc('acquire_cron_lock', {
          p_job_name: 'sync-scores',
          p_instance_id: 'attacker-instance',
        });
        assertPermissionDenied(error, 'acquire_cron_lock');
      }
    );

    await runCase(
      'Case 2 — anon increment_demo_daily_ai_usage is permission-denied',
      async () => {
        const { error } = await anon.rpc('increment_demo_daily_ai_usage', {
          p_date: new Date().toISOString().slice(0, 10),
        });
        assertPermissionDenied(error, 'increment_demo_daily_ai_usage');
      }
    );

    // Case 3 — defense-in-depth guard: service-role call against a NON-demo league
    // must not delete it (function filters p_league_ids to is_demo = true internally).
    await runCase(
      'Case 3 — service-role delete_orphaned_demo_leagues does not delete a non-demo league',
      async () => {
        const { data: leagueRow } = await db
          .from('leagues')
          .select('is_demo')
          .eq('id', league.league_id)
          .single();
        assert(leagueRow?.is_demo === false, 'precondition failed: test league is unexpectedly is_demo=true');

        const { error } = await db.rpc('delete_orphaned_demo_leagues', {
          p_league_ids: [league.league_id],
        });
        if (error) throw new Error(`service-role RPC call itself failed: ${error.message}`);

        const { data: stillThere, error: fetchErr } = await db
          .from('leagues')
          .select('id')
          .eq('id', league.league_id)
          .maybeSingle();
        if (fetchErr) throw new Error(`post-check query failed: ${fetchErr.message}`);
        assert(
          stillThere !== null,
          'is_demo guard regression: service-role call deleted a non-demo league'
        );
      }
    );

    // Case 4 — service role can still acquire (and release) the cron lock; cron path unaffected.
    await runCase(
      'Case 4 — service-role acquire_cron_lock + release still works',
      async () => {
        const jobName = `security-rpc-lockdown-test-${Date.now()}`;
        const instanceId = crypto.randomUUID();

        const { data: lockRows, error } = await db.rpc('acquire_cron_lock', {
          p_job_name: jobName,
          p_instance_id: instanceId,
        });
        if (error) throw new Error(`service-role acquire_cron_lock failed: ${error.message}`);
        assert(
          Array.isArray(lockRows) && lockRows.length === 1,
          `expected acquire_cron_lock to return exactly 1 row, got ${JSON.stringify(lockRows)}`
        );

        const { error: releaseErr } = await db.from('cron_locks').delete().eq('job_name', jobName);
        if (releaseErr) throw new Error(`failed to release test cron lock: ${releaseErr.message}`);
      }
    );
  } finally {
    await cleanupTestLeague(league.league_id);
  }

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('security-rpc-lockdown: unhandled error:', err);
  process.exit(1);
});
