import { v5 as uuidv5 } from 'uuid';
import { supabaseAdmin } from '@/lib/supabase/client';
import { fisherYatesShuffle } from '@/lib/utils/shuffle';
import { seedDemoLeagueData } from '@/lib/utils/seedDemoData';

const DEMO_MEMBER_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const DEMO_SEASON = 2026;

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
    const aiMemberIds = AI_MEMBER_NAMES.map((name) =>
      uuidv5(`${commissioner_user_id}:${name}`, DEMO_MEMBER_NAMESPACE),
    );
    const shuffledOrder = fisherYatesShuffle([commissioner_user_id, ...aiMemberIds]);

    // Step 0: Create AI member auth.users rows (outside transaction — admin API).
    // Any error including duplicate ID: fail immediately, do not recover.
    const createdAiIds: string[] = [];
    try {
      for (let i = 0; i < AI_MEMBER_NAMES.length; i++) {
        const { error } = await supabaseAdmin.auth.admin.createUser({
          id: aiMemberIds[i],
          email: `ai-${aiMemberIds[i]}@demo.invalid`,
          user_metadata: { display_name: AI_MEMBER_NAMES[i], is_ai_member: true },
        });
        if (error) throw error;
        createdAiIds.push(aiMemberIds[i]);
      }
    } catch (error) {
      for (const id of createdAiIds) {
        await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
      }
      throw error;
    }

    // Steps 1, 2, 4: Atomic Postgres transaction via RPC
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
      for (const id of createdAiIds) {
        await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
      }
      throw error;
    }

    // Step 3: Seed in-season tournament state (idempotent upserts, outside transaction)
    try {
      await seedDemoLeagueData(
        supabaseAdmin, league_id, shuffledOrder, commissioner_user_id, DEMO_SEASON,
      );
    } catch (error) {
      // Transaction committed — explicitly clean up committed rows
      try {
        await supabaseAdmin.rpc('delete_orphaned_demo_leagues', { p_league_ids: [league_id] });
      } catch { /* best effort */ }
      for (const id of createdAiIds) {
        await supabaseAdmin.auth.admin.deleteUser(id).catch(() => {});
      }
      throw error;
    }

    return { league_id, draft_session_id };
  },
};
