import type { SupabaseClient } from '@supabase/supabase-js';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { ScoreAccumulator } from '@/lib/services/ScoreAccumulator';

const SLOT_KEYS = ['G1', 'G2', 'F1', 'F2', 'C1', 'B1', 'B2', 'B3'] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

const SLOT_POSITIONS: Record<SlotKey, 'G' | 'F' | 'C'> = {
  G1: 'G', G2: 'G', F1: 'F', F2: 'F', C1: 'C', B1: 'G', B2: 'F', B3: 'C',
};
const SLOT_IS_BENCH: Record<SlotKey, boolean> = {
  G1: false, G2: false, F1: false, F2: false, C1: false, B1: true, B2: true, B3: true,
};

// Used only to pick a plausible bench-activation pair for the seeded substitution
// event (item 7) — independent of a league's actual sub_eligibility_matrix setting.
const SUB_ELIGIBILITY_MATRIX: Record<'G' | 'F' | 'C', ('G' | 'F' | 'C')[]> = {
  G: ['G', 'F'], F: ['G', 'F'], C: ['C'],
};
const STARTER_SLOT_FOR_POS: Record<'G' | 'F' | 'C', SlotKey> = { G: 'G1', F: 'F1', C: 'C1' };
const BENCH_SLOT_FOR_POS: Record<'G' | 'F' | 'C', SlotKey> = { G: 'B1', F: 'B2', C: 'B3' };

// Rounds in which each seed tier is eliminated (null = not eliminated through E8)
// Seeds 1-2: survive to E8. Seeds 3-4: eliminated in S16. Seeds 5-8: R32. Seeds 9-16 + play-in losers: R64/play_in.
function getEliminationRound(seed: number, isPlayInLoser: boolean): RoundStage | null {
  if (isPlayInLoser) return 'play_in';
  if (seed <= 2) return null;
  if (seed <= 4) return 's16';
  if (seed <= 8) return 'r32';
  return 'r64';
}

const PLAYABLE_ROUND_STAGES = ROUND_STAGE_ORDER.filter(
  (s) => s !== 'draft' && s !== 'play_in' && s !== 'f4' && s !== 'championship'
);

// Rounds a team plays in, based on when they're eliminated. Uses ROUND_STAGE_ORDER.indexOf()
// rather than a hardcoded ordering array.
function roundsPlayed(eliminatedIn: RoundStage | null): RoundStage[] {
  if (eliminatedIn === 'play_in') return ['play_in'];
  if (!eliminatedIn) return PLAYABLE_ROUND_STAGES;
  const idx = ROUND_STAGE_ORDER.indexOf(eliminatedIn);
  return PLAYABLE_ROUND_STAGES.filter((r) => ROUND_STAGE_ORDER.indexOf(r) <= idx);
}

// Deterministic points: avg_ppg * round_multiplier with minor seed-based variance.
// These multipliers are the "fixture" calibrated in Section 14.10 — do not adjust at runtime.
const ROUND_POINT_MULTIPLIERS: Record<string, number> = {
  play_in: 0.9, r64: 1.0, r32: 1.05, s16: 1.1, e8: 1.15,
};
function gamePoints(avgPpg: number, seed: number, round: RoundStage): number {
  const variance = 1 - (seed - 1) * 0.005;
  return Math.round(avgPpg * (ROUND_POINT_MULTIPLIERS[round] ?? 1.0) * variance);
}

const GAME_DATES: Record<string, string> = {
  play_in: '2026-03-19',
  r64: '2026-03-21',
  r32: '2026-03-23',
  s16: '2026-03-27',
  e8: '2026-03-29',
};

type PlayerRow = {
  id: string;
  name: string;
  position: 'G' | 'F' | 'C';
  avg_ppg: number;
  team_id: string;
  teams: { seed: number; region: string } | { seed: number; region: string }[] | null;
};

function getTeamMeta(p: PlayerRow): { seed: number; region: string } | null {
  if (!p.teams) return null;
  return Array.isArray(p.teams) ? (p.teams[0] ?? null) : p.teams;
}

/**
 * Seeds a fully-played-through-Elite-8 fantasy league: completed historical draft
 * (with draft_picks), roster_slots (including one bench-activation substitution),
 * game_scores for play_in–e8, and leaderboard via ScoreAccumulator.runForLeague().
 * Idempotent — safe to re-run for the same league_id.
 */
export async function seedDemoLeagueData(
  supabaseAdmin: SupabaseClient,
  league_id: string,
  member_user_ids: string[], // shuffled — do not assume commissioner position
  commissioner_user_id: string, // explicit — never derived from array position
  season: number,
): Promise<void> {
  if (!member_user_ids.includes(commissioner_user_id)) {
    console.warn(
      `[seedDemoLeagueData] commissioner_user_id ${commissioner_user_id} not present in member_user_ids`
    );
  }

  const N = member_user_ids.length;
  const ROUNDS = SLOT_KEYS.length;
  const maxPicks = N * ROUNDS;

  // ── 1. Load teams, assign elimination rounds (global, shared across leagues) ──
  const { data: teams } = await supabaseAdmin
    .from('teams')
    .select('id, seed, region, is_eliminated, eliminated_in_round_stage')
    .eq('season', season)
    .order('region')
    .order('seed');

  if (!teams?.length) {
    throw new Error(`seedDemoLeagueData: no teams found for season ${season} — run seed-players-2026.ts first`);
  }

  type TeamRow = (typeof teams)[number];
  const teamsByRegionSeed = new Map<string, TeamRow[]>();
  for (const t of teams) {
    const key = `${t.region}:${t.seed}`;
    const arr = teamsByRegionSeed.get(key) ?? [];
    arr.push(t);
    teamsByRegionSeed.set(key, arr);
  }

  const playInLoserIds = new Set<string>();
  for (const [, arr] of teamsByRegionSeed) {
    if (arr.length > 1) playInLoserIds.add(arr[1].id);
  }

  const teamElimMap = new Map<string, RoundStage | null>();
  for (const t of teams) {
    const isLoser = playInLoserIds.has(t.id);
    const elimRound = getEliminationRound(t.seed, isLoser);
    teamElimMap.set(t.id, elimRound);
    if (!t.is_eliminated && elimRound) {
      await supabaseAdmin
        .from('teams')
        .update({ is_eliminated: true, eliminated_in_round_stage: elimRound })
        .eq('id', t.id);
    }
  }

  // ── 2. Load players ──
  const { data: allPlayers } = await supabaseAdmin
    .from('players')
    .select('id, name, position, avg_ppg, team_id, teams(seed, region)')
    .eq('season', season)
    .order('avg_ppg', { ascending: false });

  if (!allPlayers?.length) {
    throw new Error(`seedDemoLeagueData: no players found for season ${season} — run seed-players-2026.ts first`);
  }
  const players = allPlayers as unknown as PlayerRow[];

  const survivalScore = (teamId: string): number => {
    const elim = teamElimMap.get(teamId);
    if (elim === undefined || elim === null) return 5; // alive through e8 (seeds 1-2)
    if (elim === 'e8') return 4;
    if (elim === 's16') return 3;
    if (elim === 'r32') return 2;
    if (elim === 'r64') return 1;
    return 0; // play_in loser
  };

  const sortedPlayers = [...players].sort((a, b) => {
    const survA = survivalScore(a.team_id);
    const survB = survivalScore(b.team_id);
    if (survB !== survA) return survB - survA;
    return b.avg_ppg - a.avg_ppg;
  });

  const byPos: Record<'G' | 'F' | 'C', PlayerRow[]> = { G: [], F: [], C: [] };
  for (const p of sortedPlayers) {
    if (p.position in byPos) byPos[p.position].push(p);
  }

  // ── 3. Find or create the historical 'complete' draft session ──
  const now = Date.now();
  const startedAt = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const scheduledStart = new Date(startedAt.getTime() - 60 * 60 * 1000);
  const completedAt = new Date(startedAt.getTime() + 2 * 60 * 60 * 1000);
  const benchLockDeadline = new Date(now - 28 * 24 * 60 * 60 * 1000);

  const { data: existingSession } = await supabaseAdmin
    .from('draft_sessions')
    .select('id')
    .eq('league_id', league_id)
    .eq('status', 'complete')
    .order('created_at', { ascending: true })
    .limit(1)
    .maybeSingle();

  let historicalSessionId: string;
  const sessionFields = {
    season,
    draft_type: 'snake',
    scheduled_start: scheduledStart.toISOString(),
    started_at: startedAt.toISOString(),
    completed_at: completedAt.toISOString(),
    snake_order: member_user_ids,
    current_pick_number: maxPicks + 1,
    pick_timer_seconds: 90,
    bench_lock_deadline: benchLockDeadline.toISOString(),
  };

  if (existingSession?.id) {
    historicalSessionId = existingSession.id;
    await supabaseAdmin.from('draft_sessions').update(sessionFields).eq('id', historicalSessionId);
    await supabaseAdmin.from('draft_picks').delete().eq('draft_session_id', historicalSessionId);
  } else {
    const { data: inserted, error } = await supabaseAdmin
      .from('draft_sessions')
      .insert({ league_id, status: 'complete', ...sessionFields })
      .select('id')
      .single();
    if (error || !inserted) {
      throw new Error(`seedDemoLeagueData: failed to create historical draft session: ${error?.message}`);
    }
    historicalSessionId = inserted.id;
  }

  await supabaseAdmin.from('roster_slots').delete().eq('league_id', league_id);
  await supabaseAdmin.from('scoring_events').delete().eq('league_id', league_id);

  // ── 4. Simulate snake draft (survival-score x avg_ppg ordered pools) ──
  const usedPlayerIds = new Set<string>();
  const roster: Record<string, Partial<Record<SlotKey, string>>> = {};
  for (const userId of member_user_ids) roster[userId] = {};

  for (let round = 0; round < ROUNDS; round++) {
    const slotKey = SLOT_KEYS[round];
    const slotPos = SLOT_POSITIONS[slotKey];
    const pickOrder = round % 2 === 0 ? member_user_ids : [...member_user_ids].reverse();

    for (const userId of pickOrder) {
      const player = byPos[slotPos].find((p) => !usedPlayerIds.has(p.id));
      if (!player) {
        throw new Error(`seedDemoLeagueData: ran out of ${slotPos} players while filling slot ${slotKey}`);
      }
      roster[userId][slotKey] = player.id;
      usedPlayerIds.add(player.id);
    }
  }

  // ── 5. Force a bench-activation substitution event (item 7): a starter eliminated
  // in r64 is released, and a surviving bench player is promoted into that slot with
  // acquired_at_round_stage = 'r32'. ──
  const findUnused = (pos: 'G' | 'F' | 'C', predicate: (elim: RoundStage | null) => boolean) =>
    byPos[pos].find((p) => !usedPlayerIds.has(p.id) && predicate(teamElimMap.get(p.team_id) ?? null));

  let substitution: {
    starterPos: 'G' | 'F' | 'C';
    benchPos: 'G' | 'F' | 'C';
    eliminatedStarter: PlayerRow;
    survivingSub: PlayerRow;
  } | null = null;

  outer: for (const starterPos of ['G', 'F', 'C'] as const) {
    for (const benchPos of SUB_ELIGIBILITY_MATRIX[starterPos]) {
      const eliminatedStarter = findUnused(starterPos, (elim) => elim === 'r64');
      const survivingSub = findUnused(benchPos, (elim) => elim === null || elim === 's16' || elim === 'e8');
      if (eliminatedStarter && survivingSub && eliminatedStarter.id !== survivingSub.id) {
        substitution = { starterPos, benchPos, eliminatedStarter, survivingSub };
        break outer;
      }
    }
  }

  if (!substitution) {
    throw new Error('seedDemoLeagueData: could not find players for the required substitution event');
  }

  const subUserId = member_user_ids[0];
  const starterSlotKey = STARTER_SLOT_FOR_POS[substitution.starterPos];
  const benchSlotKey = BENCH_SLOT_FOR_POS[substitution.benchPos];
  const { eliminatedStarter, survivingSub } = substitution;

  const displacedStarterId = roster[subUserId][starterSlotKey]!;
  const displacedBenchId = roster[subUserId][benchSlotKey]!;
  usedPlayerIds.delete(displacedStarterId);
  usedPlayerIds.delete(displacedBenchId);
  usedPlayerIds.add(eliminatedStarter.id);
  usedPlayerIds.add(survivingSub.id);
  roster[subUserId][starterSlotKey] = eliminatedStarter.id;
  roster[subUserId][benchSlotKey] = survivingSub.id;

  // ── 6. draft_picks (64 rows), reflecting the post-substitution roster ──
  const draftPicksBatch: Record<string, unknown>[] = [];
  let pickNumber = 0;
  for (let round = 0; round < ROUNDS; round++) {
    const slotKey = SLOT_KEYS[round];
    const pickOrder = round % 2 === 0 ? member_user_ids : [...member_user_ids].reverse();
    for (const userId of pickOrder) {
      pickNumber++;
      draftPicksBatch.push({
        draft_session_id: historicalSessionId,
        league_id,
        pick_number: pickNumber,
        round_number: round + 1,
        user_id: userId,
        player_id: roster[userId][slotKey],
        picked_at: new Date(startedAt.getTime() + (pickNumber - 1) * 90_000).toISOString(),
        was_auto_picked: false,
      });
    }
  }
  for (let i = 0; i < draftPicksBatch.length; i += 100) {
    const { error } = await supabaseAdmin.from('draft_picks').insert(draftPicksBatch.slice(i, i + 100));
    if (error) throw new Error(`seedDemoLeagueData: failed to insert draft_picks: ${error.message}`);
  }

  // ── 7. roster_slots, with acquired_at_round_stage = 'draft' for normal picks ──
  const rosterSlotsBatch: Record<string, unknown>[] = [];
  for (const userId of member_user_ids) {
    for (const slotKey of SLOT_KEYS) {
      const playerId = roster[userId][slotKey];
      if (!playerId) continue;

      // The bench slot that fed the substitution: released at r64 in favor of the
      // promoted starter row appended below.
      if (userId === subUserId && slotKey === benchSlotKey) {
        rosterSlotsBatch.push({
          league_id, user_id: userId, player_id: playerId,
          slot_key: slotKey, slot_position: SLOT_POSITIONS[slotKey],
          is_bench: true, is_active: false,
          acquired_at_round_stage: 'draft', released_at_round_stage: 'r64',
          release_reason: 'correction',
        });
        continue;
      }

      const player = players.find((p) => p.id === playerId);
      const elimRound = player ? teamElimMap.get(player.team_id) ?? null : null;
      rosterSlotsBatch.push({
        league_id, user_id: userId, player_id: playerId,
        slot_key: slotKey, slot_position: SLOT_POSITIONS[slotKey],
        is_bench: SLOT_IS_BENCH[slotKey], is_active: !elimRound,
        acquired_at_round_stage: 'draft',
        released_at_round_stage: elimRound,
        release_reason: elimRound ? 'eliminated' : null,
      });
    }
  }

  // Promoted slot: survivingSub takes over the vacated starter slot via bench activation.
  const survivingSubElim = teamElimMap.get(survivingSub.team_id) ?? null;
  rosterSlotsBatch.push({
    league_id, user_id: subUserId, player_id: survivingSub.id,
    slot_key: starterSlotKey, slot_position: survivingSub.position,
    is_bench: false, is_active: !survivingSubElim,
    acquired_at_round_stage: 'r32',
    released_at_round_stage: survivingSubElim,
    release_reason: survivingSubElim ? 'eliminated' : null,
  });

  for (let i = 0; i < rosterSlotsBatch.length; i += 100) {
    const { error } = await supabaseAdmin.from('roster_slots').insert(rosterSlotsBatch.slice(i, i + 100));
    if (error) throw new Error(`seedDemoLeagueData: failed to insert roster_slots: ${error.message}`);
  }

  // ── 8. game_scores for play_in through e8 (player-scoped, shared across leagues) ──
  const gameScoresBatch: Record<string, unknown>[] = [];
  for (const playerId of usedPlayerIds) {
    const player = players.find((p) => p.id === playerId);
    if (!player) continue;
    const elim = teamElimMap.get(player.team_id) ?? null;
    const seed = getTeamMeta(player)?.seed ?? 8;

    for (const round of roundsPlayed(elim)) {
      gameScoresBatch.push({
        player_id: playerId,
        season,
        round_stage: round,
        round_number: 1,
        game_date: GAME_DATES[round],
        game_status: 'final',
        points: gamePoints(player.avg_ppg, seed, round),
        source: 'manual',
        synced_at: new Date().toISOString(),
      });
    }
  }

  for (let i = 0; i < gameScoresBatch.length; i += 100) {
    const { error } = await supabaseAdmin
      .from('game_scores')
      .upsert(gameScoresBatch.slice(i, i + 100), { onConflict: 'player_id,round_stage,round_number,game_date' });
    if (error) throw new Error(`seedDemoLeagueData: failed to upsert game_scores: ${error.message}`);
  }

  // ── 9. Compute scoring_events + leaderboard_snapshots ──
  // ScoreAccumulator is the only writer of scoring_events; runForLeague() always
  // performs a full recompute regardless of is_stale.
  await ScoreAccumulator.runForLeague(league_id);
}
