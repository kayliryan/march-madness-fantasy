/**
 * Fetch script: pulls real March 2026 NCAA tournament data from ESPN's public API
 * for the 56 players in scripts/data/real-2026-roster.ts, and writes a JSON cache
 * to scripts/data/real-2026-data.json.
 *
 * Usage: npx tsx scripts/fetch-real-2026-tournament.ts
 *
 * No DB access — pure data fetch + cache. Re-run is safe (overwrites the cache).
 */

import fs from 'fs';
import path from 'path';
import { TEAMS, ROSTER, GAMES, type RoundStage } from './data/real-2026-roster';

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

function norm(s: string): string {
  return s
    .replace(/\([^)]*\)/g, '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '') // strip accents
    .toLowerCase()
    .replace(/[\u2010-\u2015-]/g, ' ') // hyphens/dashes -> space
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

async function fetchBoxscore(eventId: string): Promise<BoxscoreTeamBlock[]> {
  const res = await fetch(`${BASE}/summary?event=${eventId}`);
  if (!res.ok) throw new Error(`summary?event=${eventId} -> ${res.status}`);
  const data = await res.json();
  return data?.boxscore?.players ?? [];
}

async function main() {
  const teamByKey = new Map(TEAMS.map((t) => [t.key, t]));
  const espnPlayerIds = new Map<string, string>(); // "member|slot_key" -> espn athlete id
  const gameScores: GameScoreEntry[] = [];
  const matchedKeys = new Set<string>();

  for (const game of GAMES) {
    console.log(`Fetching ${game.round_stage} event ${game.event_id}...`);
    let teamBlocks: BoxscoreTeamBlock[];
    try {
      teamBlocks = await fetchBoxscore(game.event_id);
    } catch (err) {
      console.error(`  ERROR: ${(err as Error).message}`);
      continue;
    }

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
          matchedKeys.add(compositeKey);
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

    // Be polite to ESPN's API
    await new Promise((r) => setTimeout(r, 150));
  }

  // Report any roster entries never matched in any box score
  for (const entry of ROSTER) {
    const compositeKey = `${entry.member}|${entry.slot_key}`;
    if (!matchedKeys.has(compositeKey)) {
      console.warn(`UNMATCHED PLAYER (no espn id resolved): ${entry.member} / ${entry.slot_key} / ${entry.player}`);
    }
  }

  const output = {
    teams: TEAMS,
    players: ROSTER.map((r) => ({
      ...r,
      espn_player_id: espnPlayerIds.get(`${r.member}|${r.slot_key}`) ?? null,
    })),
    game_scores: gameScores,
  };

  const outPath = path.join(__dirname, 'data', 'real-2026-data.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log(`\nWrote ${outPath}`);
  console.log(`  ${output.players.length} players, ${gameScores.length} game_scores rows`);
  console.log(`  ${output.players.filter((p) => !p.espn_player_id).length} players missing espn_player_id`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
