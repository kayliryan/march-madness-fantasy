/**
 * NETWORK validation for src/lib/providers/stats/espnClient.ts — replays the
 * real, completed 2026 tournament through the client and diffs the results
 * against the trusted local dataset (scripts/data/full-2026-tournament-data.json).
 *
 * This is the "known-answer test" for the future live provider's core parsing:
 * if discovery, round mapping, date derivation, and box-score parsing are
 * correct, running them against the finished 2026 tournament must reproduce
 * the dataset exactly. What it CANNOT validate: scheduled/in-progress status
 * transitions (no live games exist to observe) — that's the November 2026
 * shadow-sync phase (SEASON_2027_CHECKLIST.md Part 3.1).
 *
 * Requires internet access to site.api.espn.com. NOT part of the offline
 * suite — run deliberately:
 *
 *   npx tsx scripts/test/validate-espn-client-2026.ts          # discovery + 13-game box-score sample
 *   npx tsx scripts/test/validate-espn-client-2026.ts --full   # all 67 box scores (~2-3 min, be kind to ESPN)
 */

import fs from 'fs';
import path from 'path';
import { fetchTournamentEvents, fetchBoxScore, type TournamentRoundStage } from '../../src/lib/providers/stats/espnClient';
import { GAMES } from '../data/real-2026-roster';

const DATA_PATH = path.join(__dirname, '..', 'data', 'full-2026-tournament-data.json');

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

async function runCase(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ name, status: 'PASS' });
    console.log(`PASS  ${name}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    results.push({ name, status: 'FAIL', error: message });
    console.log(`FAIL  ${name}`);
    console.log(`      ${message}`);
  }
}

function assert(cond: boolean, msg: string): void {
  if (!cond) throw new Error(msg);
}

interface DatasetStat {
  espn_player_id: string;
  espn_team_id: string;
  event_id: string;
  round_stage: string;
  game_date: string;
  points: number;
}
interface Dataset {
  teams: { espn_team_id: string; name: string }[];
  players: { espn_player_id: string; name: string }[];
  game_stats: DatasetStat[];
}

const EXPECTED_ROUND_COUNTS: Record<TournamentRoundStage, number> = {
  play_in: 4, r64: 32, r32: 16, s16: 8, e8: 4, f4: 2, championship: 1,
};

async function main(): Promise<void> {
  const full = process.argv.includes('--full');
  const dataset: Dataset = JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));

  console.log('Discovering 2026 tournament via live ESPN scoreboard sweep (~32 requests)...');
  const events = await fetchTournamentEvents(2026);

  await runCase('Discovery finds exactly 67 events with the right per-round counts', async () => {
    assert(events.length === 67, `expected 67 events, got ${events.length}`);
    const byRound = new Map<string, number>();
    for (const e of events) byRound.set(e.round_stage, (byRound.get(e.round_stage) ?? 0) + 1);
    for (const [stage, expected] of Object.entries(EXPECTED_ROUND_COUNTS)) {
      assert(byRound.get(stage) === expected, `${stage}: expected ${expected}, got ${byRound.get(stage) ?? 0}`);
    }
  });

  await runCase('Discovered event ids exactly match the trusted dataset', async () => {
    const found = new Set(events.map((e) => e.event_id));
    const expected = new Set(dataset.game_stats.map((g) => g.event_id));
    const missing = [...expected].filter((id) => !found.has(id));
    const extra = [...found].filter((id) => !expected.has(id));
    assert(missing.length === 0 && extra.length === 0, `missing=${missing} extra=${extra}`);
  });

  await runCase('Round stages and derived game_dates match the GAMES list for all 67', async () => {
    const byId = new Map(events.map((e) => [e.event_id, e]));
    const mismatches: string[] = [];
    for (const g of GAMES) {
      const ev = byId.get(g.event_id);
      if (!ev) { mismatches.push(`${g.event_id}: not discovered`); continue; }
      if (ev.round_stage !== g.round_stage) mismatches.push(`${g.event_id}: round ${ev.round_stage} != ${g.round_stage}`);
      if (ev.game_date !== g.date) mismatches.push(`${g.event_id}: date ${ev.game_date} != ${g.date}`);
    }
    assert(mismatches.length === 0, mismatches.slice(0, 5).join('; ') + (mismatches.length > 5 ? ` (+${mismatches.length - 5} more)` : ''));
  });

  await runCase('Every completed event maps to status=final with a winner marked', async () => {
    const bad = events.filter((e) => e.status !== 'final' || !e.competitors.some((c) => c.winner === true));
    assert(bad.length === 0, `events not final/winnerless: ${bad.map((b) => b.event_id).slice(0, 5)}`);
  });

  await runCase('Elimination derivation: losers of the championship path match the dataset', async () => {
    // The winner flag drives future elimination detection: exactly one team
    // (the champion) should never appear as a loser across the 67 games.
    const losers = new Set<string>();
    const appeared = new Set<string>();
    for (const e of events) {
      for (const c of e.competitors) {
        appeared.add(c.espn_team_id);
        if (c.winner === false) losers.add(c.espn_team_id);
      }
    }
    const neverLost = [...appeared].filter((t) => !losers.has(t));
    assert(neverLost.length === 1, `expected exactly 1 never-eliminated team, got ${neverLost.length}`);
    const champName = dataset.teams.find((t) => t.espn_team_id === neverLost[0])?.name;
    assert(champName === 'Michigan Wolverines', `champion resolved to ${champName}`);
  });

  // Box-score replay: sample across every round (or all 67 with --full) and
  // diff every athlete's points against the dataset.
  const sample = full
    ? events
    : (Object.keys(EXPECTED_ROUND_COUNTS) as TournamentRoundStage[]).flatMap((stage) =>
        events.filter((e) => e.round_stage === stage).slice(0, 2)
      );

  const statByKey = new Map<string, DatasetStat>();
  for (const g of dataset.game_stats) statByKey.set(`${g.event_id}:${g.espn_player_id}`, g);

  await runCase(`Box scores reproduce the dataset exactly (${sample.length} game${sample.length === 1 ? '' : 's'}${full ? ', full replay' : ', sampled per round'})`, async () => {
    const diffs: string[] = [];
    let linesChecked = 0;
    for (const ev of sample) {
      const lines = await fetchBoxScore(ev.event_id);
      assert(lines.length > 0, `${ev.event_id}: empty box score`);
      const seenKeys = new Set<string>();
      for (const line of lines) {
        const key = `${ev.event_id}:${line.espn_player_id}`;
        seenKeys.add(key);
        const expected = statByKey.get(key);
        if (!expected) { diffs.push(`${key}: player not in dataset (${line.player_name})`); continue; }
        if (expected.points !== line.points) diffs.push(`${key}: points ${line.points} != ${expected.points}`);
        if (expected.espn_team_id !== line.espn_team_id) diffs.push(`${key}: team mismatch`);
        linesChecked++;
      }
      // Reverse direction: every dataset line for this event must be returned
      for (const g of dataset.game_stats) {
        if (g.event_id === ev.event_id && !seenKeys.has(`${g.event_id}:${g.espn_player_id}`)) {
          diffs.push(`${g.event_id}:${g.espn_player_id}: in dataset but missing from live box score`);
        }
      }
      await new Promise((r) => setTimeout(r, 400));
    }
    assert(diffs.length === 0, diffs.slice(0, 6).join('; ') + (diffs.length > 6 ? ` (+${diffs.length - 6} more)` : ''));
    console.log(`      note: ${linesChecked} player-game lines diffed with zero mismatches`);
  });

  const failed = results.filter((r) => r.status === 'FAIL').length;
  console.log(`\n${results.length - failed} passed, ${failed} failed (of ${results.length})`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
