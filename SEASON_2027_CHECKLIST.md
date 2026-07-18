# Season 2027 Checklist — Running the Real Tournament

**Audience: future Kayli, reading this in February 2027 after months away from this codebase.**
This document is self-contained — you should not need to re-read the design doc to act on it.
It was written in July 2026, immediately after a full audit + fix pass, so "current state" below
means the state of the repo as of that pass.

The goal: your family drafts real players on real draft night, scores update live during real
games, and nothing silently breaks. The March window is unforgiving — the bracket is announced
on Selection Sunday (~March 14, 2027; confirm exact date) and the First Four tips off roughly
**three days later**. Everything in Part 1 must be done *before* that week; the only March work
should be running the well-rehearsed seed script and clicking buttons you've already clicked in
rehearsal.

---

## Part 0 — State of the world (July 2026), so you know what you're inheriting

**What works and is tested:**
- The entire scoring pipeline *given final scores in the DB*: `ScoreAccumulator` (bench slots
  never credit; elimination-round points don't count — strict `<` release boundary),
  `RosterActivationService` (both `immediate` and `end_of_round` now correctly release
  eliminated starters and promote bench subs), `BenchOrderService`, leaderboard/roster/rounds
  UI with shared per-round cell semantics (`src/lib/utils/roundBreakdown.ts`).
- Commissioner manual score entry (`POST /api/league/[league_id]/scores/manual`) — this is your
  **production fallback** if live sync fails mid-tournament. It drives the exact same pipeline.
- Draft engine: optimistic-locked picks, snake order, auto-pick on timer expiry, reconnect
  snapshot, tested for concurrent void races (one 200, one conflict).
- Security: service-role-only RPCs are revoked from anon/authenticated (migration
  `20260717000001`); AI routes are capped for both demo and real leagues.
- Test harness: `scripts/test/*.ts` (run each with
  `npx tsx --env-file=.env.local scripts/test/<name>.ts`; several need `npm run dev` running).

**What does NOT exist (the honest list):**
1. **There is no real ESPN integration at all.** Every method in
   `src/lib/providers/stats/ESPNStatsProvider.ts` falls back to mock fixture data even when
   `MOCK_ESPN=false`. In March 2027, the sync cron would return `{ok: true}` daily while doing
   *nothing* — no error, no alert. This is the #1 build item.
2. The sync cron runs **once a day** (`vercel.json`, Vercel Hobby limit). Live scoring needs
   5-minute polling (30s during games per the design doc §16) — requires Vercel Pro or an
   external scheduler (see Part 1.2).
3. ~~The 2026 dataset is incomplete~~ — **DONE (2026-07-18)**: the 13 missing games (all 4
   First Four + 9 first-round) were discovered via an ESPN scoreboard sweep and merged; the
   dataset now holds all 68 teams / 718 players / 67 games, with completeness assertions
   (region×seed table, one champion, 4 play_in losers, 32 r64 losers). Two important facts
   learned in the process: **ESPN's API is directly reachable from the local environment**
   (the old "sandbox can't reach ESPN" constraint was specific to a different tool), and the
   original gap happened because the hand-curated event list was trusted without a
   games-count assertion — the exact failure mode Part 1.7's "assert 68 teams" step exists
   to prevent.
4. `bench_lock_deadline` is **never set for real leagues** — the draft-session route doesn't
   set it and no commissioner UI exists. Bench-order lock at tip-off silently never engages.
5. `teams.is_eliminated` is one-way — no un-eliminate tool if a data glitch marks a team
   eliminated wrongly (which irreversibly triggers bench promotions).
6. No `season_finalized_at` guard — a commissioner of a finished season can still rewrite its
   scores via manual entry (server-side; the UI only *hides* the buttons for historical leagues).
7. Hardcoded `season = 2026` in three places that the `CURRENT_TOURNAMENT_SEASON` constant does
   NOT control: `src/app/api/teams/route.ts`, `src/app/api/players/route.ts`,
   `src/lib/services/DemoProvisioningService.ts` (`DEMO_SEASON`).
8. Test-isolation debt: tests draft real seeded players, and `advanceRound` (test helper) writes
   season-wide `game_scores`. After heavy test runs, `unit-score-accumulator` Case 5 and
   `test-full-tournament` fail from cross-contamination (they pass on a pristine DB). Also
   `test-injury-sub` Case 6 is a deliberate KNOWN FAILING (`injury_sub_reversible` is
   documented dead code).

---

## Part 1 — Build before the season (target: done by end of January 2027)

### 1.1 Real ESPN provider (the big one)

Build the real branches of `ESPNStatsProvider`. Working endpoint knowledge already exists in
`scripts/fetch-full-2026-tournament.ts` / `scripts/fetch-real-2026-tournament.ts` — read their
headers first. What they prove:

- **Box score by event id**:
  `https://site.api.espn.com/apis/site/v2/sports/basketball/mens-college-basketball/summary?event={id}`
  → `boxscore.players[].statistics[0].{labels, athletes[].{athlete.id, stats}}`. Points are in
  `stats` at the index where `labels` says `PTS` — always find by label, never by position.
- **Game discovery** (NOT yet automated anywhere — must build):
  `.../scoreboard?dates=YYYYMMDD&groups=50` lists that day's games with event ids and live
  status. This is what the cron must call first each run.
- The 2026 fetch hit **rate limits** under even human-paced requests. Sustained 5-minute polling
  needs: batch only the games that are live/today, backoff on 429, and never fail the whole run
  on one bad game.

Design decisions to make deliberately (each was flagged in the audit as a silent-corruption risk):

- **Player mapping**: store `espn_player_id` on `players` at seed time (the 2027 seed script must
  capture it), then join on it — never fuzzy name-matching at sync time. Log + skip unknown
  athletes; never guess.
- **`game_date`**: derive from the ESPN event date **in ET, once, at first sight of the event**,
  and never change it on later polls. The `game_scores` upsert conflict key is
  `(player_id, round_stage, round_number, game_date)` — if the date shifts between polls
  (timezone drift or a postponement), you get *duplicate rows and double-counted points*.
  For a genuine postponement, treat it as the same game_date it was first recorded under.
- **Status mapping**: ESPN `status.type.name` → `scheduled` / `in_progress` / `final`. Nothing in
  the codebase has ever parsed a live in-progress payload — capture real samples during the
  shadow-sync period (Part 3) before trusting it.
- **Eliminations**: only mark a team eliminated when its game is `final` and it lost. Marking is
  irreversible today (see 1.4). Round stage comes from the tournament calendar (which dates are
  r64 vs r32, from the scoreboard), not from guessing.
- **Pre-populate `scheduled` rows** for each round as soon as the scoreboard shows the schedule.
  The end-of-round detector (`src/app/api/cron/sync-scores/route.ts`, Responsibility 3) decides
  "round complete" by *"every game_scores row for this stage is final"* — if rows only appear as
  games finish, Thursday-afternoon games being final while the evening games have no rows yet
  reads as "round over" and **triggers bench promotions mid-round**. Scheduled placeholders are
  what make that detector safe.

Also in the same work package:
- `export const maxDuration = 300` (Pro) on the sync route, and batch the per-game upserts
  (currently one awaited upsert per player-game — an r64 Thursday is ~16 games × ~15 scorers,
  and the current N+1 pattern risks a mid-run timeout leaving a **partially updated leaderboard**).
- ~~A visible heartbeat~~ — **DONE (2026-07-18)**: `sync_heartbeats` table (migration
  `20260718000002`), written by the sync-scores cron on every successful run, surfaced on the
  commissioner page as "Scores last synced Xm ago" with an amber "sync may be stalled" state
  past 26h. When the cron cadence changes to 5 minutes for the live tournament, drop
  `SYNC_STALE_AFTER_MS` in `src/app/commissioner/[league_id]/page.tsx` to ~15 minutes.

### 1.2 Scheduler (pick one, set it up in advance)

- **Vercel Pro** (~$20/mo): change `vercel.json` sync-scores schedule to `*/5 * * * *`. For 30s
  cadence during live games, have the route self-assess (`in_progress` is already returned) and
  keep the design-doc State-machine simple: 5-minute polling is honestly fine for a family league.
- **Free alternative**: GitHub Actions workflow on `schedule: '*/5 * * * *'` curling
  `https://www.marchmonsters.com/api/cron/sync-scores` with the `Authorization: Bearer $CRON_SECRET`
  header from a repo secret. (GitHub cron isn't exact-minute-precise; fine here.)
- Either way, **test the scheduler in February**, not March.

### 1.3 Bench lock deadline

Add `bench_lock_deadline` to the draft scheduler UI (`DraftScheduler` component +
`POST /api/draft/session`), defaulting to the scheduled tip-off of r64. Without it, family
members can reorder their bench mid-round, which changes who gets auto-promoted — the fairness
rule the whole bench system exists for.

### 1.4 Elimination escape hatch

Add a commissioner-only route/button to un-eliminate a team (clear `is_eliminated` +
`eliminated_in_round_stage`) **and** revert any roster promotion it triggered (release the
promoted bench slot, re-activate the original starter, then `ScoreAccumulator.runForLeague`).
One bad ESPN payload on a Thursday night otherwise permanently rearranges family rosters.

### 1.5 Season finalization guard

Add `leagues.season_finalized_at` (new migration) + a commissioner "Finalize season" action, and
make the mutation routes (`scores/manual`, `bench-order`, `injury-sub`, `pick/void`) reject
finalized leagues server-side. Today only the UI hides those buttons for historical seasons.

### 1.6 De-hardcode 2026

Parameterize by `CURRENT_TOURNAMENT_SEASON` (`src/lib/constants/season.ts`):
`src/app/api/teams/route.ts`, `src/app/api/players/route.ts`,
`DemoProvisioningService.DEMO_SEASON` (the demo should probably *stay* pinned to a completed
season — make that explicit with a comment rather than accidental).

### 1.7 The 2027 seed script (write and rehearse it NOW, run it on Selection Sunday)

Write `scripts/seed-season.ts --season 2027` (generalize `seed-full-2026-tournament.ts`):
1. Pull the 68-team bracket (regions, seeds, First Four) from the scoreboard/bracket endpoint.
2. Pull each team's roster with **`espn_player_id`, position, and season-average PPG** (PPG
   drives draft-board sorting and auto-pick quality — regular-season stats endpoint).
3. Upsert `teams` and `players` rows with `season = 2027` (the unique constraints on
   `espn_team_id`/`espn_player_id` from migration 000010 make this idempotent).
4. **Verify count = 68 and every (region, seed) is present** — print a loud table. The 2026
   fetch silently stopping at 55/68 is exactly the failure mode to assert against.

Rehearse the full script against 2026 data (or November 2026 rosters) so the Selection-Sunday
run is a re-run, not a first run.

### 1.8 Finish the 2026 dataset (doubles as pipeline validation)

13 teams are missing (compare `scripts/data/full-2026-tournament-data.json` against the real
2026 bracket; the fetch state files show where it stopped). Completing it fixes demo-data quality
AND is a real rehearsal of the fetch pipeline you'll rely on in March.

### 1.9 Test isolation (so February testing is trustworthy)

Give the test helpers their own synthetic teams/players (e.g. `season = 9999`) so suites stop
drafting real players and `advanceRound` stops polluting real-season `game_scores`. This is what
makes `unit-score-accumulator` Case 5 / `test-full-tournament` deterministic again.

---

## Part 2 — Configuration flips (in order, when the time comes)

| When | Change | Where |
|---|---|---|
| After 2026 leagues are finalized | `CURRENT_TOURNAMENT_SEASON = 2027` | `src/lib/constants/season.ts` (2026 leagues become read-only historical everywhere) |
| When real provider ships | `MOCK_ESPN=false` | Vercel env vars (and verify the provider no longer *silently falls back* to mock when false — add a startup log line) |
| February | Cron schedule to 5-min | `vercel.json` (Pro) or GitHub Actions secret + workflow |
| February | Confirm set: `CRON_SECRET`, `ANTHROPIC_API_KEY`, `RESEND_API_KEY`, `NEXT_PUBLIC_APP_URL=https://www.marchmonsters.com` | Vercel env vars |
| Selection Sunday | Run the 2027 seed script against **production** | `npx tsx --env-file=.env.production.local scripts/seed-season.ts --season 2027` |
| Before draft night | Push any pending migrations to prod | `npx supabase db push` (CLI is already linked; see `supabase/.temp/linked-project.json`) |

Also: the Anthropic account currently runs a **$5/day hard budget** (set for the demo-launch
window — see `src/lib/utils/demoAiCap.ts` comments). Raise it for draft night or the family's
AI draft advisor will die mid-draft; the per-league cap (100/day) is the in-app guard.

---

## Part 3 — What must be tested with real ESPN data (and how, before March)

The core problem: **live in-progress ESPN data cannot be observed in July, and has never been
observed by this codebase at all.** College basketball's regular season (November 2026 –
February 2027) uses the *same API family* — use it.

### 3.1 November–December 2026: shadow sync
Point a staging copy (local, or a Vercel preview + separate Supabase project) at real
regular-season games with the new provider, polling every 5 minutes on real game nights:
- Scoreboard discovery finds that night's games; event ids resolve to box scores.
- Status transitions observed live: `scheduled → in_progress → final` (capture raw JSON samples
  of each state into `scripts/data/` for regression fixtures).
- `game_date` stability across polls (log a loud error if a game's derived date ever changes).
- Rate-limit behavior under sustained automated polling — the 2026 experience (429s under
  human-paced fetching) says this WILL need backoff.
- No crash when a game is postponed/cancelled (it happens in the regular season — free chaos
  testing).

### 3.2 January 2027: full simulated tournament (compressed time)
On local/staging with 2027-shaped synthetic data, drive the entire bracket in an evening using
the existing harness (`scripts/test/simulate-round.ts`, `test-full-tournament.ts`) plus manual
score entry, and verify by hand in the UI:
- A starter's team eliminated mid-round → correct bench promotion (`immediate` league) and
  end-of-round promotion (`end_of_round` league — this path was broken until July 2026; the
  regression test is `scripts/test/regression-scoring-fixes.ts` Case 4).
- A user with no eligible bench sub → slot goes vacant, no crash, UI shows it sanely.
- Tie on the leaderboard → tiebreaker (highest single active game) displayed correctly.
- Pick void + replacement, injury sub, bench reorder, score correction on an already-final game
  (recompute updates the leaderboard).
- Championship ends → totals stable; run "Finalize season" (built in 1.5) and confirm mutations
  are rejected afterwards.

### 3.3 Early March 2027 (conference tournament week): dress rehearsal
Real live games, one test league, production infrastructure:
- The actual cron cadence live-updating scores from real in-progress games.
- The commissioner-page sync heartbeat visibly ticking.
- Deliberately break it once: revoke `CRON_SECRET` for an hour, confirm you *notice* (heartbeat
  goes stale), then recover and confirm backfill on the next successful run.

### 3.4 Draft-night rehearsal (the weekend before the real draft)
- Schedule a draft with 2–3 real humans on real devices (phone + laptop).
- Let a timer expire → auto-pick fires; kill a tab mid-draft → reconnect snapshot restores;
  ask the AI advisor questions during picks (this exercises the real-league AI caps).
- Commissioner: extend a timer, void + replace a pick.
- Afterwards, delete the rehearsal league.

### 3.5 Failure drills (write the answers down on paper before draft night)
- ESPN dies mid-Thursday → commissioner enters scores manually from the TV
  (`/commissioner/[league_id]` → manual score entry). Practice this once so it's muscle memory.
- Wrong score synced → manual entry overwrites (same conflict key, `source='manual'`), then the
  next `runForGames` recomputes. **Manual scores can be re-overwritten by the next ESPN sync**
  (same upsert key) — if you need a correction to *stick*, note it as a known limitation to fix,
  or pause the scheduler while correcting.
- Team wrongly eliminated → the 1.4 escape hatch. If you didn't build 1.4, the recovery is
  manual SQL — another reason to build it.

---

## Part 4 — Manual commissioner steps (the human runbook)

**~2 weeks out (early March):**
1. Sign in at marchmonsters.com with your real account → Create League. Choose starter/bench
   counts (family default: G1 G2 F1 F2 C1 + 3 bench) and **activation timing** — `immediate`
   (bench promotes the moment a team is eliminated) vs `end_of_round` (promotions apply between
   rounds). Both are now tested; `immediate` is the more exciting default.
2. Invite the family by email (real Resend emails — confirm `RESEND_API_KEY` is set; each invite
   expires in 7 days, so don't send them a month early). Chase everyone to actually accept.

**Selection Sunday (bracket reveal):**
3. Run the 2027 seed script against prod (Part 2 table). Spot-check `/players`: 68 teams,
   realistic PPG, positions filled.
4. Generate the draft order (random shuffle button or manual), schedule the draft for
   Mon/Tue/Wed before r64 tip-off, set the pick timer (60–90s is comfortable for family),
   and set the **bench lock deadline** to r64 tip-off (built in 1.3).

**Draft night:**
5. Everyone in the draft room 10 minutes early (reconnect works, but don't lean on it).
   You click Start Draft. Timer auto-picks cover stragglers. AI advisor is live for everyone.
6. After the draft: everyone sets their bench order before the lock deadline.

**During the tournament:** mostly nothing — watch the leaderboard update. Check the sync
heartbeat each game day. Use injury-sub / manual entry / void tools only when reality demands.

**After the championship:** Finalize the season (1.5). The league flips to historical and
next year's you inherits clean data.

---

## Portfolio Assessment

As a portfolio piece, this codebase's genuine strength is its **domain-engine depth**: a
concurrency-safe snake draft (optimistic locking with tested race behavior), a scoring system
with a single shared source of truth for genuinely subtle rules (bench points, elimination-round
boundaries, slot-history merging), a layered and cost-justified abuse-defense design for the
public demo, real RLS discipline with migrations that show threat-model iteration, and a bespoke
but real regression harness — this reads like a production system built by someone who thinks
about failure modes, not a tutorial app. Its genuine weakness is that the single most
"real-world" component — live third-party data integration — doesn't exist yet: the ESPN
provider is 100% mock behind a flag that pretends otherwise, which an interviewer who asks "so
what happens on game night?" will find in five minutes; secondarily, the test suite's isolation
debt (tests sharing mutable season-wide state) undercuts an otherwise strong testing story. The
single most important thing to do before putting marchmonsters.com on a resume is to **deploy
the July 2026 fix wave plus a completed dataset to production** — the security lockdown,
scoring fixes, and demo polish only exist locally until then, and the demo a hiring manager
actually clicks is the version that counts.
