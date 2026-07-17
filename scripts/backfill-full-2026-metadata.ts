/**
 * Backfill script: adds the fields `fetch-full-2026-tournament.ts` didn't
 * capture the first time around — player `position` (G/F/C) and team
 * `seed`/`region` — onto scripts/data/full-2026-tournament-data.json in place.
 *
 * Same no-networking-of-its-own design as the other fetch scripts (the
 * sandbox bash tool can't reach ESPN). Two independent backfill tracks,
 * each separately resumable:
 *
 *   Positions (one ESPN team-season-roster call per team, ~55 total):
 *     --list-remaining-positions
 *       -> {done, total, remaining: [{espn_team_id, name, url}, ...]}
 *     --process-team-positions <espn_team_id>
 *       -> reads scripts/data/.tmp-team-roster.json, expected shape:
 *          {"positions": [{"espn_player_id": "...", "position": "G"|"F"|"C"}, ...]}
 *          (only players ESPN actually returns a position for; anyone not
 *          listed keeps position unset and gets flagged at the end).
 *          Merges into players[] matching that team_id, deletes the temp file.
 *
 *   Seed/region (one ESPN scoreboard call per tournament date, 12 total):
 *     --list-remaining-dates
 *       -> {done, total, remaining: [{date, url}, ...]} (url has no groups
 *          filter — that param made no measurable difference when tested)
 *     --process-date-seed-region <date>
 *       -> reads scripts/data/.tmp-date-seeds.json, expected shape:
 *          [{"espn_team_id": "...", "seed": 1, "region": "East"}, ...]
 *          (one entry per team appearing in a game that day; region comes
 *          from each game's `notes[].headline`, seed from `curatedRank.current`
 *          per competitor). Merges into teams[], deletes the temp file.
 *
 *   --status
 *     -> prints how many teams still lack seed/region, how many players
 *        still lack position, for a final completeness check.
 */

import fs from 'fs';
import path from 'path';
import { GAMES } from './data/real-2026-roster';

const DATA_PATH = path.join(__dirname, 'data', 'full-2026-tournament-data.json');
const POS_STATE_PATH = path.join(__dirname, 'data', 'full-2026-position-state.json');
const SEED_STATE_PATH = path.join(__dirname, 'data', 'full-2026-seedregion-state.json');
const TMP_ROSTER_PATH = path.join(__dirname, 'data', '.tmp-team-roster.json');
const TMP_SEEDS_PATH = path.join(__dirname, 'data', '.tmp-date-seeds.json');

interface TeamRecord {
  espn_team_id: string;
  name: string;
  seed?: number;
  region?: string;
}
interface PlayerRecord {
  espn_player_id: string;
  name: string;
  espn_team_id: string;
  position?: 'G' | 'F' | 'C';
}
interface FullData {
  teams: TeamRecord[];
  players: PlayerRecord[];
  game_stats: unknown[];
}

function loadData(): FullData {
  return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
}
function saveData(d: FullData) {
  fs.writeFileSync(DATA_PATH, JSON.stringify(d, null, 2));
}

interface SimpleState {
  completed: string[];
}
function loadState(p: string): SimpleState {
  if (!fs.existsSync(p)) return { completed: [] };
  try {
    return JSON.parse(fs.readFileSync(p, 'utf-8'));
  } catch {
    return { completed: [] };
  }
}
function saveState(p: string, s: SimpleState) {
  fs.writeFileSync(p, JSON.stringify(s, null, 2));
}

function listRemainingPositions() {
  const data = loadData();
  const state = loadState(POS_STATE_PATH);
  const done = new Set(state.completed);
  const remaining = data.teams.filter((t) => !done.has(t.espn_team_id));
  console.log(JSON.stringify({
    done: done.size,
    total: data.teams.length,
    remaining: remaining.map((t) => ({
      espn_team_id: t.espn_team_id,
      name: t.name,
      url: `https://sports.core.api.espn.com/v2/sports/basketball/leagues/mens-college-basketball/seasons/2026/teams/${t.espn_team_id}/roster`,
    })),
  }, null, 2));
  process.exit(remaining.length === 0 ? 0 : 3);
}

function processTeamPositions(teamId: string) {
  const data = loadData();
  const team = data.teams.find((t) => t.espn_team_id === teamId);
  if (!team) {
    console.error(`Unknown espn_team_id: ${teamId}`);
    process.exit(1);
  }
  if (!fs.existsSync(TMP_ROSTER_PATH)) {
    console.error(`Expected ${TMP_ROSTER_PATH} — save the roster fetch result there first.`);
    process.exit(1);
  }
  let parsed: { positions?: { espn_player_id: string; position: string }[] };
  try {
    parsed = JSON.parse(fs.readFileSync(TMP_ROSTER_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Could not parse ${TMP_ROSTER_PATH}: ${(err as Error).message}`);
    process.exit(2);
  }
  const positions = parsed.positions ?? [];
  const posByPlayer = new Map(positions.map((p) => [p.espn_player_id, p.position]));

  let updated = 0;
  for (const p of data.players) {
    if (p.espn_team_id !== teamId) continue;
    const pos = posByPlayer.get(p.espn_player_id);
    if (pos === 'G' || pos === 'F' || pos === 'C') {
      p.position = pos;
      updated++;
    }
  }
  saveData(data);

  const state = loadState(POS_STATE_PATH);
  const completed = new Set(state.completed);
  completed.add(teamId);
  saveState(POS_STATE_PATH, { completed: [...completed] });
  fs.unlinkSync(TMP_ROSTER_PATH);

  const allDone = completed.size === data.teams.length;
  console.log(`Processed positions for ${team.name}: ${updated} players updated. ${completed.size}/${data.teams.length} teams done.`);
  process.exit(allDone ? 0 : 2);
}

function listRemainingDates() {
  const dates = [...new Set(GAMES.map((g) => g.date))].sort();
  const state = loadState(SEED_STATE_PATH);
  const done = new Set(state.completed);
  const remaining = dates.filter((d) => !done.has(d));
  console.log(JSON.stringify({
    done: done.size,
    total: dates.length,
    remaining: remaining.map((d) => ({
      date: d,
      url: `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/scoreboard?dates=${d.replace(/-/g, '')}&limit=300`,
    })),
  }, null, 2));
  process.exit(remaining.length === 0 ? 0 : 3);
}

function processDateSeedRegion(date: string) {
  const dates = new Set(GAMES.map((g) => g.date));
  if (!dates.has(date)) {
    console.error(`Unknown tournament date: ${date}`);
    process.exit(1);
  }
  if (!fs.existsSync(TMP_SEEDS_PATH)) {
    console.error(`Expected ${TMP_SEEDS_PATH} — save the scoreboard extraction result there first.`);
    process.exit(1);
  }
  let entries: { espn_team_id: string; seed: number; region: string }[];
  try {
    entries = JSON.parse(fs.readFileSync(TMP_SEEDS_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Could not parse ${TMP_SEEDS_PATH}: ${(err as Error).message}`);
    process.exit(2);
  }

  const data = loadData();
  const teamById = new Map(data.teams.map((t) => [t.espn_team_id, t]));
  let updated = 0;
  for (const e of entries) {
    const t = teamById.get(e.espn_team_id);
    if (!t) continue; // team not in our 55 (shouldn't happen, but don't fail loudly)
    t.seed = e.seed;
    t.region = e.region;
    updated++;
  }
  saveData(data);

  const state = loadState(SEED_STATE_PATH);
  const completed = new Set(state.completed);
  completed.add(date);
  saveState(SEED_STATE_PATH, { completed: [...completed] });
  fs.unlinkSync(TMP_SEEDS_PATH);

  const totalDates = new Set(GAMES.map((g) => g.date)).size;
  const allDone = completed.size === totalDates;
  console.log(`Processed seed/region for ${date}: ${updated} teams updated. ${completed.size}/${totalDates} dates done.`);
  process.exit(allDone ? 0 : 2);
}

function status() {
  const data = loadData();
  const noSeedRegion = data.teams.filter((t) => t.seed === undefined || !t.region);
  const noPosition = data.players.filter((p) => !p.position);
  console.log(JSON.stringify({
    total_teams: data.teams.length,
    teams_missing_seed_or_region: noSeedRegion.length,
    teams_missing_list: noSeedRegion.map((t) => ({ id: t.espn_team_id, name: t.name })),
    total_players: data.players.length,
    players_missing_position: noPosition.length,
    players_missing_list: noPosition.slice(0, 20).map((p) => ({ id: p.espn_player_id, name: p.name })),
  }, null, 2));
}

const args = process.argv.slice(2);
if (args[0] === '--list-remaining-positions') listRemainingPositions();
else if (args[0] === '--process-team-positions' && args[1]) processTeamPositions(args[1]);
else if (args[0] === '--list-remaining-dates') listRemainingDates();
else if (args[0] === '--process-date-seed-region' && args[1]) processDateSeedRegion(args[1]);
else if (args[0] === '--status') status();
else {
  console.error(`Usage:
  npx tsx scripts/backfill-full-2026-metadata.ts --list-remaining-positions
  npx tsx scripts/backfill-full-2026-metadata.ts --process-team-positions <espn_team_id>
  npx tsx scripts/backfill-full-2026-metadata.ts --list-remaining-dates
  npx tsx scripts/backfill-full-2026-metadata.ts --process-date-seed-region <date>
  npx tsx scripts/backfill-full-2026-metadata.ts --status`);
  process.exit(1);
}
