import '@/lib/utils/wsPolyfill';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';
import type { LeagueSettings } from '@/lib/types';
import {
  db,
  assert,
  createTestLeague,
  cleanupTestLeague,
  TEST_USER_PASSWORD,
  getUserEmail,
  getAuthCookieHeader,
} from './utils/testHelpers';
import { simulateRound } from './simulate-round';

const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3000';

// ── Test runner ────────────────────────────────────────────────────────────

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string; note?: string }[] = [];

async function runCase(name: string, fn: () => Promise<void>, note?: string): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS', note });
    console.log(`PASS  ${name}`);
    if (note) console.log(`      note: ${note}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message, note });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
    if (note) console.log(`      note: ${note}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

async function upsertGameScore(
  player_id: string,
  round_stage: string,
  game_date: string,
  points: number
): Promise<string> {
  const { data, error } = await db
    .from('game_scores')
    .upsert(
      {
        player_id,
        season: 2026,
        round_stage,
        round_number: 1,
        game_date,
        game_status: 'final',
        points,
        source: 'manual',
        synced_at: new Date().toISOString(),
      },
      { onConflict: 'player_id,round_stage,round_number,game_date' }
    )
    .select('id')
    .single();

  if (error || !data) throw new Error(`upsertGameScore failed: ${error?.message}`);
  return data.id as string;
}

async function patchSettings(cookie: string, league_id: string, settings: Partial<LeagueSettings>): Promise<void> {
  const res = await fetch(`${APP_URL}/api/commissioner/settings`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', Cookie: cookie },
    body: JSON.stringify({ league_id, settings }),
  });
  const text = await res.text();
  assert(res.ok, `PATCH /api/commissioner/settings returned ${res.status}: ${text}`);
}

interface ScoringEventTuple {
  game_score_id: string;
  user_id: string;
  points_credited: number;
  roster_slot_id: string | null;
  round_stage: string;
}

async function getScoringEventsSnapshot(league_id: string): Promise<Set<string>> {
  const { data, error } = await db
    .from('scoring_events')
    .select('game_score_id, user_id, points_credited, roster_slot_id, round_stage')
    .eq('league_id', league_id)
    .eq('is_stale', false);
  if (error) throw new Error(`getScoringEventsSnapshot failed: ${error.message}`);
  return new Set((data ?? []).map((e) => JSON.stringify(e as ScoringEventTuple)));
}

interface SnapshotRow {
  total_points: number;
  last_computed_at: string;
  round_stage: string;
}

async function getSnapshots(league_id: string, user_ids: string[]): Promise<Map<string, SnapshotRow>> {
  const { data, error } = await db
    .from('leaderboard_snapshots')
    .select('user_id, total_points, last_computed_at, round_stage')
    .eq('league_id', league_id)
    .in('user_id', user_ids);
  if (error) throw new Error(`getSnapshots failed: ${error.message}`);
  return new Map((data ?? []).map((r) => [r.user_id, { total_points: r.total_points, last_computed_at: r.last_computed_at, round_stage: r.round_stage }]));
}

/** Polls leaderboard_snapshots until last_computed_at advances past `baselines` for every user. */
async function waitForSnapshotsAfter(
  league_id: string,
  baselines: Map<string, string>,
  timeoutMs = 8000
): Promise<Map<string, SnapshotRow>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const snaps = await getSnapshots(league_id, [...baselines.keys()]);
    const allAdvanced = snaps.size === baselines.size && [...baselines].every(([user_id, baseline]) => {
      const row = snaps.get(user_id);
      return row !== undefined && new Date(row.last_computed_at).getTime() > new Date(baseline).getTime();
    });
    if (allAdvanced) return snaps;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`waitForSnapshotsAfter: timed out waiting for leaderboard_snapshots.last_computed_at to advance for league ${league_id}`);
}

// ── Cases ────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Case A — sub_eligibility_matrix change: ScoreAccumulator fires, but is non-destructive
  await runCase(
    'Case A — sub_eligibility_matrix change: scoring_events unchanged, last_computed_at advances',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

        const before = await getScoringEventsSnapshot(league.league_id);
        assert(before.size > 0, 'expected non-empty scoring_events after r64');

        const snapsBefore = await getSnapshots(league.league_id, league.member_ids);
        assert(snapsBefore.size === league.member_ids.length, `expected ${league.member_ids.length} leaderboard_snapshots rows, got ${snapsBefore.size}`);
        const baselines = new Map([...snapsBefore].map(([user_id, row]) => [user_id, row.last_computed_at]));

        const email = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

        // Different from DEFAULT_SETTINGS (G/F cross-eligible) — restricts subs to same-position only.
        await patchSettings(cookie, league.league_id, {
          sub_eligibility_matrix: { G: ['G'], F: ['F'], C: ['C'] },
        });

        const after = await waitForSnapshotsAfter(league.league_id, baselines);

        // Corrected assertion (per handoff doc): the append-only roster_slots model means
        // past activations are historical fact — changing sub_eligibility_matrix does not
        // retroactively alter who was active for past games. ScoreAccumulator fired (proven
        // by last_computed_at advancing above) AND the recompute is idempotent/non-destructive.
        const afterEvents = await getScoringEventsSnapshot(league.league_id);
        assert(
          afterEvents.size === before.size && [...before].every((e) => afterEvents.has(e)),
          `scoring_events changed after sub_eligibility_matrix recompute: expected the same ${before.size} ` +
          `events, got ${afterEvents.size} (set difference: ${[...before].filter((e) => !afterEvents.has(e)).length} removed, ` +
          `${[...afterEvents].filter((e) => !before.has(e)).length} added)`
        );

        for (const [user_id, snapBefore] of snapsBefore) {
          const snapAfter = after.get(user_id)!;
          assert(
            snapAfter.total_points === snapBefore.total_points,
            `user ${user_id}: total_points changed after sub_eligibility_matrix recompute (before=${snapBefore.total_points}, after=${snapAfter.total_points})`
          );
        }
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case B — scoring_includes_play_in toggle: play_in events removed, totals drop accordingly
  await runCase(
    'Case B — scoring_includes_play_in=false removes play_in scoring_events',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

        // Seed a play_in game_score for each member's G1 starter (acquired_at_round_stage='draft',
        // released=null -> eligible for play_in: acqIdx(0) <= gameStageIdx(1) < relIdx(8)).
        // Incremental runForGames touches only these new events, leaving the r64 baseline intact.
        const gameScoreIds: string[] = [];
        for (const user_id of league.member_ids) {
          const playerId = league.player_assignments.get(user_id)![0]; // G1
          gameScoreIds.push(await upsertGameScore(playerId, 'play_in', '2026-03-17', 20));
        }
        await ScoreAccumulator.runForGames(gameScoreIds);

        const { data: playInBefore, error: piErr } = await db
          .from('scoring_events')
          .select('user_id, points_credited')
          .eq('league_id', league.league_id)
          .eq('round_stage', 'play_in')
          .eq('is_stale', false);
        if (piErr) throw new Error(`scoring_events query failed: ${piErr.message}`);
        assert(
          (playInBefore ?? []).length === league.member_ids.length,
          `expected ${league.member_ids.length} play_in scoring_events, got ${(playInBefore ?? []).length}`
        );
        for (const e of playInBefore ?? []) {
          assert(e.points_credited === 20, `expected play_in points_credited=20, got ${e.points_credited}`);
        }

        const snapsBefore = await getSnapshots(league.league_id, league.member_ids);
        assert(snapsBefore.size === league.member_ids.length, `expected ${league.member_ids.length} leaderboard_snapshots rows, got ${snapsBefore.size}`);
        const baselines = new Map([...snapsBefore].map(([user_id, row]) => [user_id, row.last_computed_at]));

        const email = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

        await patchSettings(cookie, league.league_id, { scoring_includes_play_in: false });

        const after = await waitForSnapshotsAfter(league.league_id, baselines);

        const { count: playInAfterCount, error: piAfterErr } = await db
          .from('scoring_events')
          .select('*', { count: 'exact', head: true })
          .eq('league_id', league.league_id)
          .eq('round_stage', 'play_in')
          .eq('is_stale', false);
        if (piAfterErr) throw new Error(`scoring_events count query failed: ${piAfterErr.message}`);
        assert(
          playInAfterCount === 0,
          `expected 0 non-stale play_in scoring_events after scoring_includes_play_in=false, got ${playInAfterCount}`
        );

        // The r64 baseline (captured before seeding play_in) is reproduced identically by the
        // full rebuild (Case A establishes recompute idempotency) — so the only delta is the
        // removed 20-point play_in event, regardless of any shared-fixture game_scores at
        // other round_stages already baked into the r64 baseline.
        for (const [user_id, snapBefore] of snapsBefore) {
          const snapAfter = after.get(user_id)!;
          assert(
            snapAfter.total_points === snapBefore.total_points - 20,
            `user ${user_id}: expected total_points to decrease by 20 (play_in removed), before=${snapBefore.total_points}, after=${snapAfter.total_points}`
          );
        }
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // Case C — tiebreaker_strategies change: not scoring-affecting, no recompute fires
  await runCase(
    'Case C — tiebreaker_strategies change does not trigger ScoreAccumulator',
    async () => {
      const league = await createTestLeague({ memberCount: 2, activationTiming: 'immediate' });
      try {
        await simulateRound({ league_id: league.league_id, round_stage: 'r64' });

        const before = await getSnapshots(league.league_id, league.member_ids);
        assert(before.size === league.member_ids.length, `expected ${league.member_ids.length} leaderboard_snapshots rows, got ${before.size}`);

        const email = await getUserEmail(league.commissioner_id);
        const cookie = await getAuthCookieHeader(email, TEST_USER_PASSWORD);

        await patchSettings(cookie, league.league_id, {
          tiebreaker_strategies: ['most_active_players', 'highest_single_active_game'],
        });

        // tiebreaker_strategies is not in SCORING_AFFECTING_SETTINGS — give a would-be
        // fire-and-forget recompute time to run, then assert nothing changed.
        await new Promise((r) => setTimeout(r, 2000));

        const after = await getSnapshots(league.league_id, league.member_ids);
        for (const [user_id, snapBefore] of before) {
          const snapAfter = after.get(user_id);
          assert(snapAfter !== undefined, `missing leaderboard_snapshots row for user ${user_id} after settings change`);
          assert(
            snapAfter!.last_computed_at === snapBefore.last_computed_at,
            `leaderboard_snapshots.last_computed_at changed for user ${user_id} after a tiebreaker_strategies-only ` +
            `change (before=${snapBefore.last_computed_at}, after=${snapAfter!.last_computed_at}) — ` +
            `ScoreAccumulator.runForLeague should NOT fire for non-scoring-affecting settings`
          );
          assert(
            snapAfter!.total_points === snapBefore.total_points && snapAfter!.round_stage === snapBefore.round_stage,
            `leaderboard_snapshots changed for user ${user_id} after a tiebreaker_strategies-only change`
          );
        }

        const { data: leagueRow, error: leagueErr } = await db
          .from('leagues')
          .select('settings')
          .eq('id', league.league_id)
          .single();
        if (leagueErr || !leagueRow) throw new Error(`leagues query failed: ${leagueErr?.message}`);
        const settings = leagueRow.settings as LeagueSettings;
        assert(
          JSON.stringify(settings.tiebreaker_strategies) === JSON.stringify(['most_active_players', 'highest_single_active_game']),
          `expected tiebreaker_strategies to be persisted, got ${JSON.stringify(settings.tiebreaker_strategies)}`
        );
      } finally {
        await cleanupTestLeague(league.league_id);
      }
    }
  );

  // ── Summary ────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.status === 'PASS').length;
  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${passed} passed, ${failed} failed (of ${results.length})`);

  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('test-score-recalculation: unhandled error:', err);
  process.exit(1);
});
