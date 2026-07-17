/**
 * Backfill script: fills in `position` (G/F/C) for the 587 real players in
 * scripts/data/full-2026-tournament-data.json. The season-level roster
 * endpoint assumed for this earlier turned out not to exist (confirmed:
 * only returns $ref links needing 587+ individual fetches) — but the SAME
 * per-game summary endpoint already used for game_stats has position inline
 * per athlete (`"position":{"abbreviation":"G"}` right next to their stats),
 * so this just re-visits the same 54 games and pulls that one extra field.
 *
 * No networking of its own (same sandbox constraint as the other fetch
 * scripts). Two modes:
 *
 *   npx tsx scripts/backfill-positions-2026.ts --list-remaining
 *     -> {done, total, remaining: [{event_id, round_stage, date, url}, ...]}
 *        "remaining" = games where at least one participating player still
 *        lacks a position.
 *
 *   npx tsx scripts/backfill-positions-2026.ts --process-one <event_id>
 *     -> reads scripts/data/.tmp-position-boxscore.json, expected shape:
 *        {"positions": [{"espn_player_id": "...", "position": "G"|"F"|"C"}, ...]}
 *        Merges into players[], checkpoints, deletes the temp file.
 */

import fs from 'fs';
import path from 'path';
import { GAMES } from './data/real-2026-roster';

const DATA_PATH = path.join(__dirname, 'data', 'full-2026-tournament-data.json');
const STATE_PATH = path.join(__dirname, 'data', 'full-2026-position-fetch-state.json');
const TMP_PATH = path.join(__dirname, 'data', '.tmp-position-boxscore.json');

interface PlayerRecord {
  espn_player_id: string;
  name: string;
  espn_team_id: string;
  position?: 'G' | 'F' | 'C';
}
interface GameStat {
  espn_player_id: string;
  event_id: string;
}
interface FullData {
  teams: unknown[];
  players: PlayerRecord[];
  game_stats: GameStat[];
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
function loadState(): SimpleState {
  if (!fs.existsSync(STATE_PATH)) return { completed: [] };
  try {
    return JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
  } catch {
    return { completed: [] };
  }
}
function saveState(s: SimpleState) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(s, null, 2));
}

function listRemaining() {
  const data = loadData();
  const state = loadState();
  const done = new Set(state.completed);
  const playerHasPosition = new Set(data.players.filter((p) => p.position).map((p) => p.espn_player_id));

  const remaining = GAMES.filter((g) => {
    if (done.has(g.event_id)) return false;
    const playersInGame = data.game_stats.filter((gs) => gs.event_id === g.event_id).map((gs) => gs.espn_player_id);
    return playersInGame.some((pid) => !playerHasPosition.has(pid));
  });

  console.log(JSON.stringify({
    done: GAMES.length - remaining.length,
    total: GAMES.length,
    remaining: remaining.map((g) => ({
      event_id: g.event_id,
      round_stage: g.round_stage,
      date: g.date,
      url: `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event=${g.event_id}`,
    })),
  }, null, 2));
  process.exit(remaining.length === 0 ? 0 : 3);
}

function processOne(eventId: string) {
  if (!GAMES.some((g) => g.event_id === eventId)) {
    console.error(`Unknown event_id: ${eventId}`);
    process.exit(1);
  }
  if (!fs.existsSync(TMP_PATH)) {
    console.error(`Expected ${TMP_PATH} — save the position extraction there first.`);
    process.exit(1);
  }
  let parsed: { positions?: { espn_player_id: string; position: string }[] };
  try {
    parsed = JSON.parse(fs.readFileSync(TMP_PATH, 'utf-8'));
  } catch (err) {
    console.error(`Could not parse ${TMP_PATH}: ${(err as Error).message}`);
    process.exit(2);
  }
  const positions = parsed.positions ?? [];

  const data = loadData();
  const playerById = new Map(data.players.map((p) => [p.espn_player_id, p]));
  let updated = 0;
  for (const entry of positions) {
    const p = playerById.get(entry.espn_player_id);
    if (!p) continue; // player not in our known 587 (shouldn't happen)
    if (entry.position === 'G' || entry.position === 'F' || entry.position === 'C') {
      p.position = entry.position;
      updated++;
    }
  }
  saveData(data);

  const state = loadState();
  const completed = new Set(state.completed);
  completed.add(eventId);
  saveState({ completed: [...completed] });
  fs.unlinkSync(TMP_PATH);

  console.log(`Processed positions for event ${eventId}: ${updated} players updated.`);
  process.exit(0);
}

const args = process.argv.slice(2);
if (args[0] === '--list-remaining') listRemaining();
else if (args[0] === '--process-one' && args[1]) processOne(args[1]);
else {
  console.error('Usage:\n  npx tsx scripts/backfill-positions-2026.ts --list-remaining\n  npx tsx scripts/backfill-positions-2026.ts --process-one <event_id>');
  process.exit(1);
}
