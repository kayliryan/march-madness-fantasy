/**
 * Fetch script: pulls COMPLETE real 2026 NCAA tournament data — every team and
 * every player that appears in any of the 54 known real games, not just the
 * ~56 players the user's family league happened to draft.
 *
 * This reuses the exact same 54 games/event_ids as `real-2026-roster.ts` GAMES
 * (confirmed via direct ESPN scoreboard queries across multiple tournament
 * dates that these 54 games ARE the complete real bracket in this data source
 * — there is no larger, undiscovered set of games). What's missing is width:
 * each game's box score has TWO teams' full lineups, but the family-scoped
 * pipeline (`fetch-real-2026-tournament.ts`) only ever kept the side someone
 * drafted from. This script keeps everyone.
 *
 * Same non-networking design as the family-league script, for the same reason
 * (Cowork's bash sandbox can't reach ESPN — see that script's header for
 * details). Two modes:
 *
 *   npx tsx scripts/fetch-full-2026-tournament.ts --list-remaining
 *     -> {done, total, remaining: [{event_id, round_stage, date}, ...]}
 *
 *   npx tsx scripts/fetch-full-2026-tournament.ts --process-one <event_id>
 *     -> reads scripts/data/.tmp-full-boxscore.json (an agent must fetch the
 *        game's ESPN summary and save {boxscore:{players:[{team:{id,displayName},
 *        statistics:[{labels,athletes:[{athlete:{id,displayName},stats}]}]}, ...]}}
 *        there first — BOTH team blocks, with EVERY athlete who has a non-empty
 *        stats array, not a filtered subset). Auto-registers any new team/player
 *        by ESPN id the first time it's seen, records one game-stat row per
 *        athlete, updates the checkpoint, deletes the temp file.
 *
 * Resumable via scripts/data/full-2026-fetch-state.json, same stop-on-error
 * contract as the family-league script: never retry, never skip ahead.
 */

import fs from 'fs';
import path from 'path';
import { GAMES, type RoundStage } from './data/real-2026-roster';

const DATA_PATH = path.join(__dirname, 'data', 'full-2026-tournament-data.json');
const STATE_PATH = path.join(__dirname, 'data', 'full-2026-fetch-state.json');
const TMP_PATH = path.join(__dirname, 'data', '.tmp-full-boxscore.json');

interface FetchState {
  completed_event_ids: string[];
  last_run_at: string;
  last_status: 'complete' | 'stopped_early' | 'fatal_error';
  last_stopped_reason?: string;
  runs: number;
}

interface TeamRecord {
  espn_team_id: string;
  name: string;
}

interface PlayerRecord {
  espn_player_id: string;
  name: string;
  espn_team_id: string;
}

interface GameStatEntry {
  espn_player_id: string;
  espn_team_id: string;
  event_id: string;
  round_stage: RoundStage;
  game_date: string;
  points: number;
}

interface FullData {
  teams: TeamRecord[];
  players: PlayerRecord[];
  game_stats: GameStatEntry[];
}

interface BoxscoreAthlete {
  athlete: { displayName: string; id: string };
  stats: string[];
}
interface BoxscoreTeamBlock {
  team: { id: string; displayName: string };
  statistics: { labels: string[]; athletes: BoxscoreAthlete[] }[];
}

function loadState(): FetchState {
  if (!fs.existsSync(STATE_PATH)) {
    return { completed_event_ids: [], last_run_at: '', last_status: 'stopped_early', runs: 0 };
  }
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { completed_event_ids: [], last_run_at: '', last_status: 'stopped_early', runs: 0 };
  }
}

function saveState(state: FetchState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function loadData(): FullData {
  if (!fs.existsSync(DATA_PATH)) {
    return { teams: [], players: [], game_stats: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch {
    return { teams: [], players: [], game_stats: [] };
  }
}

function listRemaining() {
  const state = loadState();
  const completed = new Set(state.completed_event_ids);
  const remaining = GAMES.filter((g) => !completed.has(g.event_id));
  console.log(JSON.stringify({
    done: completed.size,
    total: GAMES.length,
    remaining: remaining.map((g) => ({
      event_id: g.event_id,
      round_stage: g.round_stage,
      date: g.date,
      url: `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${g.event_id}`,
    })),
  }, null, 2));
  if (remaining.length === 0) process.exit(0);
  process.exit(3);
}

function processOne(eventId: string) {
  const game = GAMES.find((g) => g.event_id === eventId);
  if (!game) {
    console.error(`Unknown event_id: ${eventId} (not in GAMES list)`);
    process.exit(1);
  }
  if (!fs.existsSync(TMP_PATH)) {
    console.error(`Expected fetched boxscore JSON at ${TMP_PATH} — save the web_fetch result there first.`);
    process.exit(1);
  }

  let raw: { boxscore?: { players?: BoxscoreTeamBlock[] } };
  try {
    raw = JSON.parse(fs.readFileSync(TMP_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Could not parse ${TMP_PATH} as JSON: ${(err as Error).message}`);
    console.error('Stopping — not retrying.');
    process.exit(2);
  }

  const teamBlocks = raw.boxscore?.players ?? [];
  if (teamBlocks.length === 0) {
    console.error('No boxscore.players[] found in the temp file — nothing to process. Stopping.');
    process.exit(1);
  }

  const data = loadData();
  const teamById = new Map(data.teams.map((t) => [t.espn_team_id, t]));
  const playerById = new Map(data.players.map((p) => [p.espn_player_id, p]));

  // Idempotent: drop any prior stats recorded for this exact event_id before
  // re-adding, so re-processing an event_id (or fixing a mistake) is safe.
  const gameStats = data.game_stats.filter((gs) => gs.event_id !== eventId);

  let playersRecorded = 0;
  for (const block of teamBlocks) {
    const teamId = block.team?.id;
    if (!teamId) continue;
    if (!teamById.has(teamId)) {
      const rec: TeamRecord = { espn_team_id: teamId, name: block.team.displayName ?? `Team ${teamId}` };
      teamById.set(teamId, rec);
    }

    const statCat = block.statistics?.[0];
    if (!statCat) continue;
    const ptsIdx = statCat.labels.indexOf('PTS');
    if (ptsIdx === -1) {
      console.warn(`  WARN: no PTS label found for team ${teamId} in event ${eventId}, skipping this team's players.`);
      continue;
    }

    for (const a of statCat.athletes ?? []) {
      if (!a.stats || a.stats.length === 0) continue; // didNotPlay / no stats recorded
      const playerId = a.athlete.id;
      if (!playerById.has(playerId)) {
        playerById.set(playerId, { espn_player_id: playerId, name: a.athlete.displayName, espn_team_id: teamId });
      }
      const points = a.stats.length > ptsIdx ? parseInt(a.stats[ptsIdx], 10) || 0 : 0;
      gameStats.push({
        espn_player_id: playerId,
        espn_team_id: teamId,
        event_id: eventId,
        round_stage: game.round_stage,
        game_date: game.date,
        points,
      });
      playersRecorded++;
    }
  }

  const output: FullData = {
    teams: [...teamById.values()],
    players: [...playerById.values()],
    game_stats: gameStats,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));

  const state = loadState();
  const completed = new Set(state.completed_event_ids);
  completed.add(eventId);
  const allDone = completed.size === GAMES.length;
  saveState({
    completed_event_ids: [...completed],
    last_run_at: new Date().toISOString(),
    last_status: allDone ? 'complete' : 'stopped_early',
    runs: state.runs + 1,
  });

  fs.unlinkSync(TMP_PATH);

  console.log(`Processed event ${eventId} (${game.round_stage}): ${playersRecorded} players recorded across ${teamBlocks.length} team(s). ${completed.size}/${GAMES.length} games done. Teams known so far: ${teamById.size}. Players known so far: ${playerById.size}.`);
  process.exit(allDone ? 0 : 2);
}

const args = process.argv.slice(2);
if (args[0] === '--list-remaining') {
  listRemaining();
} else if (args[0] === '--process-one' && args[1]) {
  processOne(args[1]);
} else {
  console.error('Usage:\n  npx tsx scripts/fetch-full-2026-tournament.ts --list-remaining\n  npx tsx scripts/fetch-full-2026-tournament.ts --process-one <event_id>');
  process.exit(1);
}
