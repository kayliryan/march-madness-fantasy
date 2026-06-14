import '@/lib/utils/wsPolyfill';
import { createClient } from '@supabase/supabase-js';
import { createServerClient } from '@supabase/ssr';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import { RosterActivationService } from '@/lib/services/RosterActivationService';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import type { LeagueSettings } from '@/lib/types';

// ── Setup ────────────────────────────────────────────────────────────────

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL;
const SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const ANON_KEY = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';
const CRON_SECRET = process.env.CRON_SECRET;

/** Password used for every auth user created by createTestLeague(). */
export const TEST_USER_PASSWORD = 'TestPassword123!';

if (!SUPABASE_URL || !SERVICE_ROLE_KEY) {
  throw new Error(
    'testHelpers: NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required ' +
    '(run scripts with `npx tsx --env-file=.env.local`)'
  );
}

// Service-role client, separate from the singleton in `@/lib/supabase/client` — same
// convention as scripts/seed-demo-league.ts. The services imported above (ScoreAccumulator,
// RosterActivationService) use their own internal `supabaseAdmin`; both clients hit the
// same database via the service role key.
export const db = createClient(SUPABASE_URL, SERVICE_ROLE_KEY);

export class AssertionError extends Error {}

export function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

const CHUNK_SIZE = 100;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

// ── Roster slot layout (mirrors default starter_slots {G:2,F:2,C:1} + bench_slots:3) ──

const SLOT_KEYS = ['G1', 'G2', 'F1', 'F2', 'C1', 'B1', 'B2', 'B3'] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

const SLOT_POSITIONS: Record<SlotKey, 'G' | 'F' | 'C'> = {
  G1: 'G', G2: 'G', F1: 'F', F2: 'F', C1: 'C', B1: 'G', B2: 'F', B3: 'C',
};

const SLOT_IS_BENCH: Record<SlotKey, boolean> = {
  G1: false, G2: false, F1: false, F2: false, C1: false, B1: true, B2: true, B3: true,
};

// Mirrors DEFAULT_SETTINGS in src/app/api/league/route.ts
const DEFAULT_SETTINGS: LeagueSettings = {
  draft_type: 'snake',
  draft_order_lock_days_before: 3,
  pick_timer_seconds: 90,
  starter_slots: { G: 2, F: 2, C: 1 },
  bench_slots: 3,
  sub_eligibility_matrix: {
    G: ['G', 'F'],
    F: ['G', 'F'],
    C: ['C'],
  },
  bench_lock_mode: 'before_first_game',
  activation_timing: 'immediate',
  injury_sub_enabled: false,
  injury_sub_reversible: false,
  tiebreaker_strategies: ['highest_single_active_game'],
  scoring_includes_play_in: true,
  stats_provider: 'espn',
  notifications: {
    round_end_email: true,
    daily_digest: false,
    ai_summary: true,
  },
  email_tone: 'playful',
};

// ── createTestLeague ─────────────────────────────────────────────────────

export interface CreateTestLeagueOptions {
  /** Number of league members (and snake-draft participants). Default 8. */
  memberCount?: number;
  /** Season to draft players/teams from — must already be seeded. Default 2026. */
  season?: number;
  activationTiming: 'immediate' | 'end_of_round';
  /** Default false. */
  injurySubEnabled?: boolean;
  /** Default 'before_first_game'. Maps onto draft_sessions.bench_lock_deadline (see below) —
   *  the cron job's bench-lock check (Responsibility 2) reads bench_lock_deadline directly
   *  and does not consult this setting. */
  benchLockMode?: 'before_first_game' | 'always_editable';
}

export interface TestLeague {
  league_id: string;
  commissioner_id: string;
  member_ids: string[];
  /** user_id -> drafted player_ids, in SLOT_KEYS order (G1,G2,F1,F2,C1,B1,B2,B3). */
  player_assignments: Map<string, string[]>;
}

/**
 * Creates a fully-drafted test league: N auth users, a league with the given
 * settings, league_members, a completed snake draft (draft_sessions/draft_picks),
 * and roster_slots for every drafted player (acquired_at_round_stage: 'draft').
 *
 * Each call creates brand-new auth users (unique emails per run), so leagues
 * created by different calls never collide. Players are drawn from the shared
 * `players`/`teams` tables for `season` — multiple test leagues can draft the
 * same players concurrently since roster_slots are league-scoped.
 */
export async function createTestLeague(options: CreateTestLeagueOptions): Promise<TestLeague> {
  const memberCount = options.memberCount ?? 8;
  const season = options.season ?? 2026;
  const runId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  // 1. Create auth users (handle_new_user trigger creates the matching public.users row)
  const member_ids: string[] = [];
  for (let i = 0; i < memberCount; i++) {
    const { data, error } = await db.auth.admin.createUser({
      email: `test-${runId}-${i}@test.invalid`,
      password: TEST_USER_PASSWORD,
      email_confirm: true,
      user_metadata: { display_name: `Test User ${i + 1} (${runId})` },
    });
    if (error || !data.user) {
      throw new Error(`createTestLeague: failed to create user ${i}: ${error?.message}`);
    }
    member_ids.push(data.user.id);
  }

  // Regression check (migration 000008's handle_new_user SECURITY DEFINER trigger): if this
  // ever loses its privileges again, public.users rows silently won't be created and every
  // FK below (league_members.user_id, roster_slots.user_id, draft_picks.user_id, ...) fails.
  const { data: userRows } = await db.from('users').select('id').in('id', member_ids);
  assert(
    (userRows ?? []).length === memberCount,
    `createTestLeague: handle_new_user regression — expected ${memberCount} public.users rows ` +
    `for newly-created auth users, got ${(userRows ?? []).length}`
  );

  const commissioner_id = member_ids[0];

  // 2. Create league
  const settings: LeagueSettings = {
    ...DEFAULT_SETTINGS,
    activation_timing: options.activationTiming,
    injury_sub_enabled: options.injurySubEnabled ?? false,
    bench_lock_mode: options.benchLockMode ?? 'before_first_game',
  };

  const { data: league, error: leagueErr } = await db
    .from('leagues')
    .insert({ name: `Test League ${runId}`, season, commissioner_id, settings })
    .select('id')
    .single();
  if (leagueErr || !league) {
    throw new Error(`createTestLeague: failed to create league: ${leagueErr?.message}`);
  }
  const league_id = league.id as string;

  // 3. League members (member 0 = commissioner)
  const memberRows = member_ids.map((user_id, i) => ({
    league_id,
    user_id,
    role: i === 0 ? 'commissioner' : 'member',
  }));
  const { error: membersErr } = await db.from('league_members').insert(memberRows);
  if (membersErr) {
    throw new Error(`createTestLeague: failed to create league_members: ${membersErr.message}`);
  }

  // 4. Load player pool, split by position
  const slotsNeeded: Record<'G' | 'F' | 'C', number> = { G: 0, F: 0, C: 0 };
  for (const slotKey of SLOT_KEYS) slotsNeeded[SLOT_POSITIONS[slotKey]]++;

  const { data: allPlayers } = await db
    .from('players')
    .select('id, position, avg_ppg')
    .eq('season', season)
    .order('avg_ppg', { ascending: false });

  if (!allPlayers?.length) {
    throw new Error(`createTestLeague: no players found for season ${season} — run seed-players-2026.ts first`);
  }

  const byPos: Record<'G' | 'F' | 'C', { id: string }[]> = { G: [], F: [], C: [] };
  for (const p of allPlayers as { id: string; position: 'G' | 'F' | 'C' }[]) {
    if (p.position in byPos) byPos[p.position].push({ id: p.id });
  }

  for (const pos of ['G', 'F', 'C'] as const) {
    const needed = slotsNeeded[pos] * memberCount;
    if (byPos[pos].length < needed) {
      throw new Error(
        `createTestLeague: not enough ${pos} players for season ${season} — need ${needed}, have ${byPos[pos].length}`
      );
    }
  }

  // 5. Create a completed draft session
  const now = new Date();
  const startedAt = new Date(now.getTime() - 2 * 60 * 60 * 1000);
  const completedAt = new Date(now.getTime() - 60 * 60 * 1000);
  const pickTimerSeconds = settings.pick_timer_seconds ?? 90;

  // bench_lock_deadline is what the cron job's bench-lock check (Responsibility 2) actually
  // reads — set it in the past for 'before_first_game' so triggerSync() locks bench_orders
  // immediately, or null for 'always_editable' so it never locks via cron.
  const benchLockDeadline =
    (options.benchLockMode ?? 'before_first_game') === 'before_first_game'
      ? new Date(now.getTime() - 5 * 60 * 1000).toISOString()
      : null;

  const totalPicks = memberCount * SLOT_KEYS.length;
  const { data: draftSession, error: sessionErr } = await db
    .from('draft_sessions')
    .insert({
      league_id,
      season,
      status: 'complete',
      draft_type: 'snake',
      scheduled_start: startedAt.toISOString(),
      started_at: startedAt.toISOString(),
      completed_at: completedAt.toISOString(),
      snake_order: member_ids,
      current_pick_number: totalPicks + 1,
      pick_timer_seconds: pickTimerSeconds,
      bench_lock_deadline: benchLockDeadline,
    })
    .select('id')
    .single();
  if (sessionErr || !draftSession) {
    throw new Error(`createTestLeague: failed to create draft_sessions: ${sessionErr?.message}`);
  }
  const draft_session_id = draftSession.id as string;

  // 6. Simulate a snake draft, building draft_picks + roster_slots rows
  const cursor: Record<'G' | 'F' | 'C', number> = { G: 0, F: 0, C: 0 };
  const player_assignments = new Map<string, string[]>(member_ids.map((id) => [id, []]));
  const draftPicks: Record<string, unknown>[] = [];
  const rosterSlots: Record<string, unknown>[] = [];

  let pickNumber = 0;
  for (let round = 0; round < SLOT_KEYS.length; round++) {
    const slotKey = SLOT_KEYS[round];
    const pos = SLOT_POSITIONS[slotKey];
    const order = round % 2 === 0 ? member_ids : [...member_ids].slice().reverse();

    for (const user_id of order) {
      pickNumber++;
      const player = byPos[pos][cursor[pos]++];

      draftPicks.push({
        draft_session_id,
        league_id,
        pick_number: pickNumber,
        round_number: round + 1,
        user_id,
        player_id: player.id,
        picked_at: new Date(startedAt.getTime() + (pickNumber - 1) * pickTimerSeconds * 1000).toISOString(),
        was_auto_picked: false,
      });

      rosterSlots.push({
        league_id,
        user_id,
        player_id: player.id,
        slot_key: slotKey,
        slot_position: pos,
        is_active: true,
        is_bench: SLOT_IS_BENCH[slotKey],
        acquired_at_round_stage: 'draft',
      });

      player_assignments.get(user_id)!.push(player.id);
    }
  }

  for (const batch of chunk(draftPicks, CHUNK_SIZE)) {
    const { error } = await db.from('draft_picks').insert(batch);
    if (error) throw new Error(`createTestLeague: failed to insert draft_picks: ${error.message}`);
  }
  for (const batch of chunk(rosterSlots, CHUNK_SIZE)) {
    const { error } = await db.from('roster_slots').insert(batch);
    if (error) throw new Error(`createTestLeague: failed to insert roster_slots: ${error.message}`);
  }

  return { league_id, commissioner_id, member_ids, player_assignments };
}

// ── advanceRound ─────────────────────────────────────────────────────────

const PLAYABLE_ROUND_STAGES = ROUND_STAGE_ORDER.filter((s) => s !== 'draft') as RoundStage[];

const GAME_DATES: Record<RoundStage, string> = {
  draft: '2026-03-10',
  play_in: '2026-03-17',
  r64: '2026-03-19',
  r32: '2026-03-21',
  s16: '2026-03-26',
  e8: '2026-03-28',
  f4: '2026-04-04',
  championship: '2026-04-06',
};

interface TeamRow {
  id: string;
  seed: number;
  region: string;
}

/**
 * Deterministic per-team elimination round, derived purely from (seed, region).
 *
 * Rounds r64–e8 mirror the tiering already used by src/lib/utils/seedDemoData.ts
 * (play-in losers -> 'play_in'; seed<=2 -> survives past e8; seed<=4 -> 's16';
 * seed<=8 -> 'r32'; else -> 'r64'), so calling advanceRound against teams already
 * seeded by scripts/seed-demo-league.ts produces the SAME values (idempotent —
 * re-marking a team eliminated with the value it already has is a no-op).
 *
 * f4/championship are NOT modeled by seedDemoData (it stops at e8), so this adds a
 * deterministic extension on top of the 8 teams (seeds 1-2 x 4 regions) that "survive
 * past e8": of those 8, six are eliminated in 'f4' (each region's seed-2 team, plus
 * the seed-1 teams from the two alphabetically-last regions), leaving exactly two
 * finalists for 'championship'. Of those two, the alphabetically-later region's team
 * is eliminated in 'championship' (the runner-up); the alphabetically-first region's
 * team is the champion and is never marked eliminated. This keeps the realistic
 * invariant Script 7 depends on: 'championship' eliminates exactly one team (the
 * loser), and the winner's is_eliminated stays false.
 */
function computeEliminationRounds(teams: TeamRow[]): Map<string, RoundStage | null> {
  const elimRound = new Map<string, RoundStage | null>();

  const groups = new Map<string, TeamRow[]>();
  for (const t of teams) {
    const key = `${t.region}:${t.seed}`;
    const arr = groups.get(key) ?? [];
    arr.push(t);
    groups.set(key, arr);
  }

  for (const arr of groups.values()) {
    if (arr.length > 1) {
      // Play-in pair — pick the loser deterministically by id ordering.
      const sorted = [...arr].sort((a, b) => a.id.localeCompare(b.id));
      const loser = sorted[1];
      for (const t of arr) {
        elimRound.set(t.id, t.id === loser.id ? 'play_in' : baseEliminationRound(t.seed));
      }
    } else {
      elimRound.set(arr[0].id, baseEliminationRound(arr[0].seed));
    }
  }

  // f4/championship extension for the seed<=2 "survives past e8" set (8 teams: seed 1
  // and seed 2 in each of the 4 regions).
  const survivors = teams.filter((t) => elimRound.get(t.id) === null);
  const regions = [...new Set(survivors.map((t) => t.region))].sort();

  // Each region's seed-2 team loses in 'f4' (4 teams).
  for (const t of survivors) {
    if (t.seed === 2) elimRound.set(t.id, 'f4');
  }

  // Of the 4 regional seed-1 teams, the two from the alphabetically-last regions also
  // lose in 'f4' (2 more teams, 6 total) — leaving exactly 2 finalists.
  const seed1ByRegion = new Map(survivors.filter((t) => t.seed === 1).map((t) => [t.region, t]));
  if (regions.length === 4) {
    for (const region of regions.slice(2)) {
      const t = seed1ByRegion.get(region);
      if (t) elimRound.set(t.id, 'f4');
    }
    // Of the 2 finalists, the alphabetically-later region's team is the runner-up
    // (eliminated in 'championship'); the alphabetically-first region's team is the
    // champion and keeps elimRound === null.
    const runnerUp = seed1ByRegion.get(regions[1]);
    if (runnerUp) elimRound.set(runnerUp.id, 'championship');
  }

  return elimRound;
}

function baseEliminationRound(seed: number): RoundStage | null {
  if (seed <= 2) return null; // resolved by the f4/championship extension above
  if (seed <= 4) return 's16';
  if (seed <= 8) return 'r32';
  return 'r64';
}

function playsInRound(elim: RoundStage | null, stage: RoundStage): boolean {
  if (stage === 'play_in') return elim === 'play_in';
  if (elim === 'play_in') return false; // eliminated in play-in, never reaches r64+
  return elim === null || ROUND_STAGE_ORDER.indexOf(elim) >= ROUND_STAGE_ORDER.indexOf(stage);
}

export interface AdvanceRoundOptions {
  league_id: string;
  round_stage: RoundStage;
  season?: number;
}

export interface AdvanceRoundResult {
  eliminated_team_ids: string[];
  winning_team_ids: string[];
  game_score_ids: string[];
}

/**
 * Simulates one tournament round completing: marks the deterministic losers for
 * `round_stage` as eliminated, inserts a `game_status: 'final'` game_scores row
 * (points = avg_ppg * (0.8 + random*0.4)) for every player on a team still playing
 * this round, and recomputes scoring_events for those games via
 * ScoreAccumulator.runForGames.
 *
 * NOTE on activation: with MOCK_ESPN=true, the real cron job's elimination-detection
 * (Responsibility 1) never fires, so this function drives activation itself for
 * `activation_timing: 'immediate'` leagues by calling
 * RosterActivationService.activateImmediate() per newly-eliminated team — mirroring
 * the order the cron uses (runForGames BEFORE activation, so the round in which a
 * team is eliminated still counts for that team's players).
 *
 * For `activation_timing: 'end_of_round'` leagues, this function deliberately does
 * NOT call RosterActivationService.activateBatch() — call it directly (or call
 * triggerSync(), since inserting all-'final' game_scores for this round_stage/season
 * satisfies the cron's Responsibility 3 completeness check) once your test wants to
 * observe the post-batch-activation state.
 *
 * `teams`/`game_scores` are season-scoped, not league-scoped — eliminations and
 * scores from this call are visible to every league sharing `season`.
 */
export async function advanceRound(options: AdvanceRoundOptions): Promise<AdvanceRoundResult> {
  const { league_id, round_stage } = options;
  const season = options.season ?? 2026;

  assert(
    PLAYABLE_ROUND_STAGES.includes(round_stage),
    `advanceRound: round_stage must be one of ${PLAYABLE_ROUND_STAGES.join(', ')}, got "${round_stage}"`
  );

  const { data: teams } = await db.from('teams').select('id, seed, region').eq('season', season);
  assert((teams ?? []).length > 0, `advanceRound: no teams found for season ${season}`);

  const elimRound = computeEliminationRounds(teams as TeamRow[]);

  const eliminated_team_ids: string[] = [];
  const winning_team_ids: string[] = [];
  const playingTeamIds: string[] = [];

  for (const t of teams as TeamRow[]) {
    const elim = elimRound.get(t.id) ?? null;
    if (!playsInRound(elim, round_stage)) continue;
    playingTeamIds.push(t.id);
    if (elim === round_stage) {
      eliminated_team_ids.push(t.id);
    } else {
      winning_team_ids.push(t.id);
    }
  }

  // Persist eliminations. Idempotent: elimRound is a pure function of (seed, region), so
  // re-running advanceRound for the same round_stage writes the same value again.
  for (const teamId of eliminated_team_ids) {
    await db
      .from('teams')
      .update({ is_eliminated: true, eliminated_in_round_stage: round_stage, eliminated_in_round_number: 1 })
      .eq('id', teamId);
  }

  // Insert/refresh final game_scores for every player on a team playing this round
  const { data: players } = playingTeamIds.length > 0
    ? await db.from('players').select('id, avg_ppg').eq('season', season).in('team_id', playingTeamIds)
    : { data: [] as { id: string; avg_ppg: number }[] };

  const gameDate = GAME_DATES[round_stage];
  const syncedAt = new Date().toISOString();
  const game_score_ids: string[] = [];

  for (const batch of chunk(players ?? [], CHUNK_SIZE)) {
    const rows = batch.map((p: { id: string; avg_ppg: number }) => ({
      player_id: p.id,
      season,
      round_stage,
      round_number: 1,
      game_date: gameDate,
      game_status: 'final' as const,
      points: Math.round(p.avg_ppg * (0.8 + Math.random() * 0.4)),
      source: 'manual' as const,
      synced_at: syncedAt,
    }));

    const { data: upserted, error } = await db
      .from('game_scores')
      .upsert(rows, { onConflict: 'player_id,round_stage,round_number,game_date' })
      .select('id');
    if (error) throw new Error(`advanceRound: game_scores upsert failed: ${error.message}`);
    for (const row of upserted ?? []) game_score_ids.push(row.id as string);
  }

  // Recompute scoring_events for the games just written (pre-activation, per cron ordering)
  if (game_score_ids.length > 0) {
    for (const batch of chunk(game_score_ids, CHUNK_SIZE)) {
      await db.from('scoring_events').update({ is_stale: true }).in('game_score_id', batch);
    }
    await ScoreAccumulator.runForGames(game_score_ids);
  }

  // Immediate activation for this league's newly-eliminated teams
  if (eliminated_team_ids.length > 0) {
    const { data: league } = await db.from('leagues').select('settings').eq('id', league_id).single();
    const settings = league?.settings as LeagueSettings | undefined;
    if (!settings?.activation_timing || settings.activation_timing === 'immediate') {
      for (const teamId of eliminated_team_ids) {
        await RosterActivationService.activateImmediate(league_id, teamId);
      }
    }
  }

  return { eliminated_team_ids, winning_team_ids, game_score_ids };
}

// ── triggerSync ──────────────────────────────────────────────────────────

/**
 * Calls GET /api/cron/sync-scores with the CRON_SECRET bearer token, exactly as
 * Vercel's cron would.
 *
 * With MOCK_ESPN=true, ESPNStatsProvider.getGameStatus/getTeamEliminations always
 * return empty results, so Responsibility 1 (score sync + immediate activation) is
 * a no-op here — use advanceRound() to drive that path directly.
 *
 * What triggerSync() DOES reliably exercise in local dev:
 *  - Responsibility 2 (bench lock): locks bench_orders for any draft_sessions whose
 *    bench_lock_deadline has passed. This is GLOBAL — it locks bench orders for
 *    every league with a past-due deadline, not just one test league.
 *  - Responsibility 3 (end-of-round detection): if advanceRound() just wrote
 *    all-'final' game_scores for every row at (season, round_stage), this will
 *    detect the round as complete and call RosterActivationService.activateBatch()
 *    for every 'end_of_round' league across the whole season.
 */
export async function triggerSync(): Promise<{ ok?: boolean; in_progress?: boolean; skipped?: boolean }> {
  assert(CRON_SECRET, 'triggerSync: CRON_SECRET is not set in .env.local');

  const res = await fetch(`${APP_URL}/api/cron/sync-scores`, {
    headers: { Authorization: `Bearer ${CRON_SECRET}` },
  });
  if (!res.ok) {
    throw new Error(`triggerSync: GET /api/cron/sync-scores returned ${res.status}`);
  }
  return res.json();
}

// ── Authenticated HTTP requests ──────────────────────────────────────────

/** Looks up the email for a user_id created by createTestLeague (needed to sign in). */
export async function getUserEmail(user_id: string): Promise<string> {
  const { data, error } = await db.auth.admin.getUserById(user_id);
  if (error || !data.user?.email) {
    throw new Error(`getUserEmail: failed to look up user ${user_id}: ${error?.message}`);
  }
  return data.user.email;
}

/**
 * Signs in with the @supabase/ssr cookie-jar pattern (mirrors scripts/verify-auth-fix.ts)
 * and returns a `Cookie` header value so API routes that call
 * `createServerClient(...).auth.getUser()` see an authenticated session.
 */
export async function getAuthCookieHeader(email: string, password: string): Promise<string> {
  assert(ANON_KEY, 'getAuthCookieHeader: NEXT_PUBLIC_SUPABASE_ANON_KEY is not set');

  const jar = new Map<string, string>();
  const supabase = createServerClient(SUPABASE_URL!, ANON_KEY, {
    cookies: {
      getAll() {
        return [...jar.entries()].map(([name, value]) => ({ name, value }));
      },
      setAll(cookies) {
        for (const { name, value } of cookies) jar.set(name, value);
      },
    },
  });

  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`getAuthCookieHeader: signInWithPassword failed for ${email}: ${error.message}`);

  return [...jar.entries()].map(([name, value]) => `${name}=${value}`).join('; ');
}

// ── setSubmittedBenchOrder ───────────────────────────────────────────────

export interface SetSubmittedBenchOrderOptions {
  league_id: string;
  user_id: string;
  ordered_player_ids: string[];
}

/**
 * Direct DB write (bypasses PATCH /api/commissioner/bench-order, so the Bug #5
 * locked_at check doesn't apply here) that upserts a bench_orders row with
 * submitted_at set — putting the row in the state BenchOrderService.resolveNext
 * requires (`submitted_at` non-null + `ordered_player_ids` non-empty) to honor
 * the user's order rather than falling back to highest-avg_ppg.
 */
export async function setSubmittedBenchOrder(options: SetSubmittedBenchOrderOptions): Promise<void> {
  const now = new Date().toISOString();

  const { data: existing } = await db
    .from('bench_orders')
    .select('id')
    .eq('league_id', options.league_id)
    .eq('user_id', options.user_id)
    .maybeSingle();

  if (existing) {
    const { error } = await db
      .from('bench_orders')
      .update({
        ordered_player_ids: options.ordered_player_ids,
        submitted_at: now,
        last_edited_at: now,
      })
      .eq('id', existing.id);
    if (error) throw new Error(`setSubmittedBenchOrder: update failed: ${error.message}`);
  } else {
    const { error } = await db.from('bench_orders').insert({
      league_id: options.league_id,
      user_id: options.user_id,
      ordered_player_ids: options.ordered_player_ids,
      submitted_at: now,
      last_edited_at: now,
    });
    if (error) throw new Error(`setSubmittedBenchOrder: insert failed: ${error.message}`);
  }
}

// ── Assertions ───────────────────────────────────────────────────────────

export interface AssertRosterSlotOptions {
  league_id: string;
  user_id: string;
  player_id: string;
  expected_is_active: boolean;
  /** Round-stage label (e.g. 'draft', 'r64'), not a timestamp. */
  expected_acquired_at_round_stage: string;
  /** Round-stage label, or null if the slot has not been released. */
  expected_released_at_round_stage: string | null;
}

export async function assertRosterSlot(options: AssertRosterSlotOptions): Promise<void> {
  const { data: slot, error } = await db
    .from('roster_slots')
    .select('is_active, acquired_at_round_stage, released_at_round_stage')
    .eq('league_id', options.league_id)
    .eq('user_id', options.user_id)
    .eq('player_id', options.player_id)
    .maybeSingle();

  if (error) {
    throw new Error(
      `assertRosterSlot: query failed for league=${options.league_id} user=${options.user_id} ` +
      `player=${options.player_id}: ${error.message} (multiple rows? expected exactly one)`
    );
  }
  assert(
    slot,
    `assertRosterSlot: no roster_slots row for league=${options.league_id} user=${options.user_id} player=${options.player_id}`
  );
  assert(
    slot.is_active === options.expected_is_active,
    `assertRosterSlot: is_active expected ${options.expected_is_active}, got ${slot.is_active} ` +
    `(league=${options.league_id} user=${options.user_id} player=${options.player_id})`
  );
  assert(
    slot.acquired_at_round_stage === options.expected_acquired_at_round_stage,
    `assertRosterSlot: acquired_at_round_stage expected "${options.expected_acquired_at_round_stage}", ` +
    `got "${slot.acquired_at_round_stage}" (league=${options.league_id} user=${options.user_id} player=${options.player_id})`
  );
  assert(
    (slot.released_at_round_stage ?? null) === options.expected_released_at_round_stage,
    `assertRosterSlot: released_at_round_stage expected ${JSON.stringify(options.expected_released_at_round_stage)}, ` +
    `got ${JSON.stringify(slot.released_at_round_stage ?? null)} ` +
    `(league=${options.league_id} user=${options.user_id} player=${options.player_id})`
  );
}

export interface AssertScoringEventsOptions {
  league_id: string;
  user_id: string;
  round_stage: string;
  expected_points: number;
}

/**
 * Sums points_credited across non-stale scoring_events for (league, user, round_stage)
 * and asserts the total matches expected_points exactly.
 */
export async function assertScoringEvents(options: AssertScoringEventsOptions): Promise<void> {
  const { data: events, error } = await db
    .from('scoring_events')
    .select('points_credited')
    .eq('league_id', options.league_id)
    .eq('user_id', options.user_id)
    .eq('round_stage', options.round_stage)
    .eq('is_stale', false);

  if (error) throw new Error(`assertScoringEvents: query failed: ${error.message}`);

  const total = (events ?? []).reduce((sum, e) => sum + (e.points_credited as number), 0);
  assert(
    total === options.expected_points,
    `assertScoringEvents: league=${options.league_id} user=${options.user_id} round_stage=${options.round_stage} ` +
    `expected total ${options.expected_points}, got ${total} (over ${(events ?? []).length} events)`
  );
}

export interface AssertLeaderboardOptions {
  league_id: string;
  expected_rankings: Array<{ user_id: string; min_points: number; max_points: number }>;
}

/**
 * Checks each user's leaderboard_snapshots.total_points falls within
 * [min_points, max_points] — a range rather than an exact value, since
 * advanceRound() applies randomized per-game points (avg_ppg * 0.8-1.2).
 */
export async function assertLeaderboard(options: AssertLeaderboardOptions): Promise<void> {
  for (const r of options.expected_rankings) {
    const { data: snap, error } = await db
      .from('leaderboard_snapshots')
      .select('total_points')
      .eq('league_id', options.league_id)
      .eq('user_id', r.user_id)
      .maybeSingle();

    if (error) throw new Error(`assertLeaderboard: query failed for user=${r.user_id}: ${error.message}`);
    assert(snap, `assertLeaderboard: no leaderboard_snapshots row for league=${options.league_id} user=${r.user_id}`);
    assert(
      snap.total_points >= r.min_points && snap.total_points <= r.max_points,
      `assertLeaderboard: user=${r.user_id} total_points=${snap.total_points} not in [${r.min_points}, ${r.max_points}]`
    );
  }
}

// ── cleanupTestLeague ────────────────────────────────────────────────────

/**
 * Deletes all league-scoped rows for `league_id` via the delete_orphaned_demo_leagues
 * RPC (migration 20260608000017) — despite the "demo" name, it accepts any league_ids
 * array and performs the full FK-safe deletion: scoring_events, timer_extensions,
 * draft_picks, draft_queues, roster_slots, bench_orders, leaderboard_snapshots,
 * league_notifications, league_invites, league_members, draft_sessions, leagues.
 *
 * Does NOT delete: game_scores, players, teams (season-scoped shared fixtures used
 * by other leagues/tests), or the auth/public.users rows created by createTestLeague.
 */
export async function cleanupTestLeague(league_id: string): Promise<void> {
  const { error } = await db.rpc('delete_orphaned_demo_leagues', { p_league_ids: [league_id] });
  if (error) throw new Error(`cleanupTestLeague: delete_orphaned_demo_leagues failed: ${error.message}`);
}
