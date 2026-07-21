/**
 * Backfills teams.short_name (school name without mascot, e.g. "Duke" not "Duke
 * Blue Devils") for season 2026 from a SINGLE ESPN bulk-teams call — not one
 * call per team. Confirmed: GET .../teams?limit=400 returns all 362 Division-I
 * men's basketball teams in one response, each with team.location (school-only)
 * and team.id (matches our teams.espn_team_id). Joins on that id.
 *
 * Idempotent: safe to re-run (plain upsert-by-id UPDATE, no duplication risk).
 *
 * Usage: npx tsx --env-file=.env.local scripts/backfill-team-short-names.ts
 */
import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';

const SEASON = 2026;

interface EspnTeam {
  team: { id: string; location: string; displayName: string };
}

async function main() {
  const db = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);

  const res = await fetch(
    'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/teams?limit=400'
  );
  if (!res.ok) throw new Error(`ESPN bulk teams call failed: HTTP ${res.status}`);
  const json = await res.json();
  const espnTeams: EspnTeam[] = json?.sports?.[0]?.leagues?.[0]?.teams ?? [];
  if (espnTeams.length < 300) {
    throw new Error(`Expected ~362 D-I teams, got ${espnTeams.length} — ESPN response shape may have changed, stopping rather than partially backfilling.`);
  }
  const locationByEspnId = new Map(espnTeams.map((t) => [t.team.id, t.team.location]));

  // The bulk list (362 teams) doesn't include every D-I team — confirmed by a
  // single targeted /teams/{id} lookup for the one 2026-tournament team missing
  // from it. Documented here (not re-fetched every run) so the script stays a
  // single bulk call in the common case.
  locationByEspnId.set('2511', 'Queens University'); // Queens University Royals

  console.log(`Fetched ${espnTeams.length} teams from ESPN in one call (+1 documented manual override).`);

  const { data: ourTeams, error } = await db
    .from('teams')
    .select('id, espn_team_id, name, short_name')
    .eq('season', SEASON);
  if (error) throw new Error(`teams select failed: ${error.message}`);

  let updated = 0;
  const missing: string[] = [];
  for (const t of ourTeams ?? []) {
    if (!t.espn_team_id) {
      // Known pre-existing pollution (a duplicate "BYU" row with no espn_team_id) —
      // skip rather than guess; flagged separately for manual cleanup.
      missing.push(`${t.id} (${t.name}) — no espn_team_id`);
      continue;
    }
    const shortName = locationByEspnId.get(t.espn_team_id);
    if (!shortName) {
      missing.push(`${t.id} (${t.name}) — espn_team_id ${t.espn_team_id} not found in bulk response`);
      continue;
    }
    if (t.short_name === shortName) continue; // already correct, idempotent no-op
    const { error: updateErr } = await db.from('teams').update({ short_name: shortName }).eq('id', t.id);
    if (updateErr) throw new Error(`update failed for team ${t.id}: ${updateErr.message}`);
    updated++;
  }

  console.log(`Updated ${updated} team(s). ${(ourTeams ?? []).length - updated - missing.length} already correct.`);
  if (missing.length > 0) {
    console.log(`\nCould not resolve ${missing.length} team(s) (left short_name null):`);
    for (const m of missing) console.log(`  ${m}`);
  }

  const { count: stillNull } = await db
    .from('teams')
    .select('id', { count: 'exact', head: true })
    .eq('season', SEASON)
    .is('short_name', null);
  console.log(`\nteams with short_name still null: ${stillNull ?? 0} (season ${SEASON})`);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(1);
});
