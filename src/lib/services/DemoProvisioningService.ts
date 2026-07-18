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

export const DemoProvisioningService = {
  /**
   * Provisions a personal "Try as Commissioner" demo league for an anonymous user.
   * No idempotency check — each call provisions a fresh league (Section 14.1).
   */
  async provision(commissioner_user_id: string): Promise<{
    league_id: string;
    draft_session_id: string;
  }> {
    const t0 = Date.now();

    const aiMemberIds = AI_MEMBER_NAMES.map((name) =>
      uuidv5(`${commissioner_user_id}:${name}`, DEMO_MEMBER_NAMESPACE),
    );
    const shuffledOrder = fisherYatesShuffle([commissioner_user_id, ...aiMemberIds]);

    // Step 0: Create all 7 AI member auth.users rows in parallel.
    const tCreateUsers = Date.now();
    const createResults = await Promise.all(
      AI_MEMBER_NAMES.map((name, i) =>
        supabaseAdmin.auth.admin.createUser({
          id: aiMemberIds[i],
          email: `ai-${aiMemberIds[i]}@demo.invalid`,
          user_metadata: { display_name: name, is_ai_member: true },
        })
      )
    );
    debugLog(`[demo/provision] Step 0 createUsers (parallel): ${Date.now() - tCreateUsers}ms`);

    const firstCreateError = createResults.find((r) => r.error)?.error;
    if (firstCreateError) {
      await Promise.all(
        aiMemberIds.map((id) => supabaseAdmin.auth.admin.deleteUser(id).catch(() => {}))
      );
      throw firstCreateError;
    }

    // Steps 1, 2, 4: Atomic Postgres transaction via RPC. This cannot overlap with
    // step 0 above — the RPC's p_ai_member_ids FK-references the users rows that
    // step 0 creates (via the auth trigger mirroring auth.users into public.users),
    // so it must run after step 0 resolves, not concurrently with it. Nothing else
    // in this function is independent of the RPC either: seedDemoLeagueData below
    // needs the league_id/draft_session_id the RPC returns.
    const tRpc = Date.now();
    let league_id: string;
    let draft_session_id: string;
    try {
      const { data, error } = await supabaseAdmin.rpc('provision_demo_league', {
        p_commissioner_id: commissioner_user_id,
        p_ai_member_ids: aiMemberIds,
        p_ai_display_names: AI_MEMBER_NAMES,
        p_draft_order: shuffledOrder,
        p_season: DEMO_SEASON,
      });
      if (error) throw error;
      league_id = data[0].league_id;
      draft_session_id = data[0].draft_session_id;
    } catch (error) {
      await Promise.all(
        aiMemberIds.map((id) => supabaseAdmin.auth.admin.deleteUser(id).catch(() => {}))
      );
      throw error;
    }
    debugLog(`[demo/provision] Step 1-2 provision_demo_league RPC: ${Date.now() - tRpc}ms`);

    // Step 3: Seed in-season tournament state (idempotent upserts, outside transaction)
    const tSeed = Date.now();
    try {
      await seedDemoLeagueData(
        supabaseAdmin, league_id, shuffledOrder, commissioner_user_id, DEMO_SEASON,
      );
    } catch (error) {
      try {
        await supabaseAdmin.rpc('delete_orphaned_demo_leagues', { p_league_ids: [league_id] });
      } catch { /* best effort */ }
      await Promise.all(
        aiMemberIds.map((id) => supabaseAdmin.auth.admin.deleteUser(id).catch(() => {}))
      );
      throw error;
    }
    debugLog(`[demo/provision] Step 3 seedDemoLeagueData: ${Date.now() - tSeed}ms`);
    console.log(`[demo/provision] Total provision(): ${Date.now() - t0}ms`);

    return { league_id, draft_session_id };
  },
};
