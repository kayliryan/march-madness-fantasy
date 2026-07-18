import type { SupabaseClient } from '@supabase/supabase-js';
import { ROUND_STAGE_ORDER } from '@/lib/constants/rounds';
import type { RoundStage } from '@/lib/constants/rounds';
import { REGION_ORDER, simulateBracketRound } from '@/lib/utils/bracketSim';

const SLOT_KEYS = ['G1', 'G2', 'F1', 'F2', 'C1', 'B1', 'B2', 'B3'] as const;
type SlotKey = (typeof SLOT_KEYS)[number];

const SLOT_POSITIONS: Record<SlotKey, 'G' | 'F' | 'C'> = {
  G1: 'G', G2: 'G', F1: 'F', F2: 'F', C1: 'C', B1: 'G', B2: 'F', B3: 'C',
};

// Step-timing logs are noisy in normal operation; gate them behind an env flag.
// The total-elapsed log at the bottom stays unconditional — it's genuinely useful
// in prod logs even without the per-step breakdown.
const DEBUG = process.env.DEMO_PROVISION_DEBUG === 'true';
function debugLog(...args: unknown[]): void {
  if (DEBUG) console.log(...args);
}

// Bracket order used to pair round-1 matchups within a region — same convention
// as src/lib/utils/bracketSim.ts (adjacent pairs meet, winners advance).
const SEED_BRACKET_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];
const BRACKET_ROUNDS: RoundStage[] = ['r64', 'r32', 's16', 'e8', 'f4', 'championship'];

type PlayerRow = {
  id: string;
  name: string;
  position: 'G' | 'F' | 'C';
  avg_ppg: number;
  team_id: string;
  teams: { seed: number; region: string } | { seed: number; region: string }[] | null;
};

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
 *
 * Round-trip shape (see debugLog groupings below): independent reads/writes are
 * batched with Promise.all wherever verified to have no data dependency on each
 * other; anything with a real dependency (e.g. scoring_events must be deleted
 * before roster_slots because of the roster_slot_id FK, or scoring_events inserts
 * needing the roster_slot ids just inserted) stays sequential.
 */
export async function seedDemoLeagueData(
  supabaseAdmin: SupabaseClient,
  league_id: string,
  member_user_ids: string[], // shuffled — do not assume commissioner position
  commissioner_user_id: string, // explicit — never derived from array position
  season: number,
): Promise<void> {
  const tStart = Date.now();

  if (!member_user_ids.includes(commissioner_user_id)) {
    console.warn(
      `[seedDemoLeagueData] commissioner_user_id ${commissioner_user_id} not present in member_user_ids`
    );
  }

  const N = member_user_ids.length;
  const ROUNDS = SLOT_KEYS.length;
  const maxPicks = N * ROUNDS;

  // ── 1. Independent reads, batched into one round-trip ──
  // teams / players / leagues.settings / the "existing historical draft session"
  // lookup are four unrelated reads: none of them consumes another's output, and
  // none of them races with a write this function performs later (the only write
  // that could plausibly race with the draft_sessions lookup is the prior-season
  // stub insert in step 11, which is explicitly sequenced after this lookup's
  // result has already been consumed — see the comment there).
  const t1 = Date.now();
  const [teamsRes, playersRes, leagueRowRes, existingSessionRes] = await Promise.all([
    supabaseAdmin
      .from('teams')
      .select('id, seed, region, is_eliminated, eliminated_in_round_stage')
      .eq('season', season)
      .order('region')
      .order('seed'),
    supabaseAdmin
      .from('players')
      .select('id, name, position, avg_ppg, team_id, teams(seed, region)')
      .eq('season', season)
      .order('avg_ppg', { ascending: false }),
    supabaseAdmin.from('leagues').select('settings').eq('id', league_id).single(),
    supabaseAdmin
      .from('draft_sessions')
      .select('id')
      .eq('league_id', league_id)
      .eq('status', 'complete')
      .order('created_at', { ascending: true })
      .limit(1)
      .maybeSingle(),
  ]);
  const { data: teams } = teamsRes;
  const { data: allPlayers } = playersRes;
  const { data: leagueRow } = leagueRowRes;
  const { data: existingSession } = existingSessionRes;
  debugLog(`[seedDemo] 1. teams+players+league+existingSession (parallel): ${Date.now() - t1}ms`);

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
  // Not awaited here — nothing later in this function re-reads the teams table, so
  // these writes are folded into the step-2 Promise.all below instead of costing
  // their own round-trip.

  if (!allPlayers?.length) {
    throw new Error(`seedDemoLeagueData: no players found for season ${season} — run seed-players-2026.ts first`);
  }
  const players = allPlayers as unknown as PlayerRow[];

  const subEligibilityMatrix = (leagueRow?.settings as { sub_eligibility_matrix?: Record<'G' | 'F' | 'C', ('G' | 'F' | 'C')[]> } | null)
    ?.sub_eligibility_matrix ?? { G: ['G', 'F'], F: ['G', 'F'], C: ['C'] };

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

  // ── 2. Find-or-create the historical 'complete' draft session ──
  // Must resolve before anything below that keys off historicalSessionId (draft_picks
  // delete/insert) or that queries draft_sessions again (the step-11 prior-season stub
  // — its own select/insert is deliberately sequenced after this branch decision so it
  // can never be mistaken for "the" complete session by the unfiltered-by-season lookup
  // above).
  const t2 = Date.now();
  const now = Date.now();
  const startedAt = new Date(now - 30 * 24 * 60 * 60 * 1000);
  const scheduledStart = new Date(startedAt.getTime() - 60 * 60 * 1000);
  const completedAt = new Date(startedAt.getTime() + 2 * 60 * 60 * 1000);
  const benchLockDeadline = new Date(now - 28 * 24 * 60 * 60 * 1000);

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
  debugLog(`[seedDemo] 2. draft_session find-or-create: ${Date.now() - t2}ms`);

  // ── 3. Cleanup deletes + team-elimination writes, batched ──
  // scoring_events.roster_slot_id references roster_slots(id) with no ON DELETE
  // cascade, so on a re-run against a league that already has data, deleting
  // roster_slots BEFORE scoring_events fails the FK check (and, since the delete's
  // error wasn't being checked, failed *silently*, leaving stale roster_slots rows
  // that then collided with the unique-active-slot-key constraint on the next
  // insert — reproduced empirically by re-running scripts/seed-demo-league.ts
  // twice against local Supabase before this fix). scoring_events must therefore
  // be deleted first. draft_picks has no such FK relationship to either table and
  // can run alongside; likewise the team-elimination updates only touch `teams`,
  // which nothing later in this function re-reads.
  const t3 = Date.now();
  await Promise.all([
    existingSession?.id
      ? supabaseAdmin.from('draft_picks').delete().eq('draft_session_id', historicalSessionId)
      : Promise.resolve(null),
    (async () => {
      const { error: seErr } = await supabaseAdmin.from('scoring_events').delete().eq('league_id', league_id);
      if (seErr) throw new Error(`seedDemoLeagueData: failed to delete scoring_events: ${seErr.message}`);
      const { error: rsErr } = await supabaseAdmin.from('roster_slots').delete().eq('league_id', league_id);
      if (rsErr) throw new Error(`seedDemoLeagueData: failed to delete roster_slots: ${rsErr.message}`);
    })(),
    ...teamUpdatePromises,
  ]);
  debugLog(`[seedDemo] 3. cleanup deletes + team elim updates (parallel): ${Date.now() - t3}ms (${teamUpdatePromises.length} team updates)`);

  const usedPlayerIds = new Set<string>();
  const roster: Record<string, Partial<Record<SlotKey, string>>> = {};
  for (const userId of member_user_ids) roster[userId] = {};

  // ── 4. Simulate snake draft (survival-score x avg_ppg ordered pools) ──
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

  // draft_picks rows (in-memory; inserted in step 5 below)
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

  // roster_slots rows — simulates real bench promotions for EVERY user, not just
  // one hardcoded example. When a starter's team is eliminated, the highest-avg_ppg
  // remaining bench player who is (a) eligible for that slot's position per this
  // league's sub_eligibility_matrix and (b) still alive past that round takes over,
  // exactly like BenchOrderService.resolveNext + RosterActivationService.activateSlot
  // would do in a real league. This can cascade (a promoted player can later be
  // replaced too) and correctly produces "no eligible sub — slot stays vacant" when
  // nobody on the bench qualifies. Previously only ONE user's roster had promotion
  // logic at all; everyone else's starters just went dead the moment they were
  // eliminated, which is what made most demo teams' scoring look broken/frozen.
  const STARTER_SLOT_KEYS: SlotKey[] = ['G1', 'G2', 'F1', 'F2', 'C1'];
  const BENCH_SLOT_KEYS: SlotKey[] = ['B1', 'B2', 'B3'];
  const playerById = new Map(players.map((p) => [p.id, p]));

  function simulateUserRoster(userId: string): SlotEntry[] {
    const rows: SlotEntry[] = [];
    const benchAvailable = new Set(
      BENCH_SLOT_KEYS.map((k) => roster[userId][k]).filter((id): id is string => !!id)
    );
    const benchPromotedAt = new Map<string, RoundStage>();

    type Vacancy = { slot_key: SlotKey; position: 'G' | 'F' | 'C'; round: RoundStage };
    const pending: Vacancy[] = [];

    for (const slotKey of STARTER_SLOT_KEYS) {
      const playerId = roster[userId][slotKey];
      if (!playerId) continue;
      const player = playerById.get(playerId);
      const elim = player ? teamElimMap.get(player.team_id) ?? null : null;
      rows.push({
        league_id, user_id: userId, player_id: playerId,
        slot_key: slotKey, slot_position: SLOT_POSITIONS[slotKey],
        is_bench: false, is_active: !elim,
        acquired_at_round_stage: 'draft',
        released_at_round_stage: elim,
        release_reason: elim ? 'eliminated' : null,
      });
      if (elim) pending.push({ slot_key: slotKey, position: SLOT_POSITIONS[slotKey], round: elim });
    }

    while (pending.length > 0) {
      pending.sort((a, b) => ROUND_STAGE_ORDER.indexOf(a.round) - ROUND_STAGE_ORDER.indexOf(b.round));
      const vac = pending.shift()!;

      const eligiblePositions = subEligibilityMatrix[vac.position] ?? [vac.position];
      const candidates = [...benchAvailable]
        .map((id) => playerById.get(id))
        .filter((p): p is PlayerRow => !!p && eligiblePositions.includes(p.position))
        .filter((p) => {
          const pElim = teamElimMap.get(p.team_id) ?? null;
          if (!pElim) return true; // never eliminated — always eligible
          return ROUND_STAGE_ORDER.indexOf(pElim) > ROUND_STAGE_ORDER.indexOf(vac.round);
        })
        .sort((a, b) => b.avg_ppg - a.avg_ppg);

      if (candidates.length === 0) continue; // no eligible sub — slot stays vacant

      const chosen = candidates[0];
      benchAvailable.delete(chosen.id);
      benchPromotedAt.set(chosen.id, vac.round);

      const chosenElim = teamElimMap.get(chosen.team_id) ?? null;
      rows.push({
        league_id, user_id: userId, player_id: chosen.id,
        slot_key: vac.slot_key, slot_position: vac.position,
        is_bench: false, is_active: !chosenElim,
        acquired_at_round_stage: vac.round,
        released_at_round_stage: chosenElim,
        release_reason: chosenElim ? 'eliminated' : null,
      });
      if (chosenElim) pending.push({ slot_key: vac.slot_key, position: vac.position, round: chosenElim });
    }

    // Bench rows: released either when promoted off the bench (release_reason
    // 'eliminated', matching activateSlot's treatment of the vacated bench row)
    // or when their own team is eliminated — whichever comes first.
    for (const slotKey of BENCH_SLOT_KEYS) {
      const playerId = roster[userId][slotKey];
      if (!playerId) continue;
      const player = playerById.get(playerId);
      const ownElim = player ? teamElimMap.get(player.team_id) ?? null : null;
      const released = benchPromotedAt.get(playerId) ?? ownElim;
      rows.push({
        league_id, user_id: userId, player_id: playerId,
        slot_key: slotKey, slot_position: player?.position ?? SLOT_POSITIONS[slotKey],
        is_bench: true, is_active: !released,
        acquired_at_round_stage: 'draft',
        released_at_round_stage: released,
        release_reason: released ? 'eliminated' : null,
      });
    }

    return rows;
  }

  const rosterSlotsBatch: SlotEntry[] = member_user_ids.flatMap((userId) => simulateUserRoster(userId));

  // Composite key of (user_id, slot_key, acquired_at_round_stage) uniquely identifies
  // each row we're about to insert (a slot_key can have more than one historical row —
  // e.g. G2's original draft pick plus the S16 promotion — but never two starting at
  // the same round stage). Used below to attach the real roster_slot_id to each
  // scoring_event instead of leaving every credited point keyed by player_id alone,
  // which is what made two different stints of the same player show identical totals.
  const slotRowKey = (s: Pick<SlotEntry, 'user_id' | 'slot_key' | 'acquired_at_round_stage'>) =>
    `${s.user_id}:${s.slot_key}:${s.acquired_at_round_stage}`;

  // Pick a surviving drafted player to mark as injured (step 6) — computed here
  // since it only needs usedPlayerIds/teamElimMap, both ready as of step 4.
  const activeDraftedPlayer = [...usedPlayerIds]
    .map((id) => players.find((p) => p.id === id))
    .find((p): p is PlayerRow => !!p && teamElimMap.get(p.team_id) === null) ?? null;

  const previousSeason = season - 1;
  const prevStartedAt = new Date(now - 395 * 24 * 60 * 60 * 1000); // ~13 months ago

  // ── 5. Independent writes/reads, batched ──
  // draft_picks insert, roster_slots insert, the injury-status update, the
  // game_scores read, and the prior-season stub select+insert touch five disjoint
  // tables (draft_picks / roster_slots / players / game_scores / draft_sessions)
  // and none of them consumes another's result — verified by tracing each one's
  // inputs above: all five only need data already resolved by step 4 (roster,
  // teamElimMap, usedPlayerIds) or step 2 (historicalSessionId, the settled
  // existingSession branch). The prior-season stub specifically only becomes safe
  // to run here (not earlier, alongside step 1's reads) because it must not race
  // with step 2's unfiltered-by-season "find the complete session" lookup.
  const t5 = Date.now();
  const rosterSlotIdByKey = new Map<string, string>();
  let allInsertedGameScores: InsertedGameScore[] = [];

  const [, , , , priorSeasonInserted] = await Promise.all([
    // draft_picks (up to 64 rows)
    (async () => {
      for (let i = 0; i < draftPicksBatch.length; i += 100) {
        const { error } = await supabaseAdmin.from('draft_picks').insert(draftPicksBatch.slice(i, i + 100));
        if (error) throw new Error(`seedDemoLeagueData: failed to insert draft_picks: ${error.message}`);
      }
    })(),
    // roster_slots (up to ~64+ rows, including promotion rows)
    (async () => {
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
    })(),
    // Mark one active drafted player as injured — shows the InjuryBadge component
    // in rosters/draft UI. Pick a surviving player so the injury makes narrative
    // sense — they're still active but hurt.
    activeDraftedPlayer
      ? supabaseAdmin.from('players').update({
          injury_status: 'out',
          injury_note: 'Ankle sprain, expected out 2–3 weeks',
          injury_updated_at: new Date().toISOString(),
        }).eq('id', activeDraftedPlayer.id)
      : Promise.resolve(null),
    // game_scores for drafted players. These are NOT generated here. For the
    // real-2026 player pool, every real player's actual per-round tournament
    // results are already sitting in game_scores (seeded once, season-wide, by
    // seed-full-2026-tournament.ts — see that script's header for why:
    // game_scores has no league_id column, it's global per season, so any league
    // drafting from this pool reads the same rows real production would have
    // written via the live ESPN sync). We just read back whichever rows belong to
    // the players this simulated draft actually picked, so scoring_events below
    // reflects what really happened in the tournament rather than a synthetic
    // formula.
    (async () => {
      const usedPlayerIdList = [...usedPlayerIds];
      const collected: InsertedGameScore[] = [];
      for (let i = 0; i < usedPlayerIdList.length; i += 100) {
        const { data, error } = await supabaseAdmin
          .from('game_scores')
          .select('id, player_id, round_stage, points')
          .eq('season', season)
          .in('player_id', usedPlayerIdList.slice(i, i + 100));
        if (error) throw new Error(`seedDemoLeagueData: failed to read game_scores: ${error.message}`);
        if (data) collected.push(...(data as InsertedGameScore[]));
      }
      allInsertedGameScores = collected;
    })(),
    // Prior-season stub — a completed draft session for `season - 1` proves
    // multi-season capability in the UI (season switcher shows "2 seasons").
    // Minimally seeded: session row only, no picks or scoring data — just enough
    // to surface the archive link in the interface.
    (async () => {
      const { data: existingStub } = await supabaseAdmin
        .from('draft_sessions')
        .select('id')
        .eq('league_id', league_id)
        .eq('season', previousSeason)
        .maybeSingle();
      if (!existingStub) {
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
        return 'inserted';
      }
      return 'exists';
    })(),
  ]);
  debugLog(
    `[seedDemo] 5. draft_picks+roster_slots+injury+game_scores+prior_season (parallel): ${Date.now() - t5}ms ` +
    `(draft_picks=${draftPicksBatch.length}, roster_slots=${rosterSlotsBatch.length}, game_scores=${allInsertedGameScores.length}, prior_season=${priorSeasonInserted})`
  );

  // ── 6. Compute scoring_events in memory, then bulk insert ──
  // Replicates ScoreAccumulator._runForGamesInternal logic: a slot credits a game score
  // when acqIdx <= gameIdx < relIdx (where -1 relIdx = never scores; null relIdx = always).
  // This replaces ~400 sequential DB round-trips with a single bulk INSERT. Must run
  // after step 5 because it needs both rosterSlotIdByKey (from the roster_slots insert)
  // and allInsertedGameScores (from the game_scores read).
  const t6 = Date.now();

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
  debugLog(`[seedDemo] 6. scoring_events (in-memory): ${Date.now() - t6}ms (${scoringEventsBatch.length} rows)`);

  // ── 7. Compute leaderboard_snapshots in memory, then bulk upsert ──
  // Must run after step 6 — needs scoringEventsBatch's totals.
  const t7 = Date.now();

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
  debugLog(`[seedDemo] 7. leaderboard_snapshots (in-memory): ${Date.now() - t7}ms`);

  console.log(`[seedDemo] TOTAL seedDemoLeagueData: ${Date.now() - tStart}ms`);
}
