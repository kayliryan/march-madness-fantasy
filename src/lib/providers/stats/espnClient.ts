/**
 * ESPN NCAA tournament client — the network layer for the future live
 * StatsProvider (SEASON_2027_CHECKLIST.md Part 1.1).
 *
 * Status of this module (as of July 2026):
 * - Discovery, round mapping, final-game status mapping, box-score parsing,
 *   and game_date derivation are VALIDATED against the complete real 2026
 *   tournament (67 games) — see scripts/test/validate-espn-client-2026.ts,
 *   which replays the whole tournament through this client and diffs every
 *   player's points against scripts/data/full-2026-tournament-data.json.
 * - The in_progress / scheduled status mappings are structurally correct per
 *   ESPN's documented status names but have NEVER been observed against a
 *   live game (the 2026 tournament was over before this was written). They
 *   MUST be exercised during the November-2026 shadow-sync phase (checklist
 *   Part 3.1) before this client drives live scoring.
 * - Deliberately NOT wired into ESPNStatsProvider yet: the sync route also
 *   needs espn_player_id -> players.id translation and scheduled-row
 *   prepopulation (checklist Part 1.1) before the live path is safe.
 *
 * Design rules carried over from the 2026 fetch experience:
 * - Points are located by the position of the 'PTS' label, never by index.
 * - game_date is the UTC date part of the event's ISO timestamp, derived once
 *   at first sight and treated as immutable — it is part of the game_scores
 *   upsert conflict key, so a shifting date silently double-counts points.
 * - Every request retries on 429/5xx with exponential backoff and a hard cap;
 *   ESPN rate-limited even human-paced fetching in 2026.
 */

export type TournamentRoundStage =
  | 'play_in' | 'r64' | 'r32' | 's16' | 'e8' | 'f4' | 'championship';

export type EspnGameStatus = 'scheduled' | 'in_progress' | 'final';

export interface TournamentEvent {
  event_id: string;
  /** UTC date part (YYYY-MM-DD) of the event timestamp — immutable, see header. */
  game_date: string;
  round_stage: TournamentRoundStage;
  /** East | West | South | Midwest — absent on Final Four/championship notes. */
  region: string | null;
  status: EspnGameStatus;
  competitors: {
    espn_team_id: string;
    name: string;
    seed: number | null;
    home_away: 'home' | 'away';
    score: number | null;
    winner: boolean | null;
  }[];
}

export interface BoxScoreLine {
  espn_player_id: string;
  player_name: string;
  espn_team_id: string;
  team_name: string;
  points: number;
  position: 'G' | 'F' | 'C' | null;
}

const BASE = 'https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball';

// "NCAA Men's Basketball Championship - South Region - 1st Round" etc.
const ROUND_BY_NOTE: [RegExp, TournamentRoundStage][] = [
  [/First Four/i, 'play_in'],
  [/1st Round/i, 'r64'],
  [/2nd Round/i, 'r32'],
  [/Sweet 16/i, 's16'],
  [/Elite 8/i, 'e8'],
  [/Final Four/i, 'f4'],
  [/National Championship/i, 'championship'],
];

// ESPN status.type.name values. STATUS_FINAL is validated against real data;
// the pre-final states are per ESPN convention and need live-game observation
// (shadow sync) before being trusted — see module header.
function mapStatus(typeName: string | undefined, completed: boolean | undefined): EspnGameStatus {
  if (typeName === 'STATUS_FINAL' || completed === true) return 'final';
  if (typeName === 'STATUS_SCHEDULED') return 'scheduled';
  return 'in_progress'; // STATUS_IN_PROGRESS, STATUS_HALFTIME, STATUS_END_PERIOD, ...
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** GET with retry/backoff on 429/5xx. Throws after maxRetries — callers must
 *  treat a throw as "this poll cycle failed", never as "no games today". */
export async function espnGetJson(
  url: string,
  { maxRetries = 3, baseDelayMs = 1000 }: { maxRetries?: number; baseDelayMs?: number } = {}
): Promise<unknown> {
  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) await sleep(baseDelayMs * 2 ** (attempt - 1));
    try {
      const res = await fetch(url);
      if (res.ok) return await res.json();
      if (res.status === 429 || res.status >= 500) {
        lastErr = new Error(`ESPN ${res.status} for ${url}`);
        continue; // retryable
      }
      throw new Error(`ESPN ${res.status} (non-retryable) for ${url}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastErr ?? new Error(`ESPN request failed: ${url}`);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- ESPN payloads are
   untyped third-party JSON; every access below is defensive. */

function parseScoreboardEvents(json: unknown): TournamentEvent[] {
  const out: TournamentEvent[] = [];
  for (const ev of ((json as any)?.events ?? []) as any[]) {
    const comp = ev?.competitions?.[0];
    const note: string = comp?.notes?.[0]?.headline ?? '';
    if (!/Men's Basketball Championship/i.test(note)) continue; // NIT/CBI/regular season
    const round = ROUND_BY_NOTE.find(([re]) => re.test(note))?.[1];
    if (!round) continue; // e.g. future formats — skip loudly downstream via count assertions
    const regionMatch = note.match(/-\s*(East|West|South|Midwest)\s+Region/i);
    const competitors = (comp?.competitors ?? []).map((c: any) => {
      const seed = c?.curatedRank?.current;
      return {
        espn_team_id: String(c?.team?.id ?? ''),
        name: String(c?.team?.displayName ?? ''),
        seed: typeof seed === 'number' && seed >= 1 && seed <= 16 ? seed : null,
        home_away: (c?.homeAway === 'away' ? 'away' : 'home') as 'home' | 'away',
        score: c?.score != null && c.score !== '' ? Number(c.score) : null,
        winner: typeof c?.winner === 'boolean' ? c.winner : null,
      };
    });
    out.push({
      event_id: String(ev.id),
      game_date: String(ev.date ?? '').slice(0, 10),
      round_stage: round,
      region: regionMatch ? regionMatch[1] : null,
      status: mapStatus(ev?.status?.type?.name, ev?.status?.type?.completed),
      competitors,
    });
  }
  return out;
}

/**
 * Discovers every NCAA-tournament game for a season by sweeping the scoreboard
 * across the March Madness window (Mar 10 – Apr 10 of the season year, wide
 * enough for any realistic schedule). ~32 requests. A completed tournament
 * yields exactly 67 events — callers seeding a season MUST assert that count
 * (the 2026 dataset silently shipped 13 games short because nothing did).
 */
export async function fetchTournamentEvents(
  season: number,
  { requestGapMs = 400 }: { requestGapMs?: number } = {}
): Promise<TournamentEvent[]> {
  const events = new Map<string, TournamentEvent>();
  const start = new Date(Date.UTC(season, 2, 10)); // Mar 10
  const end = new Date(Date.UTC(season, 3, 10)); // Apr 10
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    const yyyymmdd = d.toISOString().slice(0, 10).replace(/-/g, '');
    const json = await espnGetJson(`${BASE}/scoreboard?dates=${yyyymmdd}&groups=50&limit=200`);
    for (const ev of parseScoreboardEvents(json)) {
      if (!events.has(ev.event_id)) events.set(ev.event_id, ev);
    }
    await sleep(requestGapMs);
  }
  return [...events.values()];
}

const POSITION_MAP: Record<string, 'G' | 'F' | 'C'> = {
  G: 'G', PG: 'G', SG: 'G', F: 'F', SF: 'F', PF: 'F', C: 'C',
};

/**
 * Fetches one game's box score. Returns a line per athlete with a non-empty
 * stats array (ESPN omits stats for DNPs). Points located by the 'PTS' label.
 * For an in-progress game this returns the live partial box score — the same
 * shape, points-so-far (needs shadow-sync confirmation, see module header).
 */
export async function fetchBoxScore(event_id: string): Promise<BoxScoreLine[]> {
  const json = await espnGetJson(`${BASE}/summary?event=${event_id}`);
  const out: BoxScoreLine[] = [];
  for (const block of ((json as any)?.boxscore?.players ?? []) as any[]) {
    const teamId = String(block?.team?.id ?? '');
    const teamName = String(block?.team?.displayName ?? '');
    const statCat = block?.statistics?.[0];
    if (!teamId || !statCat) continue;
    const ptsIdx = (statCat.labels ?? []).indexOf('PTS');
    if (ptsIdx === -1) continue; // never guess a column position
    for (const a of statCat.athletes ?? []) {
      if (!a?.stats || a.stats.length === 0) continue;
      const abbr: string | undefined = a?.athlete?.position?.abbreviation;
      out.push({
        espn_player_id: String(a.athlete?.id ?? ''),
        player_name: String(a.athlete?.displayName ?? ''),
        espn_team_id: teamId,
        team_name: teamName,
        points: a.stats.length > ptsIdx ? parseInt(a.stats[ptsIdx], 10) || 0 : 0,
        position: abbr ? (POSITION_MAP[abbr] ?? null) : null,
      });
    }
  }
  return out;
}

/* eslint-enable @typescript-eslint/no-explicit-any */
