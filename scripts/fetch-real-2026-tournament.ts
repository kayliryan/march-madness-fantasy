/**
 * Fetch script: pulls real March 2026 NCAA tournament data from ESPN's public API
 * for the 56 players in scripts/data/real-2026-roster.ts, and writes a JSON cache
 * to scripts/data/real-2026-data.json.
 *
 * Usage: npx tsx scripts/fetch-real-2026-tournament.ts
 *
 * Resumable: a checkpoint file (scripts/data/real-2026-fetch-state.json) tracks
 * which of the 63 GAMES have already been successfully fetched. Every run skips
 * those and only attempts the remaining ones — so re-running (from a fresh
 * session, a scheduled task, whatever) always continues from wherever the last
 * run left off, with zero coordination needed beyond "just run this again."
 *
 * Rate-limit behavior: on the FIRST non-ok response (ESPN 429/5xx or a network
 * error), the run stops immediately — it does not retry and does not continue
 * on to the remaining games. Whatever was fetched so far this run is merged
 * into the cache and the checkpoint is updated before exiting, so no progress
 * is lost. Exit code signals the outcome to whatever's driving this:
 *   0 = all 63 games fetched (cache is complete)
 *   2 = stopped early after hitting an error (resumable — just run again later)
 *   1 = unexpected/fatal error (e.g. missing input files)
 */

import fs from 'fs';
import path from 'path';
import { TEAMS, ROSTER, GAMES, type RoundStage } from './data/real-2026-roster';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';
const DATA_PATH = path.join(__dirname, 'data', 'real-2026-data.json');
const STATE_PATH = path.join(__dirname, 'data', 'real-2026-fetch-state.json');

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

function loadExistingCache(): CachedOutput | null {
  if (!fs.existsSync(DATA_PATH)) return null;
  try {
    return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
  } catch {
    return null;
  }
}

async function fetchBoxscore(eventId: string): Promise<{ ok: true; blocks: BoxscoreTeamBlock[] } | { ok: false; status: number | null }> {
  let res: Response;
  try {
    res = await fetch(`${BASE}/summary?event=${eventId}`);
  } catch {
    return { ok: false, status: null }; // network error — treat like a rate-limit-style stop
  }
  if (!res.ok) return { ok: false, status: res.status };
  const data = await res.json();
  return { ok: true, blocks: data?.boxscore?.players ?? [] };
}

async function main() {
  const state = loadState();
  const existingCache = loadExistingCache();
  const completed = new Set(state.completed_event_ids);

  const teamByKey = new Map(TEAMS.map((t) => [t.key, t]));
  // Seed accumulators from whatever's already in the cache so a partial run's
  // results are additive, not overwritten.
  const espnPlayerIds = new Map<string, string>(); // "member|slot_key" -> espn athlete id
  const gameScores: GameScoreEntry[] = [];
  if (existingCache) {
    for (const p of existingCache.players) {
      if (p.espn_player_id) espnPlayerIds.set(`${p.member}|${p.slot_key}`, p.espn_player_id);
    }
    // Keep only game_scores for games we know we've actually completed —
    // anything else is stale/partial from a run that got cut off.
    gameScores.push(...existingCache.game_scores.filter((gs) =>
      GAMES.some((g) => completed.has(g.event_id) && g.round_stage === gs.round_stage && g.date === gs.game_date)
    ));
  }

  const remaining = GAMES.filter((g) => !completed.has(g.event_id));

  if (remaining.length === 0) {
    console.log(`All ${GAMES.length} games already fetched (see ${STATE_PATH}). Nothing to do.`);
    process.exit(0);
  }

  console.log(`Resuming: ${completed.size}/${GAMES.length} games already done, ${remaining.length} remaining.`);

  let stoppedEarly = false;
  let stopReason = '';
  let fetchedThisRun = 0;

  for (const game of remaining) {
    console.log(`Fetching ${game.round_stage} event ${game.event_id}...`);
    const result = await fetchBoxscore(game.event_id);

    if (!result.ok) {
      stoppedEarly = true;
      stopReason = result.status
        ? `HTTP ${result.status} on event ${game.event_id} (round ${game.round_stage})`
        : `network error on event ${game.event_id} (round ${game.round_stage})`;
      console.error(`STOPPING — ${stopReason}. Not retrying, not continuing to remaining games.`);
      break;
    }

    for (const teamKey of game.teams) {
      const teamInfo = teamByKey.get(teamKey);
      if (!teamInfo) continue;

      const block = result.blocks.find((b) => b.team.id === teamInfo.espn_id);
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
          console.warn(`  WARN: no athlete match for "${entry.player}" (${teamKey}) in event ${game.event_id}`);
        }

        gameScores.push({
          member: entry.member,
          slot_key: entry.slot_key,
          round_stage: game.round_stage,
          game_date: game.date,
          points,
        });
      }
    }

    completed.add(game.event_id);
    fetchedThisRun++;

    // Be polite to ESPN's API
    await new Promise((r) => setTimeout(r, 150));
  }

  // Persist cache (merged, not overwritten-from-nothing) and checkpoint every run,
  // whether we finished everything or got cut off partway through.
  const output: CachedOutput = {
    teams: TEAMS,
    players: ROSTER.map((r) => ({
      ...r,
      espn_player_id: espnPlayerIds.get(`${r.member}|${r.slot_key}`) ?? null,
    })),
    game_scores: gameScores,
  };
  fs.writeFileSync(DATA_PATH, JSON.stringify(output, null, 2));

  const newState: FetchState = {
    completed_event_ids: [...completed],
    last_run_at: new Date().toISOString(),
    last_status: stoppedEarly ? 'stopped_early' : 'complete',
    last_stopped_reason: stoppedEarly ? stopReason : undefined,
    runs: state.runs + 1,
  };
  fs.writeFileSync(STATE_PATH, JSON.stringify(newState, null, 2));

  console.log(`\nWrote ${DATA_PATH} and ${STATE_PATH}`);
  console.log(`  Fetched ${fetchedThisRun} game(s) this run. ${completed.size}/${GAMES.length} total done.`);
  console.log(`  ${output.players.filter((p) => !p.espn_player_id).length} players still missing espn_player_id`);

  if (stoppedEarly) {
    console.log(`\nSTOPPED EARLY: ${stopReason}`);
    console.log(`${GAMES.length - completed.size} game(s) remain. Re-run this script later to continue — do not retry immediately.`);
    process.exit(2);
  }

  console.log('\nCOMPLETE: all games fetched.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
