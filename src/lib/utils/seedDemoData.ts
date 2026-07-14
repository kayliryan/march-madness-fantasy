import type { SupabaseClient } from '@supabase/supabase-js';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { REGION_ORDER, simulateBracketRound } from '@/lib/utils/bracketSim';

const SLOT_KEYS = ['G1', 'G2', 'F1', 'F2', 'C1', 'B1', 'B2', 'B3'] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

const SLOT_POSITIONS: Record<SlotKey, 'G' | 'F' | 'C'> = {
  G1: 'G', G2: 'G', F1: 'F', F2: 'F', C1: 'C', B1: 'G', B2: 'F', B3: 'C',
};
const SLOT_IS_BENCH: Record<SlotKey, boolean> = {
  G1: false, G2: false, F1: false, F2: false, C1: false, B1: true, B2: true, B3: true,
};


// Bracket order used to pair round-1 matchups within a region — same convention
// as src/lib/utils/bracketSim.ts (adjacent pairs meet, winners advance).
const SEED_BRACKET_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];
const BRACKET_ROUNDS: RoundStage[] = ['r64', 'r32', 's16', 'e8', 'f4', 'championship'];

const PLAYABLE_ROUND_STAGES = ROUND_STAGE_ORDER.filter(
  (s) => s !== 'draft' && s !== 'play_in'
);

function roundsPlayed(eliminatedIn: RoundStage | null): RoundStage[] {
  if (eliminatedIn === 'play_in') return ['play_in'];
  if (!eliminatedIn) return PLAYABLE_ROUND_STAGES;
  const idx = ROUND_STAGE_ORDER.indexOf(eliminatedIn);
  return PLAYABLE_ROUND_STAGES.filter((r) => ROUND_STAGE_ORDER.indexOf(r) <= idx);
}

// Deterministic points: avg_ppg * round_multiplier with minor seed-based variance.
// These multipliers are the "fixture" calibrated in Section 14.10 — do not adjust at runtime.
const ROUND_POINT_MULTIPLIERS: Record<string, number> = {
  play_in: 0.9, r64: 1.0, r32: 1.05, s16: 1.1, e8: 1.15, f4: 1.2, championship: 1.25,
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
  f4: '2026-04-05',
  championship: '2026-04-07',
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

type SlotEntry = {
  league_id: string;
  user_id: string;
  player_id: string;
  slot_key: string;
  slot_position: 'G' | 'F' | 'C';
  is_bench: boolean;
  is_active: boolean;
  acquired_at_round_stage: string;
  released_at_round_stage: string | null;
  release_reason: string | null;
};

type InsertedGameScore = {
  id: string;
  player_id: string;
  round_stage: string;
  points: number;
};

/**
 * Seeds a fully-played-through-Elite-8 fantasy league: completed historical draft
 * (with draft_picks), roster_slots (including one bench-activation substitution),
 * game_scores for play_in–e8, scoring_events, and leaderboard_snapshots.
 * Idempotent — safe to re-run for the same league_id.
 *
 * Scoring events and leaderboard snapshots are computed in-memory from rosterSlotsBatch
 * and the returned game_score IDs, replacing ScoreAccumulator.runForLeague() (~400
 * sequential DB round-trips → 2 bulk operations).
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
  const t1 = Date.now();
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

  // Run a REAL paired single-elimination bracket (src/lib/utils/bracketSim.ts) instead
  // of a seed-tier heuristic. The old version gave every #1/#2 seed in every region a
  // free pass all the way to the championship (elim=null for any seed<=2), which meant
  // several teams simultaneously "played" a championship game that only one team can
  // ever actually reach. This produces exactly one champion, and every other team's
  // elimination round reflects an actual (simulated) loss to a specific opponent.
  const regionsPresent = [...new Set(teams.map((t) => t.region))].sort(
    (a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b)
  );
  let currentField = regionsPresent.flatMap((region) =>
    SEED_BRACKET_ORDER.map((seed) => {
      const candidates = teamsByRegionSeed.get(`${region}:${seed}`) ?? [];
      const winner = candidates.find((t) => !playInLoserIds.has(t.id)) ?? candidates[0];
      return winner ? { name: winner.id, seed, region } : null;
    }).filter((t): t is { name: string; seed: number; region: string } => t !== null)
  );

  const bracketElimRound = new Map<string, RoundStage>(); // team id -> round they lost in
  for (let i = 0; i < BRACKET_ROUNDS.length && currentField.length > 1; i++) {
    const { winners, matchups } = simulateBracketRound(currentField);
    for (const m of matchups) bracketElimRound.set(m.loser.name, BRACKET_ROUNDS[i]);
    currentField = winners;
  }
  // currentField now holds exactly one team: the champion (never eliminated).

  const teamElimMap = new Map<string, RoundStage | null>();
  const teamUpdatePromises: PromiseLike<unknown>[] = [];
  for (const t of teams) {
    const elimRound = playInLoserIds.has(t.id) ? 'play_in' : (bracketElimRound.get(t.id) ?? null);
    teamElimMap.set(t.id, elimRound);
    if (!t.is_eliminated && elimRound) {
      teamUpdatePromises.push(
        supabaseAdmin
          .from('teams')
          .update({ is_eliminated: true, eliminated_in_round_stage: elimRound })
          .eq('id', t.id)
      );
    }
  }
  if (teamUpdatePromises.length > 0) {
    await Promise.all(teamUpdatePromises);
  }
  console.log(`[seedDemo] 1. teams+elimMap: ${Date.now() - t1}ms (${teamUpdatePromises.length} parallel updates)`);

  // ── 2. Load players ──
  const t2 = Date.now();
  const { data: allPlayers } = await supabaseAdmin
    .from('players')
    .select('id, name, position, avg_ppg, team_id, teams(seed, region)')
    .eq('season', season)
    .order('avg_ppg', { ascending: false });

  if (!allPlayers?.length) {
    throw new Error(`seedDemoLeagueData: no players found for season ${season} — run seed-players-2026.ts first`);
  }
  const players = allPlayers as unknown as PlayerRow[];
  console.log(`[seedDemo] 2. players: ${Date.now() - t2}ms`);

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
  const t3 = Date.now();
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
  console.log(`[seedDemo] 3. draft_session+cleanup: ${Date.now() - t3}ms`);

  // ── 3.5. Pre-assign "no eligible C sub" edge case for last member ──
  // Member[N-1] receives two eliminated-in-r64 C players for C1 (starter) and B3 (bench).
  // When their C1 player is eliminated, BenchOrderService.resolveNext() finds no eligible
  // C bench sub (the only other C — B3 — is also eliminated) and returns null, exercising
  // the documented "no eligible sub" code path in BenchOrderService (Section 5.4 algorithm).
  const usedPlayerIds = new Set<string>();
  const roster: Record<string, Partial<Record<SlotKey, string>>> = {};
  for (const userId of member_user_ids) roster[userId] = {};

  const noSubUserId = member_user_ids[N - 1];
  const eliminatedCPool = byPos['C'].filter(
    (p) => teamElimMap.get(p.team_id) === 'r64',
  );
  if (eliminatedCPool.length < 2) {
    throw new Error('seedDemoLeagueData: not enough r64-eliminated C players for no-sub edge case');
  }
  const noSubC1Player = eliminatedCPool[0];
  const noSubB3Player = eliminatedCPool[1];
  roster[noSubUserId]['C1'] = noSubC1Player.id;
  roster[noSubUserId]['B3'] = noSubB3Player.id;
  usedPlayerIds.add(noSubC1Player.id);
  usedPlayerIds.add(noSubB3Player.id);

  // ── 3.6. Pre-assign bench-activation G2 for the top-ranked user ──
  // G2's team MUST be eliminated in R32 so the bench activation slot (added post-draft)
  // can share slot_key='G2' without violating the partial unique index (the normal G2
  // row will have released_at_round_stage='r32', the promoted row will have it NULL —
  // each covered by the unique constraint independently).
  const subUserId = member_user_ids[0];
  const eliminatedG2 = byPos['G'].find(
    (p) => !usedPlayerIds.has(p.id) && teamElimMap.get(p.team_id) === 'r32',
  );
  if (!eliminatedG2) {
    throw new Error('seedDemoLeagueData: could not find r32-eliminated G player for G2 pre-assignment');
  }
  roster[subUserId]['G2'] = eliminatedG2.id;
  usedPlayerIds.add(eliminatedG2.id);

  // ── 4. Simulate snake draft (survival-score x avg_ppg ordered pools) ──
  for (let round = 0; round < ROUNDS; round++) {
    const slotKey = SLOT_KEYS[round];
    const slotPos = SLOT_POSITIONS[slotKey];
    const pickOrder = round % 2 === 0 ? member_user_ids : [...member_user_ids].reverse();

    for (const userId of pickOrder) {
      if (roster[userId][slotKey] !== undefined) continue; // pre-assigned slot
      const player = byPos[slotPos].find((p) => !usedPlayerIds.has(p.id));
      if (!player) {
        throw new Error(`seedDemoLeagueData: ran out of ${slotPos} players while filling slot ${slotKey}`);
      }
      roster[userId][slotKey] = player.id;
      usedPlayerIds.add(player.id);
    }
  }

  // ── 5. Force bench-activation for the top-ranked user: G2's team naturally eliminates
  // in R32 (seeds 5-8 → r32). A deep-running G player (Final Four or better, unused)
  // replaces the normal B1 pick, then activates into the G2 slot from S16. This adds
  // bonus scoring on top of user 0's full normal roster, giving them a strong shot at
  // rank #1 without requiring the literal eventual champion (that pool is just one team
  // now that eliminations come from a real bracket sim, not a seed-tier heuristic). ──
  const findUnused = (pos: 'G' | 'F' | 'C', predicate: (elim: RoundStage | null) => boolean) =>
    byPos[pos].find((p) => !usedPlayerIds.has(p.id) && predicate(teamElimMap.get(p.team_id) ?? null));

  const survivingSub = findUnused('G', (elim) => elim === null || elim === 'f4');
  if (!survivingSub) {
    throw new Error('seedDemoLeagueData: could not find a deep-running G player for bench activation');
  }

  const displacedBenchId = roster[subUserId]['B1']!;
  usedPlayerIds.delete(displacedBenchId);
  usedPlayerIds.add(survivingSub.id);
  roster[subUserId]['B1'] = survivingSub.id;

  // ── 6. draft_picks (64 rows), reflecting the post-substitution roster ──
  const t6 = Date.now();
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
  console.log(`[seedDemo] 6. draft_picks: ${Date.now() - t6}ms (${draftPicksBatch.length} rows)`);

  // ── 7. roster_slots, with acquired_at_round_stage = 'draft' for normal picks ──
  const t7 = Date.now();
  const rosterSlotsBatch: SlotEntry[] = [];
  for (const userId of member_user_ids) {
    for (const slotKey of SLOT_KEYS) {
      const playerId = roster[userId][slotKey];
      if (!playerId) continue;

      // B1 bench slot for the top-ranked user: released at r32 when G2's team is
      // eliminated, triggering promotion of the survivingSub into G2's slot from S16.
      if (userId === subUserId && slotKey === 'B1') {
        rosterSlotsBatch.push({
          league_id, user_id: userId, player_id: playerId,
          slot_key: slotKey, slot_position: SLOT_POSITIONS[slotKey],
          is_bench: true, is_active: false,
          acquired_at_round_stage: 'draft', released_at_round_stage: 'r32',
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

  // Promoted slot: survivingSub fills G2's slot from S16 after G2's team's R32 elimination.
  const survivingSubElim = teamElimMap.get(survivingSub.team_id) ?? null;
  rosterSlotsBatch.push({
    league_id, user_id: subUserId, player_id: survivingSub.id,
    slot_key: 'G2', slot_position: 'G',
    is_bench: false, is_active: !survivingSubElim,
    acquired_at_round_stage: 's16',
    released_at_round_stage: survivingSubElim,
    release_reason: survivingSubElim ? 'eliminated' : null,
  });

  // Composite key of (user_id, slot_key, acquired_at_round_stage) uniquely identifies
  // each row we're about to insert (a slot_key can have more than one historical row —
  // e.g. G2's original draft pick plus the S16 promotion — but never two starting at
  // the same round stage). Used below to attach the real roster_slot_id to each
  // scoring_event instead of leaving every credited point keyed by player_id alone,
  // which is what made two different stints of the same player show identical totals.
  const slotRowKey = (s: Pick<SlotEntry, 'user_id' | 'slot_key' | 'acquired_at_round_stage'>) =>
    `${s.user_id}:${s.slot_key}:${s.acquired_at_round_stage}`;
  const rosterSlotIdByKey = new Map<string, string>();

  for (let i = 0; i < rosterSlotsBatch.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from('roster_slots')
      .insert(rosterSlotsBatch.slice(i, i + 100))
      .select('id, user_id, slot_key, acquired_at_round_stage');
    if (error) throw new Error(`seedDemoLeagueData: failed to insert roster_slots: ${error.message}`);
    for (const row of (data ?? [])) {
      rosterSlotIdByKey.set(slotRowKey(row), row.id);
    }
  }
  console.log(`[seedDemo] 7. roster_slots: ${Date.now() - t7}ms (${rosterSlotsBatch.length} rows)`);

  // ── 7.5. Mark one active player as injured ──
  // Shows the InjuryBadge component in rosters/draft UI, demonstrating the injury
  // tracking feature. Pick a surviving player (not eliminated, not the promoted sub)
  // so the injury makes narrative sense — they're still active but hurt.
  const activeDraftedPlayer = [...usedPlayerIds]
    .map((id) => players.find((p) => p.id === id))
    .find((p): p is PlayerRow =>
      !!p &&
      teamElimMap.get(p.team_id) === null &&
      p.id !== survivingSub.id
    ) ?? null;
  if (activeDraftedPlayer) {
    await supabaseAdmin.from('players').update({
      injury_status: 'out',
      injury_note: 'Ankle sprain, expected out 2–3 weeks',
      injury_updated_at: new Date().toISOString(),
    }).eq('id', activeDraftedPlayer.id);
  }

  // ── 8. game_scores for full tournament play_in through championship (player-scoped) ──
  // Returns IDs needed to link scoring_events below — avoids a second SELECT round-trip.
  const t8 = Date.now();
  const gameScoresInput: Record<string, unknown>[] = [];
  for (const playerId of usedPlayerIds) {
    const player = players.find((p) => p.id === playerId);
    if (!player) continue;
    const elim = teamElimMap.get(player.team_id) ?? null;
    const seed = getTeamMeta(player)?.seed ?? 8;

    for (const round of roundsPlayed(elim)) {
      gameScoresInput.push({
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

  const allInsertedGameScores: InsertedGameScore[] = [];
  for (let i = 0; i < gameScoresInput.length; i += 100) {
    const { data, error } = await supabaseAdmin
      .from('game_scores')
      .upsert(gameScoresInput.slice(i, i + 100), { onConflict: 'player_id,round_stage,round_number,game_date' })
      .select('id, player_id, round_stage, points');
    if (error) throw new Error(`seedDemoLeagueData: failed to upsert game_scores: ${error.message}`);
    if (data) allInsertedGameScores.push(...(data as InsertedGameScore[]));
  }
  console.log(`[seedDemo] 8. game_scores: ${Date.now() - t8}ms (${allInsertedGameScores.length} rows)`);

  // ── 9. Compute scoring_events in memory, then bulk insert ──
  // Replicates ScoreAccumulator._runForGamesInternal logic: a slot credits a game score
  // when acqIdx <= gameIdx < relIdx (where -1 relIdx = never scores; null relIdx = always).
  // This replaces ~400 sequential DB round-trips with a single bulk INSERT.
  const t9 = Date.now();

  const gameScoresByPlayer = new Map<string, InsertedGameScore[]>();
  for (const gs of allInsertedGameScores) {
    const arr = gameScoresByPlayer.get(gs.player_id) ?? [];
    arr.push(gs);
    gameScoresByPlayer.set(gs.player_id, arr);
  }

  type ScoringEventEntry = {
    league_id: string;
    user_id: string;
    player_id: string;
    game_score_id: string;
    round_stage: string;
    points_credited: number;
    roster_slot_id: string | null;
    is_stale: boolean;
  };
  const scoringEventsBatch: ScoringEventEntry[] = [];

  for (const slot of rosterSlotsBatch) {
    if (slot.is_bench) continue; // bench players don't score until promoted to a starter slot
    const playerGames = gameScoresByPlayer.get(slot.player_id) ?? [];
    if (!playerGames.length) continue;

    // Which specific roster_slot row this credit belongs to — critical when the same
    // player has more than one row (e.g. a bench stint plus a later promoted starter
    // stint): without this, both rows would show the exact same combined total instead
    // of each stint's own points.
    const roster_slot_id = rosterSlotIdByKey.get(slotRowKey(slot)) ?? null;

    const acqIdx = ROUND_STAGE_ORDER.indexOf(slot.acquired_at_round_stage as RoundStage);
    if (acqIdx === -1) continue;

    let relIdx: number;
    if (!slot.released_at_round_stage) {
      relIdx = ROUND_STAGE_ORDER.length;
    } else {
      const raw = ROUND_STAGE_ORDER.indexOf(slot.released_at_round_stage as RoundStage);
      relIdx = raw === -1 ? 0 : raw;
    }

    for (const gs of playerGames) {
      const gameIdx = ROUND_STAGE_ORDER.indexOf(gs.round_stage as RoundStage);
      if (gameIdx === -1) continue;
      if (!(acqIdx <= gameIdx && gameIdx < relIdx)) continue;

      scoringEventsBatch.push({
        league_id,
        user_id: slot.user_id,
        player_id: slot.player_id,
        game_score_id: gs.id,
        round_stage: gs.round_stage,
        roster_slot_id,
        points_credited: gs.points,
        is_stale: false,
      });
    }
  }

  for (let i = 0; i < scoringEventsBatch.length; i += 100) {
    const { error } = await supabaseAdmin
      .from('scoring_events')
      .insert(scoringEventsBatch.slice(i, i + 100));
    if (error) throw new Error(`seedDemoLeagueData: failed to insert scoring_events: ${error.message}`);
  }
  console.log(`[seedDemo] 9. scoring_events (in-memory): ${Date.now() - t9}ms (${scoringEventsBatch.length} rows)`);

  // ── 10. Compute leaderboard_snapshots in memory, then bulk upsert ──
  const t10 = Date.now();

  type UserTotals = { total: number; highestSingle: number; maxStageIdx: number };
  const userTotals = new Map<string, UserTotals>();
  for (const userId of member_user_ids) {
    userTotals.set(userId, { total: 0, highestSingle: 0, maxStageIdx: -1 });
  }
  for (const evt of scoringEventsBatch) {
    const cur = userTotals.get(evt.user_id);
    if (!cur) continue;
    cur.total += evt.points_credited;
    if (evt.points_credited > cur.highestSingle) cur.highestSingle = evt.points_credited;
    const stageIdx = ROUND_STAGE_ORDER.indexOf(evt.round_stage as RoundStage);
    if (stageIdx > cur.maxStageIdx) cur.maxStageIdx = stageIdx;
  }

  const userActiveCount = new Map<string, number>();
  for (const slot of rosterSlotsBatch) {
    if (slot.is_active && !slot.released_at_round_stage) {
      userActiveCount.set(slot.user_id, (userActiveCount.get(slot.user_id) ?? 0) + 1);
    }
  }

  // Engineer a demonstrable tie between two members: find the two lowest-scoring
  // members and set the second-lowest's total_points to match the lowest.
  // The scoring_events sum won't match exactly (they're one render pass apart), but
  // the leaderboard snapshot is the authoritative source for the standings UI.
  const sortedByTotal = [...member_user_ids].sort(
    (a, b) => (userTotals.get(a)?.total ?? 0) - (userTotals.get(b)?.total ?? 0),
  );
  const tieTargetUserId = sortedByTotal[0]; // lowest scorer
  const tieDownUserId = N >= 2 ? sortedByTotal[1] : null; // second-lowest, tied DOWN
  const tiePoints = userTotals.get(tieTargetUserId)?.total ?? 0;

  const snapshotBatch = member_user_ids.map((userId) => {
    const data = userTotals.get(userId) ?? { total: 0, highestSingle: 0, maxStageIdx: -1 };
    const round_stage =
      data.maxStageIdx >= 0 ? (ROUND_STAGE_ORDER[data.maxStageIdx] ?? 'draft') : 'draft';
    const total_points = userId === tieDownUserId ? tiePoints : data.total;
    return {
      league_id,
      user_id: userId,
      total_points,
      active_player_count: userActiveCount.get(userId) ?? 0,
      highest_single_game_points: data.highestSingle,
      round_stage,
      last_computed_at: new Date().toISOString(),
    };
  });

  const { error: snapshotErr } = await supabaseAdmin
    .from('leaderboard_snapshots')
    .upsert(snapshotBatch, { onConflict: 'league_id,user_id' });
  if (snapshotErr) {
    throw new Error(`seedDemoLeagueData: failed to upsert leaderboard_snapshots: ${snapshotErr.message}`);
  }
  console.log(`[seedDemo] 10. leaderboard_snapshots (in-memory): ${Date.now() - t10}ms`);

  // ── 11. Second season stub ──
  // A prior-season completed draft session proves multi-season capability in the UI
  // (season switcher shows "2 seasons"). Minimally seeded: session row only, no picks
  // or scoring data — just enough to surface the archive link in the interface.
  const previousSeason = season - 1;
  const { data: existingStub } = await supabaseAdmin
    .from('draft_sessions')
    .select('id')
    .eq('league_id', league_id)
    .eq('season', previousSeason)
    .maybeSingle();
  if (!existingStub) {
    const prevStartedAt = new Date(now - 395 * 24 * 60 * 60 * 1000); // ~13 months ago
    await supabaseAdmin.from('draft_sessions').insert({
      league_id,
      season: previousSeason,
      status: 'complete',
      draft_type: 'snake',
      scheduled_start: new Date(prevStartedAt.getTime() - 60 * 60 * 1000).toISOString(),
      started_at: prevStartedAt.toISOString(),
      completed_at: new Date(prevStartedAt.getTime() + 2 * 60 * 60 * 1000).toISOString(),
      snake_order: member_user_ids,
      current_pick_number: maxPicks + 1,
      pick_timer_seconds: 90,
      bench_lock_deadline: new Date(prevStartedAt.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
    });
  }
  console.log(`[seedDemo] 11. second season stub (${previousSeason}): ${existingStub ? 'exists' : 'inserted'}`);
}
