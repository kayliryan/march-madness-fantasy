/**
 * Pure unit tests for src/lib/utils/bracketSim.ts — no database required.
 *
 * Regression context: the local/prod `teams` table can hold a PARTIAL field
 * (the full-2026 ESPN fetch stopped early at 55 of 68 teams), and
 * seedDemoLeagueData builds its bracket field by filtering out missing seeds —
 * producing an odd-length array. simulateBracketRound used to crash on
 * `alive[i+1].seed` (undefined) in that case, which 500'd the entire
 * "Explore as Commissioner" demo provisioning flow. Odd fields must now give
 * the unpaired last team a bye instead.
 *
 * Run: npx tsx scripts/test/unit-bracket-sim.ts
 */

import { simulateBracketRound, buildInitialField, type BracketTeam } from '../../src/lib/utils/bracketSim';

type CaseStatus = 'PASS' | 'FAIL';
const results: { name: string; status: CaseStatus; error?: string }[] = [];

function runCase(name: string, fn: () => void): void {
  try {
    fn();
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

function makeTeams(count: number): BracketTeam[] {
  return Array.from({ length: count }, (_, i) => ({
    name: `team-${i}`,
    seed: (i % 16) + 1,
    region: ['East', 'West', 'South', 'Midwest'][i % 4],
  }));
}

/** Repeatedly plays rounds until one team remains; returns rounds played + all losers. */
function playToChampion(field: BracketTeam[]): { rounds: number; losers: Set<string>; champion: BracketTeam } {
  let alive = field;
  const losers = new Set<string>();
  let rounds = 0;
  while (alive.length > 1) {
    const { winners, matchups } = simulateBracketRound(alive);
    for (const m of matchups) losers.add(m.loser.name);
    assert(winners.length === Math.ceil(alive.length / 2), `round produced ${winners.length} winners from ${alive.length} teams`);
    alive = winners;
    rounds++;
    assert(rounds < 20, 'bracket did not converge — possible infinite loop');
  }
  return { rounds, losers, champion: alive[0] };
}

// ── Cases ────────────────────────────────────────────────────────────────

runCase('Even power-of-two field (64) plays 6 rounds, one champion, 63 losers', () => {
  const { rounds, losers, champion } = playToChampion(makeTeams(64));
  assert(rounds === 6, `expected 6 rounds, got ${rounds}`);
  assert(losers.size === 63, `expected 63 losers, got ${losers.size}`);
  assert(!losers.has(champion.name), 'champion also recorded as a loser');
});

runCase('Odd field (55 teams — the real partial-fetch shape) converges without crashing', () => {
  const { losers, champion } = playToChampion(makeTeams(55));
  assert(losers.size === 54, `expected 54 losers, got ${losers.size}`);
  assert(!losers.has(champion.name), 'champion also recorded as a loser');
});

runCase('Single unpaired team gets a bye (no matchup recorded)', () => {
  const teams = makeTeams(3);
  const { winners, matchups } = simulateBracketRound(teams);
  assert(winners.length === 2, `expected 2 winners from 3 teams, got ${winners.length}`);
  assert(matchups.length === 1, `expected 1 matchup from 3 teams, got ${matchups.length}`);
  assert(winners.some((w) => w.name === teams[2].name), 'last unpaired team did not advance via bye');
});

runCase('Field of 1 returns no matchups and the team survives', () => {
  const teams = makeTeams(1);
  const { winners, matchups } = simulateBracketRound(teams);
  assert(winners.length === 1 && matchups.length === 0, 'single-team round should be a pure bye');
});

runCase('buildInitialField pads missing seeds so mock-draft fields stay full', () => {
  // 4 regions but only seeds 1-10 present (missing 11-16 everywhere)
  const raw = ['East', 'West', 'South', 'Midwest'].flatMap((region) =>
    Array.from({ length: 10 }, (_, i) => ({ name: `${region}-${i + 1}`, seed: i + 1, region }))
  );
  const field = buildInitialField(raw);
  assert(field.length === 64, `expected padded 64-team field, got ${field.length}`);
});

// ── Summary ──────────────────────────────────────────────────────────────

const failed = results.filter((r) => r.status === 'FAIL').length;
console.log(`\n${results.length - failed} passed, ${failed} failed (of ${results.length})`);
if (failed > 0) process.exit(1);
