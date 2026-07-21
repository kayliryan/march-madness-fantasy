/**
 * One-time migration: rename the 7 shared demo AI-pool members from joke
 * nicknames ("Coach Bot", "Draft King", ...) to plausible real human names
 * ("Marcus Bell", "Derek Simmons", ...).
 *
 * Context: DemoProvisioningService.AI_MEMBER_POOL_IDS are uuidv5-derived from a
 * FROZEN seed list (AI_MEMBER_POOL_ID_SEEDS) that is intentionally decoupled from
 * the display-name list (AI_MEMBER_NAMES). That decoupling means the code change
 * alone does NOT touch the ids — the 7 existing auth users / public.users rows
 * keep their current ids — but it also means their display_name columns need an
 * explicit one-time update to catch up to the new AI_MEMBER_NAMES array. (Every
 * *new* provision() call would eventually upsert the new names into public.users
 * via provision_demo_league's `on conflict (id) do update set display_name =
 * excluded.display_name`, since it passes the current AI_MEMBER_NAMES as
 * p_ai_display_names — but that's indirect and doesn't touch auth.users metadata
 * at all, so we do it explicitly and immediately here instead.)
 *
 * Updates, for each of the 7 pool ids:
 *   1. auth.users.user_metadata.display_name (via admin.updateUserById)
 *   2. public.users.display_name (direct table update)
 *
 * auth.users.id is immutable in Supabase GoTrue — this script never attempts to
 * change ids, only the display_name field, which is exactly what's needed since
 * AI_MEMBER_POOL_IDS was NOT changed by this migration (see DemoProvisioningService.ts
 * comments around AI_MEMBER_POOL_ID_SEEDS).
 *
 * Idempotent — safe to re-run (each update is a plain overwrite to the current
 * AI_MEMBER_NAMES value, not an increment).
 *
 * Usage: npx tsx --env-file=.env.local scripts/migrate-ai-pool-names.ts
 *   (add --dry-run to only print the planned changes without writing)
 */

import '@/lib/utils/wsPolyfill';
import { supabaseAdmin } from '@/lib/supabase/admin';
import {
  AI_MEMBER_POOL_IDS,
} from '@/lib/services/DemoProvisioningService';

// Mirrors DemoProvisioningService's current AI_MEMBER_NAMES. Kept as a local
// literal (rather than importing a non-exported const) so this script fails
// loudly — via the length assertion below — if the service's array changes
// shape without this script being updated to match.
const NEW_NAMES = [
  'Marcus Bell', 'Derek Simmons', 'Alicia Torres', 'Priya Nair',
  'Jordan Reyes', 'Sam Whitfield', 'Nina Park',
] as const;

const DRY_RUN = process.argv.includes('--dry-run');

async function main(): Promise<void> {
  if (AI_MEMBER_POOL_IDS.length !== NEW_NAMES.length) {
    throw new Error(
      `AI_MEMBER_POOL_IDS length (${AI_MEMBER_POOL_IDS.length}) !== NEW_NAMES length ` +
      `(${NEW_NAMES.length}) — update NEW_NAMES in this script to match ` +
      `DemoProvisioningService's current AI_MEMBER_NAMES before re-running.`
    );
  }

  console.log(`${DRY_RUN ? '[dry-run] ' : ''}Migrating ${AI_MEMBER_POOL_IDS.length} AI pool member names...\n`);

  let updated = 0;
  let failed = 0;

  for (let i = 0; i < AI_MEMBER_POOL_IDS.length; i++) {
    const id = AI_MEMBER_POOL_IDS[i];
    const newName = NEW_NAMES[i];

    // Fetch current state for a readable before/after log line.
    const { data: beforeRow, error: beforeErr } = await supabaseAdmin
      .from('users')
      .select('display_name')
      .eq('id', id)
      .maybeSingle();

    if (beforeErr) {
      console.error(`  [${id}] failed to read current public.users row: ${beforeErr.message}`);
      failed++;
      continue;
    }
    if (!beforeRow) {
      console.error(`  [${id}] no public.users row found — pool not provisioned yet on this DB? skipping.`);
      failed++;
      continue;
    }

    console.log(`  [${id}] "${beforeRow.display_name}" -> "${newName}"`);

    if (DRY_RUN) continue;

    // 1. auth.users.user_metadata.display_name
    const { error: authErr } = await supabaseAdmin.auth.admin.updateUserById(id, {
      user_metadata: { display_name: newName, is_ai_member: true },
    });
    if (authErr) {
      console.error(`    auth.users update failed: ${authErr.message}`);
      failed++;
      continue;
    }

    // 2. public.users.display_name
    const { error: publicErr } = await supabaseAdmin
      .from('users')
      .update({ display_name: newName })
      .eq('id', id);
    if (publicErr) {
      console.error(`    public.users update failed: ${publicErr.message}`);
      failed++;
      continue;
    }

    updated++;
  }

  console.log(`\n${DRY_RUN ? '[dry-run] would update' : 'Updated'} ${updated}/${AI_MEMBER_POOL_IDS.length}` +
    (failed > 0 ? `, ${failed} failed` : ''));
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('migrate-ai-pool-names: unhandled error', err);
  process.exit(1);
});
