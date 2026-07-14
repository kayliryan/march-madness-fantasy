// Pure, client-safe NCAA bracket simulation used by the mock draft's Season
// Simulator. Builds a real single-elimination bracket (paired matchups, not
// independent per-team coin flips) so the visual bracket and fantasy scoring
// both derive from the same source of truth.

export interface BracketTeam {
  name: string;
  seed: number;
  region: string;
}

// Standard NCAA bracket seeding order for a 16-team region — adjacent pairs
// (0,1), (2,3), ... meet in round 1; winners of those pairs meet in round 2,
// and so on. This single ordering is what lets one simple "pair up neighbors"
// function drive every round, all the way through the championship.
const SEED_ORDER = [1, 16, 8, 9, 5, 12, 4, 13, 6, 11, 3, 14, 7, 10, 2, 15];

// Regions are concatenated in this order so that, after each region collapses
// to its own champion (post Elite 8), region[0] plays region[1] and region[2]
// plays region[3] in the national semifinals — matching the standard bracket
// layout (e.g. East vs West, South vs Midwest).
export const REGION_ORDER = ['East', 'West', 'South', 'Midwest'];

export interface RawTeam {
  name: string;
  seed: number;
  region: string;
}

/**
 * Resolves First Four duplicate seeds (two 16-seeds, two 11-seeds, etc. in
 * the fixture data) down to a clean 16-team field per region, in standard
 * bracket order, then concatenates all 4 regions into one 64-team array.
 */
export function buildInitialField(allTeams: RawTeam[]): BracketTeam[] {
  const byRegion = new Map<string, RawTeam[]>();
  for (const t of allTeams) {
    if (!byRegion.has(t.region)) byRegion.set(t.region, []);
    byRegion.get(t.region)!.push(t);
  }

  const regions = [...byRegion.keys()].sort(
    (a, b) => REGION_ORDER.indexOf(a) - REGION_ORDER.indexOf(b)
  );

  const field: BracketTeam[] = [];
  for (const region of regions) {
    const teams = byRegion.get(region) ?? [];
    const bySeed = new Map<number, RawTeam[]>();
    for (const t of teams) {
      if (!bySeed.has(t.seed)) bySeed.set(t.seed, []);
      bySeed.get(t.seed)!.push(t);
    }
    for (const seed of SEED_ORDER) {
      const candidates = bySeed.get(seed) ?? [];
      if (candidates.length === 0) {
        field.push({ name: `TBD #${seed}`, seed, region });
      } else if (candidates.length === 1) {
        field.push({ name: candidates[0].name, seed, region });
      } else {
        // First Four — resolve to one team before the bracket "starts"
        const winner = candidates[Math.floor(Math.random() * candidates.length)];
        field.push({ name: winner.name, seed, region });
      }
    }
  }
  return field;
}

// Lower seed = stronger. Returns P(teamA wins) as a function of the seed gap.
function winProbability(seedA: number, seedB: number): number {
  const gap = seedB - seedA; // positive if A is the stronger (lower) seed
  return 1 / (1 + Math.exp(-gap * 0.22));
}

export interface BracketMatchup {
  a: BracketTeam;
  b: BracketTeam;
  winner: BracketTeam;
  loser: BracketTeam;
}

/** Plays every adjacent pair in `alive` once and returns the winners (half the length). */
export function simulateBracketRound(alive: BracketTeam[]): { winners: BracketTeam[]; matchups: BracketMatchup[] } {
  const winners: BracketTeam[] = [];
  const matchups: BracketMatchup[] = [];
  for (let i = 0; i < alive.length; i += 2) {
    const a = alive[i];
    const b = alive[i + 1];
    const aWins = Math.random() < winProbability(a.seed, b.seed);
    const winner = aWins ? a : b;
    const loser = aWins ? b : a;
    winners.push(winner);
    matchups.push({ a, b, winner, loser });
  }
  return { winners, matchups };
}
