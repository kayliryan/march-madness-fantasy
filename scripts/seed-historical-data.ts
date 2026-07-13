/**
 * Seed script: import historical family fantasy basketball data (2017-2025).
 * Usage: npx tsx --env-file=.env.local scripts/seed-historical-data.ts
 *
 * Reads historical_fixture.json (gitignored — contains real family emails) from the
 * project root. For each season: creates a league (skipping if one already exists for
 * that season+name, so re-runs are safe), resolves/creates users by email, creates
 * league_members, upserts teams/players, creates roster_slots and game_scores, and
 * runs ScoreAccumulator.runForLeague to compute the final leaderboard.
 */

import '@/lib/utils/wsPolyfill';
import fs from 'fs';
import path from 'path';
import { supabaseAdmin } from '@/lib/supabase/client';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { LeagueSettings } from '@/lib/types';

// ── Fixture types ────────────────────────────────────────────────────────

type ScoreRoundStage = Exclude<RoundStage, 'draft' | 'play_in'>;

interface FixturePlayer {
  name: string;
  school: string;
  position: 'G' | 'F' | 'C';
  avg_ppg: number;
  is_bench: boolean;
  activated_round?: ScoreRoundStage | null;
  scores: Partial<Record<ScoreRoundStage, number>>;
}

interface FixtureParticipant {
  email: string | null;
  display_name_that_season: string;
  draft_slot: number;
  players: FixturePlayer[];
}

interface FixtureSeason {
  season: number;
  champion_email: string;
  scoring_includes_play_in: boolean;
  note: string;
  participants: FixtureParticipant[];
}

interface FixtureRoot {
  meta: { note: string; participant_map: Record<string, string | null> };
  seasons: FixtureSeason[];
}

// ── Constants ────────────────────────────────────────────────────────────

const SCORE_ROUND_STAGES = ROUND_STAGE_ORDER.filter(
  (s): s is ScoreRoundStage => s !== 'draft' && s !== 'play_in'
);

// Seasons pending verification of historical scores and winner data.
// Remove a season from this list once it has been confirmed correct against the original spreadsheet.
// NOTE: 2024 was removed from this app's historical_fixture.json pending re-verification from the
// original spreadsheet — do not add 2024 back until scores are confirmed from source data.
const PENDING_VERIFICATION_SEASONS = [2017, 2018, 2021, 2022, 2023, 2024];

// Synthetic game dates — historical data has no real per-game dates, just per-round
// totals. One placeholder date per round_stage/season satisfies the NOT NULL column
// and the (player_id, round_stage, round_number, game_date) unique index.
const ROUND_STAGE_GAME_DATE_SUFFIX: Record<ScoreRoundStage, string> = {
  r64: '03-19',
  r32: '03-21',
  s16: '03-26',
  e8: '03-28',
  f4: '04-04',
  championship: '04-06',
};

const HISTORICAL_SETTINGS_BASE: Omit<LeagueSettings, 'bench_slots'> = {
  draft_type: 'snake',
  draft_order_lock_days_before: 3,
  pick_timer_seconds: 90,
  starter_slots: { G: 2, F: 2, C: 1 },
  sub_eligibility_matrix: { G: ['G', 'F'], F: ['G', 'F'], C: ['C'] },
  bench_lock_mode: 'always_editable',
  activation_timing: 'immediate',
  injury_sub_enabled: false,
  injury_sub_reversible: false,
  tiebreaker_strategies: ['highest_single_active_game'],
  scoring_includes_play_in: false,
  stats_provider: 'espn',
  notifications: { round_end_email: false, daily_digest: false, ai_summary: false },
  email_tone: 'casual',
};

// ── Helpers ──────────────────────────────────────────────────────────────

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

async function loadExistingUsers(): Promise<Map<string, string>> {
  const { data, error } = await supabaseAdmin.auth.admin.listUsers({ perPage: 1000 });
  if (error) throw new Error(`loadExistingUsers: listUsers failed: ${error.message}`);
  const map = new Map<string, string>();
  for (const u of data.users) {
    if (u.email) map.set(u.email.toLowerCase(), u.id);
  }
  return map;
}

async function resolveUserId(
  emailToUserId: Map<string, string>,
  email: string,
  displayName: string
): Promise<string> {
  const key = email.toLowerCase();
  const existing = emailToUserId.get(key);
  if (existing) return existing;

  const { data, error } = await supabaseAdmin.auth.admin.createUser({
    email,
    email_confirm: true,
    user_metadata: { display_name: displayName },
  });
  if (error || !data?.user) {
    throw new Error(`resolveUserId: failed to create user for ${email}: ${error?.message}`);
  }

  const { error: upsertErr } = await supabaseAdmin
    .from('users')
    .upsert({ id: data.user.id, display_name: displayName }, { onConflict: 'id' });
  if (upsertErr) throw new Error(`resolveUserId: users upsert failed for ${email}: ${upsertErr.message}`);

  emailToUserId.set(key, data.user.id);
  return data.user.id;
}

async function findOrCreateTeam(season: number, schoolName: string, cache: Map<string, string>): Promise<string> {
  if (cache.has(schoolName)) return cache.get(schoolName)!;

  const { data: existing, error: selErr } = await supabaseAdmin
    .from('teams')
    .select('id')
    .eq('season', season)
    .eq('name', schoolName)
    .maybeSingle();
  if (selErr) throw new Error(`findOrCreateTeam: lookup failed for "${schoolName}" (${season}): ${selErr.message}`);
  if (existing) {
    cache.set(schoolName, existing.id);
    return existing.id;
  }

  // Historical fixture has no seed/region data — placeholder values are fine since
  // these leagues are closed and never run tournament-bracket simulation logic.
  const { data: created, error: insErr } = await supabaseAdmin
    .from('teams')
    .insert({ season, name: schoolName, seed: 0, region: 'Historical' })
    .select('id')
    .single();
  if (insErr || !created) throw new Error(`findOrCreateTeam: insert failed for "${schoolName}" (${season}): ${insErr?.message}`);

  cache.set(schoolName, created.id);
  return created.id;
}

async function findOrCreatePlayer(
  season: number,
  fp: FixturePlayer,
  teamId: string,
  cache: Map<string, string>
): Promise<string> {
  const key = `${fp.name}|${teamId}`;
  if (cache.has(key)) return cache.get(key)!;

  const { data: existing, error: selErr } = await supabaseAdmin
    .from('players')
    .select('id')
    .eq('season', season)
    .eq('name', fp.name)
    .eq('team_id', teamId)
    .maybeSingle();
  if (selErr) throw new Error(`findOrCreatePlayer: lookup failed for "${fp.name}" (${season}): ${selErr.message}`);
  if (existing) {
    cache.set(key, existing.id);
    return existing.id;
  }

  const { data: created, error: insErr } = await supabaseAdmin
    .from('players')
    .insert({ season, name: fp.name, team_id: teamId, position: fp.position, avg_ppg: fp.avg_ppg })
    .select('id')
    .single();
  if (insErr || !created) throw new Error(`findOrCreatePlayer: insert failed for "${fp.name}" (${season}): ${insErr?.message}`);

  cache.set(key, created.id);
  return created.id;
}

// ── Per-season seeding ───────────────────────────────────────────────────

async function seedSeason(season: FixtureSeason, emailToUserId: Map<string, string>): Promise<void> {
  console.log(`\n=== Season ${season.season} ===`);

  const leagueName = `${season.season} Family League`;

  const { data: existingLeague, error: existingErr } = await supabaseAdmin
    .from('leagues')
    .select('id')
    .eq('season', season.season)
    .eq('name', leagueName)
    .maybeSingle();
  if (existingErr) throw new Error(`seedSeason ${season.season}: leagues lookup failed: ${existingErr.message}`);
  if (existingLeague) {
    console.log(`  League already exists (${existingLeague.id}) — skipping.`);
    return;
  }

  // Resolve unique participants by email, preserving first-seen (draft_slot) order.
  // 2017 has two participant entries for the same two people (using two different
  // email addresses each, from an old account switch) — these collapse into one
  // league_member each, but every entry's players are still imported below under
  // that single user.
  const seenEmails = new Set<string>();
  const uniqueParticipants: FixtureParticipant[] = [];
  for (const p of season.participants) {
    if (!p.email) {
      console.log(`  Skipping participant with null email: ${p.display_name_that_season}`);
      continue;
    }
    if (!seenEmails.has(p.email)) {
      seenEmails.add(p.email);
      uniqueParticipants.push(p);
    }
  }

  const userIdByEmail = new Map<string, string>();
  for (const p of uniqueParticipants) {
    const userId = await resolveUserId(emailToUserId, p.email!, p.display_name_that_season);
    userIdByEmail.set(p.email!, userId);
  }

  const commissionerEmail = uniqueParticipants[0].email!;
  const commissionerId = userIdByEmail.get(commissionerEmail)!;

  const benchSlots = Math.max(0, ...season.participants.map((p) => p.players.filter((pl) => pl.is_bench).length));
  const settings: LeagueSettings = { ...HISTORICAL_SETTINGS_BASE, bench_slots: benchSlots };

  const { data: league, error: leagueErr } = await supabaseAdmin
    .from('leagues')
    .insert({ name: leagueName, season: season.season, commissioner_id: commissionerId, is_demo: false, settings })
    .select('id')
    .single();
  if (leagueErr || !league) throw new Error(`seedSeason ${season.season}: league insert failed: ${leagueErr?.message}`);
  const league_id = league.id as string;

  const memberRows = uniqueParticipants.map((p) => ({
    league_id,
    user_id: userIdByEmail.get(p.email!)!,
    role: p.email === commissionerEmail ? ('commissioner' as const) : ('member' as const),
  }));
  const { error: membersErr } = await supabaseAdmin.from('league_members').insert(memberRows);
  if (membersErr) throw new Error(`seedSeason ${season.season}: league_members insert failed: ${membersErr.message}`);

  // Players, teams, roster_slots, game_scores — iterate ALL participant entries
  // (including the 2017 duplicates) so every player ends up on the merged user's roster.
  const teamCache = new Map<string, string>();
  const playerCache = new Map<string, string>();
  const slotCounters = new Map<string, number>();
  const gameScoreRows: {
    player_id: string;
    season: number;
    round_stage: ScoreRoundStage;
    game_date: string;
    game_status: 'final';
    points: number;
    source: 'manual';
  }[] = [];

  for (const p of season.participants) {
    if (!p.email) continue;
    const userId = userIdByEmail.get(p.email)!;
    let counter = slotCounters.get(userId) ?? 0;

    for (let i = 0; i < p.players.length; i++) {
      const fp = p.players[i];
      const teamId = await findOrCreateTeam(season.season, fp.school, teamCache);
      const playerId = await findOrCreatePlayer(season.season, fp, teamId, playerCache);

      counter++;
      // Activated bench players: acquired_at_round_stage = the round they were subbed in.
      // Unactivated bench players and starters: acquired_at_round_stage = 'draft'.
      const acquiredAt: string = (fp.is_bench && fp.activated_round) ? fp.activated_round : 'draft';
      const { error: slotErr } = await supabaseAdmin.from('roster_slots').insert({
        league_id,
        user_id: userId,
        player_id: playerId,
        slot_key: `H${counter}`,
        slot_position: fp.position,
        is_active: true,
        is_bench: fp.is_bench,
        acquired_at_round_stage: acquiredAt,
      });
      if (slotErr) throw new Error(`seedSeason ${season.season}: roster_slots insert failed for "${fp.name}": ${slotErr.message}`);

      for (const stage of SCORE_ROUND_STAGES) {
        const points = fp.scores[stage] ?? 0;
        if (points > 0) {
          gameScoreRows.push({
            player_id: playerId,
            season: season.season,
            round_stage: stage,
            game_date: `${season.season}-${ROUND_STAGE_GAME_DATE_SUFFIX[stage]}`,
            game_status: 'final',
            points,
            source: 'manual',
          });
        }
      }
    }

    slotCounters.set(userId, counter);
  }

  for (const batch of chunk(gameScoreRows, 100)) {
    const { error } = await supabaseAdmin
      .from('game_scores')
      .upsert(batch, { onConflict: 'player_id,round_stage,round_number,game_date' });
    if (error) throw new Error(`seedSeason ${season.season}: game_scores upsert failed: ${error.message}`);
  }

  await ScoreAccumulator.runForLeague(league_id);

  // Summary
  const memberUserIds = uniqueParticipants.map((p) => userIdByEmail.get(p.email!)!);
  const { data: snapshots, error: snapErr } = await supabaseAdmin
    .from('leaderboard_snapshots')
    .select('user_id, total_points')
    .eq('league_id', league_id)
    .order('total_points', { ascending: false });
  if (snapErr) throw new Error(`seedSeason ${season.season}: leaderboard_snapshots query failed: ${snapErr.message}`);

  const { data: userRows, error: userErr } = await supabaseAdmin
    .from('users')
    .select('id, display_name')
    .in('id', memberUserIds);
  if (userErr) throw new Error(`seedSeason ${season.season}: users query failed: ${userErr.message}`);
  const nameMap = new Map((userRows ?? []).map((u) => [u.id as string, u.display_name as string]));

  console.log(`  League: ${leagueName} (${league_id})`);
  (snapshots ?? []).forEach((s, i) => {
    const name = nameMap.get(s.user_id as string) ?? s.user_id;
    const marker = i === 0 ? '  <- WINNER' : '';
    console.log(`    ${i + 1}. ${name}: ${s.total_points} pts${marker}`);
  });

  const championId = userIdByEmail.get(season.champion_email.toLowerCase());
  const topUserId = (snapshots ?? [])[0]?.user_id as string | undefined;
  if (championId && topUserId && championId !== topUserId) {
    console.log(`    Note: fixture champion_email (${season.champion_email}) does not match the computed top scorer.`);
  }
}

// ── Main ─────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const fixturePath = path.join(process.cwd(), 'historical_fixture.json');
  const raw = fs.readFileSync(fixturePath, 'utf-8');
  const fixture = JSON.parse(raw) as FixtureRoot;

  const emailToUserId = await loadExistingUsers();

  for (const season of fixture.seasons) {
    if (PENDING_VERIFICATION_SEASONS.includes(season.season)) {
      console.log(`\nSkipping season ${season.season} — pending verification.`);
      continue;
    }
    await seedSeason(season, emailToUserId);
  }

  console.log('\nDone.');
}

main().catch((err) => {
  console.error('seed-historical-data: fatal error:', err);
  process.exit(1);
});
