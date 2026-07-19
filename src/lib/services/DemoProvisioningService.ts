import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/supabase/admin';
import { fisherYatesShuffle } from '@/lib/utils/shuffle';
import { seedDemoLeagueData } from '@/lib/utils/seedDemoData';

const DEMO_MEMBER_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DEMO_SEASON = 2026;

// Step-timing logs are noisy in normal operation; gate them behind an env flag.
// The total-elapsed log stays unconditional — it's genuinely useful in prod logs
// even without the per-step breakdown.
const DEBUG = process.env.DEMO_PROVISION_DEBUG === 'true';
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

const AI_MEMBER_NAMES = [
  'Coach Bot', 'Draft King', 'Bracket Buster', 'Rim Protector',
  'Three Point Specialist', 'Paint Enforcer', 'Full Court Press',
] as const;

/**
 * Global shared AI-member pool: ONE set of 7 AI auth users, reused by every demo
 * league, instead of 7 fresh GoTrue admin.createUser calls per provision (which
 * cost ~300-800ms each in production even in parallel). Ids are deterministic —
 * uuidv5('demo-ai-pool:' + name) — independent of the commissioner, so every
 * server instance computes the same 7 ids.
 *
 * These users are PERMANENT INFRASTRUCTURE:
 *  - provisioning failure paths must never delete them (other live demo leagues
 *    share them);
 *  - /api/cron/demo-cleanup imports this list to exclude them from its AI-member
 *    auth-user deletion (legacy per-commissioner AI users from old leagues still
 *    get cleaned up there).
 */
export const AI_MEMBER_POOL_IDS: readonly string[] = AI_MEMBER_NAMES.map((name) =>
  uuidv5(`demo-ai-pool:${name}`, DEMO_MEMBER_NAMESPACE),
);

/** GoTrue duplicate-user errors mean another provision raced us to create the same
 *  pool user — that's success, not failure (the user exists either way). */
function isDuplicateUserError(error: { message?: string; code?: string; status?: number }): boolean {
  const msg = error.message ?? '';
  return (
    error.code === 'email_exists' ||
    error.code === 'user_already_exists' ||
    /already been registered|already registered|already exists|duplicate key/i.test(msg)
  );
}

async function selectPoolUserRows(): Promise<Set<string>> {
  const { data, error } = await supabaseAdmin
    .from('users')
    .select('id')
    .in('id', [...AI_MEMBER_POOL_IDS]);
  if (error) throw error;
  return new Set((data ?? []).map((r) => r.id as string));
}

async function ensureAiMemberPoolUncached(): Promise<void> {
  // Warm path: one cheap select. All 7 public.users rows present → pool is ready.
  const existing = await selectPoolUserRows();
  if (existing.size === AI_MEMBER_POOL_IDS.length) return;

  // Cold path (first provision ever, or partially-created pool): create the
  // missing auth users in parallel. handle_new_user mirrors them into public.users.
  const results = await Promise.all(
    AI_MEMBER_NAMES.map((name, i) => {
      const id = AI_MEMBER_POOL_IDS[i];
      if (existing.has(id)) return Promise.resolve(null);
      return supabaseAdmin.auth.admin.createUser({
        id,
        email: `ai-${id}@demo.invalid`,
        user_metadata: { display_name: name, is_ai_member: true },
      });
    })
  );
  for (const r of results) {
    if (r?.error && !isDuplicateUserError(r.error)) throw r.error;
  }

  // Verify all 7 public.users rows exist before proceeding — the handle_new_user
  // trigger is synchronous with createUser, but be defensive (a racing provision
  // may have "won" the duplicate error above a moment before its trigger commit
  // is visible to us).
  for (let attempt = 0; attempt < 5; attempt++) {
    const rows = await selectPoolUserRows();
    if (rows.size === AI_MEMBER_POOL_IDS.length) return;
    await new Promise((resolve) => setTimeout(resolve, 100 * (attempt + 1)));
  }
  throw new Error(
    'ensureAiMemberPool: pool auth users created but public.users rows never appeared ' +
    '(handle_new_user trigger regression?)'
  );
}

// Per-process memo: after one successful verification the pool is known-good for
// the lifetime of this server instance (pool users are permanent — cleanup never
// deletes them), so subsequent provisions skip even the single warm-path select.
// A failed attempt clears the memo so the next request retries.
let poolReady: Promise<void> | null = null;

export const DemoProvisioningService = {
  /**
   * Ensures the 7 shared AI pool users exist (auth.users + public.users).
   * Warm path: at most one select per process. Safe to call concurrently with
   * other work (e.g. overlapped with signInAnonymously in the provision route).
   */
  ensureAiMemberPool(): Promise<void> {
    if (!poolReady) {
      poolReady = ensureAiMemberPoolUncached().catch((err) => {
        poolReady = null;
        throw err;
      });
    }
    return poolReady;
  },

  /**
   * Provisions a personal "Try as Commissioner" demo league for an anonymous user.
   * No idempotency check — each call provisions a fresh league (Section 14.1).
   */
  async provision(commissioner_user_id: string): Promise<{
    league_id: string;
    draft_session_id: string;
  }> {
    const t0 = Date.now();

    // Step 0: shared AI pool (no-op after first call per process; the provision
    // route additionally overlaps this with signInAnonymously).
    const tPool = Date.now();
    await DemoProvisioningService.ensureAiMemberPool();
    debugLog(`[demo/provision] Step 0 ensureAiMemberPool: ${Date.now() - tPool}ms`);

    const aiMemberIds = [...AI_MEMBER_POOL_IDS];
    const shuffledOrder = fisherYatesShuffle([commissioner_user_id, ...aiMemberIds]);

    // Steps 1, 2, 4: Atomic Postgres transaction via RPC. league_members rows are
    // keyed per (league_id, user_id) with no user-level unique constraint, so the
    // shared pool users being members of many demo leagues at once is fine. On
    // failure nothing persisted (transaction) — and pool users are NEVER deleted
    // on any failure path (other live demo leagues share them).
    const tRpc = Date.now();
    const { data, error } = await supabaseAdmin.rpc('provision_demo_league', {
      p_commissioner_id: commissioner_user_id,
      p_ai_member_ids: aiMemberIds,
      p_ai_display_names: AI_MEMBER_NAMES,
      p_draft_order: shuffledOrder,
      p_season: DEMO_SEASON,
    });
    if (error) throw error;
    const league_id: string = data[0].league_id;
    const draft_session_id: string = data[0].draft_session_id;
    debugLog(`[demo/provision] Step 1-2 provision_demo_league RPC: ${Date.now() - tRpc}ms`);

    // Step 3: Seed in-season tournament state (idempotent upserts, outside transaction).
    // On failure, clean up the half-seeded league — but never the shared pool users.
    const tSeed = Date.now();
    try {
      await seedDemoLeagueData(
        supabaseAdmin, league_id, shuffledOrder, commissioner_user_id, DEMO_SEASON,
      );
    } catch (error) {
      try {
        await supabaseAdmin.rpc('delete_orphaned_demo_leagues', { p_league_ids: [league_id] });
      } catch { /* best effort */ }
      throw error;
    }
    debugLog(`[demo/provision] Step 3 seedDemoLeagueData: ${Date.now() - tSeed}ms`);
    console.log(`[demo/provision] Total provision(): ${Date.now() - t0}ms`);

    return { league_id, draft_session_id };
  },
};
