/**
 * Fetch script: pulls real March 2026 NCAA tournament data from ESPN's public API
 * for the 56 players in scripts/data/real-2026-roster.ts, and writes a JSON cache
 * to scripts/data/real-2026-data.json.
 *
 * IMPORTANT — network access: this script does NOT make its own HTTP requests.
 * Earlier versions called `fetch()` directly, but Cowork's bash sandbox sits
 * behind an egress proxy that only allows a small domain allowlist and blocks
 * arbitrary third-party APIs like ESPN's (confirmed: direct `fetch()`/`curl` to
 * site.api.espn.com gets a 403 from the proxy itself, before ever reaching
 * ESPN — this is NOT ESPN rate-limiting, it's the sandbox's own network policy).
 * The `mcp__workspace__web_fetch` tool *does* have broader network access, so
 * the actual HTTP fetching has to be done by the agent calling that tool, one
 * game at a time — this script only handles bookkeeping (what's left to fetch,
 * and parsing/merging a boxscore response the agent already fetched).
 *
 * Usage:
 *   npx tsx scripts/fetch-real-2026-tournament.ts --list-remaining
 *     -> prints a JSON array of {event_id, round_stage, date, teams, url} for
 *        every game not yet in the checkpoint. No network access needed.
 *
 *   npx tsx scripts/fetch-real-2026-tournament.ts --process-one <event_id>
 *     -> reads the raw JSON text an agent already fetched via web_fetch for
 *        that event (expected at scripts/data/.tmp-boxscore.json), parses it,
 *        merges the result into the cache, marks that event_id complete in the
 *        checkpoint, and deletes the temp file. No network access needed.
 *
 * Resumable: scripts/data/real-2026-fetch-state.json tracks which of the 63
 * GAMES are already done. Every invocation of --list-remaining only shows what's
 * left, so resuming (a fresh session, a scheduled task, whatever) is automatic —
 * no coordination needed beyond "list what's left, fetch the next one, process it."
 */

import fs from 'fs';
import path from 'path';
import { TEAMS, ROSTER, GAMES, type RoundStage } from './data/real-2026-roster';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
const DATA_PATH = path.join(__dirname, 'data', 'real-2026-data.json');
const STATE_PATH = path.join(__dirname, 'data', 'real-2026-fetch-state.json');
const TMP_BOXSCORE_PATH = path.join(__dirname, 'data', '.tmp-boxscore.json');

function norm(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '') // strip accents
    .toLowerCase()
    .replace(/[‐-―-]/g, ' ') // hyphens/dashes -> space
    .replace(/[.,]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

interface BoxscoreAthlete {
  athlete: { displayName: string; id: string };
  stats: string[];
}

interface BoxscoreTeamBlock {
  team: { id: string; displayName: string };
  statistics: { labels: string[]; athletes: BoxscoreAthlete[] }[];
}

interface GameScoreEntry {
  member: string;
  slot_key: string;
  round_stage: RoundStage;
  game_date: string;
  points: number;
  event_id: string;
}

interface FetchState {
  completed_event_ids: string[];
  last_run_at: string;
  last_status: 'complete' | 'stopped_early' | 'fatal_error';
  last_stopped_reason?: string;
  runs: number;
}

interface CachedOutput {
  teams: typeof TEAMS;
  players: (typeof ROSTER[number] & { espn_player_id: string | null })[];
  game_scores: GameScoreEntry[];
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

function loadExistingCache(): CachedOutput {
  if (!fs.existsSync(DATA_PATH)) {
    return { teams: TEAMS, players: ROSTER.map((r) => ({ ...r, espn_player_id: null })), game_scores: [] };
  }
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch {
    return { teams: TEAMS, players: ROSTER.map((r) => ({ ...r, espn_player_id: null })), game_scores: [] };
  }
}

function eventUrl(eventId: string): string {
  return `${BASE}/summary?event=${eventId}`;
}

function listRemaining() {
  const state = loadState();
  const completed = new Set(state.completed_event_ids);
  const remaining = GAMES.filter((g) => !completed.has(g.event_id));

  console.log(JSON.stringify({
    done: completed.size,
    total: GAMES.length,
    remaining: remaining.map((g) => ({ ...g, url: eventUrl(g.event_id) })),
  }, null, 2));

  if (remaining.length === 0) process.exit(0); // fully complete
  process.exit(3); // "games remain" signal, distinct from the process-one exit codes
}

function processOne(eventId: string) {
  const game = GAMES.find((g) => g.event_id === eventId);
  if (!game) {
    console.error(`Unknown event_id: ${eventId} (not in GAMES list)`);
    process.exit(1);
  }
  if (!fs.existsSync(TMP_BOXSCORE_PATH)) {
    console.error(`Expected fetched boxscore JSON at ${TMP_BOXSCORE_PATH} — save the web_fetch result there first.`);
    process.exit(1);
  }

  let data: { boxscore?: { players?: BoxscoreTeamBlock[] } };
  try {
    data = JSON.parse(fs.readFileSync(TMP_BOXSCORE_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Could not parse ${TMP_BOXSCORE_PATH} as JSON: ${(err as Error).message}`);
    console.error('This usually means the fetched page was an error/HTML response, not the raw JSON API response. Stopping — not retrying.');
    process.exit(2);
  }

  const teamBlocks = data.boxscore?.players ?? [];
  const teamByKey = new Map(TEAMS.map((t) => [t.key, t]));
  const cache = loadExistingCache();
  const espnPlayerIds = new Map<string, string>();
  for (const p of cache.players) {
    if (p.espn_player_id) espnPlayerIds.set(`${p.member}|${p.slot_key}`, p.espn_player_id);
  }
  // Drop any stale rows previously recorded for this exact event_id, so
  // re-processing an event_id is idempotent.
  //
  // IMPORTANT: this must key on event_id, NOT (round_stage, date) — multiple
  // real games commonly share the same round_stage AND date (e.g. four
  // different r64 games all on 2026-03-19), so a (round_stage, date) key
  // would delete entries belonging to a *different* game on the same day
  // every time another same-day game got processed afterward, silently
  // losing data. Older entries from before this fix won't have an event_id
  // and are filtered out, so a full re-run is required after this change.
  const gameScores = cache.game_scores.filter(
    (gs) => gs.event_id !== undefined && gs.event_id !== eventId
  );

  for (const teamKey of game.teams) {
    const teamInfo = teamByKey.get(teamKey);
    if (!teamInfo) continue;

    const block = teamBlocks.find((b) => b.team.id === teamInfo.espn_id);
    if (!block) {
      console.warn(`  WARN: no boxscore block for ${teamKey} (espn_id=${teamInfo.espn_id})`);
      continue;
    }
    const statCat = block.statistics[0];
    const ptsIdx = statCat.labels.indexOf('PTS');

    const rosterEntries = ROSTER.filter((r) => r.team === teamKey);
    for (const entry of rosterEntries) {
      const targetNorm = norm(entry.player);
      const athlete = statCat.athletes.find((a) => norm(a.athlete.displayName) === targetNorm);

      let points = 0;
      if (athlete) {
        const compositeKey = `${entry.member}|${entry.slot_key}`;
        espnPlayerIds.set(compositeKey, athlete.athlete.id);
        if (athlete.stats.length > ptsIdx) {
          points = parseInt(athlete.stats[ptsIdx], 10) || 0;
        }
      } else {
        console.warn(`  WARN: no athlete match for "${entry.player}" (${teamKey}) in event ${eventId}`);
      }

      gameScores.push({
        member: entry.member,
        slot_key: entry.slot_key,
        round_stage: game.round_stage,
        game_date: game.date,
        points,
        event_id: eventId,
      });
    }
  }

  const output: CachedOutput = {
    teams: TEAMS,
    players: ROSTER.map((r) => ({
      ...r,
      espn_player_id: espnPlayerIds.get(`${r.member}|${r.slot_key}`) ?? null,
    })),
    game_scores: gameScores,
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

  fs.unlinkSync(TMP_BOXSCORE_PATH);

  console.log(`Processed event ${eventId} (${game.round_stage}). ${completed.size}/${GAMES.length} games done.`);
  process.exit(allDone ? 0 : 2);
}

const args = process.argv.slice(2);
if (args[0] === '--list-remaining') {
  listRemaining();
} else if (args[0] === '--process-one' && args[1]) {
  processOne(args[1]);
} else {
  console.error('Usage:\n  npx tsx scripts/fetch-real-2026-tournament.ts --list-remaining\n  npx tsx scripts/fetch-real-2026-tournament.ts --process-one <event_id>');
  process.exit(1);
}
