# March Madness Fantasy — Claude Code Guide

This file is read automatically at the start of every Claude Code session.
It is the source of truth for **what is actually built**. Design intent lives in `DESIGN_DOC_v8.md`;
the logged-out demo experience spec is `DEMO_EXPERIENCE_SPEC.md`; `CHALLENGES.md` is a running log
of real engineering problems hit during launch (kept for interview prep).

**Deployed at marchmonsters.com** (Vercel + production Supabase). This app is a portfolio piece for
Kayli's job search AND will run her family's real league during the March 2027 tournament.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5, strict |
| Database | Supabase (Postgres + RLS + Realtime) |
| Auth | Supabase Auth (middleware in `src/middleware.ts`); anonymous sign-in for demo flows |
| Styling | Tailwind CSS v4 |
| UI primitives | Base UI (`@base-ui/react`) + shadcn pattern, `lucide-react` icons |
| Types/validation | Manual validation in API routes (Zod installed but not yet used) |
| Node compat | Node 20 — polyfill `globalThis.WebSocket` with `ws` before `createClient` in scripts (`src/lib/utils/wsPolyfill.ts`) |
| AI | `@anthropic-ai/sdk` — draft advisor (Sonnet 4.6), standings narrator (Haiku 4.5) |
| Email | `resend` — invite emails; falls back to console.log when `RESEND_API_KEY` absent; fully stubbed for demo leagues |

---

## Environment Variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL        local: http://127.0.0.1:54321 (bare project URL — never include /rest/v1)
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY       used by supabaseAdmin and seed scripts
MOCK_ESPN=true                  ESPNStatsProvider returns fixture data; NOTE: the "real" branches also
                                fall back to fixtures — real ESPN integration is NOT built yet
ANTHROPIC_API_KEY               bills API credits (not Pro plan)
RESEND_API_KEY                  wired in POST /api/league/invite; stubs to console.log if absent
CRON_SECRET                     Authorization: Bearer {CRON_SECRET} on /api/cron/* routes
NEXT_PUBLIC_APP_URL             Resend email links + invite-link generation (defaults localhost:3000)
DEMO_LEAGUE_ID                  used by seed script; same UUID as NEXT_PUBLIC_DEMO_LEAGUE_ID
NEXT_PUBLIC_DEMO_LEAGUE_ID      exposed to client — used by /demo/league page
DEMO_AI_CAP_BYPASS_IPS          comma-separated tester IPs that bypass per-caller demo AI caps
```

---

## Local Development

```bash
npx supabase start                 # local Supabase (Docker required); Studio at 127.0.0.1:54323
npx supabase migration up          # apply new migrations
npx tsx --env-file=.env.local scripts/seed-players-2026.ts     # seed players/teams (idempotent)
npx tsx --env-file=.env.local scripts/seed-demo-league.ts      # seed demo league (idempotent)
npm run dev                        # http://localhost:3000
npx tsc --noEmit                   # type check
npx eslint src/                    # lint
```

## Tests (`scripts/test/`)

No Jest/Vitest — tests are standalone tsx scripts against the local Supabase DB, run as:
`npx tsx --env-file=.env.local scripts/test/<name>.ts`. Each prints PASS/FAIL per case.
Pattern: import `@/lib/utils/wsPolyfill` first, use `db`, `assert`, `createTestLeague`,
`cleanupTestLeague` from `scripts/test/utils/testHelpers.ts`, a local `runCase(name, fn)` runner.

| Script | Covers |
|---|---|
| `unit-score-accumulator.ts` | ScoreAccumulator unit cases |
| `unit-bench-order-service.ts` | BenchOrderService resolution algorithm |
| `unit-regression.ts` | Regression cases (auth trigger, scoring edge cases) |
| `test-full-tournament.ts` | Full-tournament simulation end-to-end |
| `test-score-recalculation.ts` | Settings-change recompute |
| `test-bench-order-change.ts`, `test-injury-sub.ts`, `test-commissioner-tools.ts` | Feature flows |
| `simulate-round.ts` | Drives a round of scores through the pipeline |
| `concurrency-demo-void.ts` | Concurrent pick-void race (409 for loser) |

---

## Database

29 migrations in `supabase/migrations/` (append-only — never edit an existing one). Highlights:

| Migration | What it creates |
|---|---|
| 000000–000008 | Core schema: extensions, `users`, `leagues`/`league_members`/`league_invites`, `teams`/`players`, `draft_sessions`/`draft_picks`/`draft_queues`, `game_scores`/`scoring_events`/`leaderboard_snapshots`, `roster_slots`/`bench_orders`/`timer_extensions`, RLS policies, auth triggers |
| 000009–000013 | RLS additions + fixes (league_members recursion fixes), espn_id unique constraints, `acquire_cron_lock()` |
| 000014 | `is_ai_member` on league_members (demo AI opponents) |
| 000015–000017, 000019 | `provision_demo_league()` RPC (atomic league+members+session), `get_orphaned_demo_league_data()`, `delete_orphaned_demo_leagues()`, orphaned demo-user cleanup |
| 000018, 000020, 000021 | `handle_new_user` SECURITY DEFINER fix, commissioner-update policy recursion fix, draft_picks pick_number unique index fix |
| 20260615* | `demo_expires_at` TTL on leagues, provision TTL wiring, demo AI cap tables (`demo_ai_calls_used` counter, `demo_ai_daily_usage`, `increment_demo_daily_ai_usage()`) |
| 20260618* | roster_slot unique-constraint fix (slot history) |
| 20260713* | role grants fix, `demo_ai_call_log`/`demo_provision_log` IP rate-limit tables, lock down unused INSERT policies, `league_player_position_overrides` (league-scoped, replaces global mutation of `players.position`) |

Key RLS rules to know:
- `players` — publicly readable; writes are service-role only (use `supabaseAdmin`)
- `draft_queues` — private per user (`user_id = auth.uid()`)
- `league_invites` — readable by league members OR invited email; writable by commissioner only
- `bench_orders` / `draft_sessions` — readable by league members; writable by commissioner/co-commissioner
- Demo leagues (`leagues.is_demo = true`) are readable without membership; `demo_viewer` JWT role is blocked from mutations (see Edge Functions section)

---

## Supabase Clients (`src/lib/supabase/client.ts`)

```ts
supabase       // anon key — public reads and client-side RLS-authenticated queries
supabaseAdmin  // service role key — bypasses RLS; use only in API routes with explicit authz checks
```

In API routes, always create a **per-request** server client for auth:
```ts
const supabase = createServerClient(url, anonKey, { cookies: { getAll, setAll } })
const { data: { user } } = await supabase.auth.getUser()
```
Then use `supabaseAdmin` only when you need to bypass RLS (e.g. reading an invite before the user is a member).

---

## Route Handler Patterns

- **Next.js 16: `params` is a Promise** — always `const { id } = await params`
- Auth check: call `supabase.auth.getUser()` → return 401 if no user
- Validation: manual checks, return 400 for missing/invalid fields
- Errors logged with `console.error()`; generic 500 returned to client

---

## API Routes

All routes live under `src/app/api/`.

| Method | Route | Auth | Notes |
|---|---|---|---|
| GET | `/api/players` | — | Public. `?position=G\|F\|C`, `?sort=avg_ppg_desc\|team_seed\|name`, `?search=`, `?team_id=`. Returns players with `teams` join. |
| GET | `/api/teams` | — | Public. Teams for season 2026 ordered by region/seed. |
| POST | `/api/league` | auth | Create league. Returns `{ league, league_member }`. Commissioner row created automatically. |
| GET | `/api/leagues` | auth | User's leagues (via `league_members`). |
| GET | `/api/league/[league_id]` | member | League + members + current_member + `has_roster_data`. |
| GET | `/api/league/[league_id]/rounds` | member | Round-by-round entries per member (player, points, is_bench) using league-scoped position overrides. |
| GET | `/api/league/[league_id]/rosters` | member | All members' enriched rosters via `RosterEnrichment.getEnrichedRoster`. |
| GET | `/api/league/[league_id]/available-players` | member | Undrafted players for this league, `?position=` `?search=`. |
| GET | `/api/league/[league_id]/invites` | commissioner | List invites with links (requires `NEXT_PUBLIC_APP_URL`). |
| PATCH | `/api/league/[league_id]/members/[user_id]` | commissioner | Change member role (`member` \| `co_commissioner`). |
| POST | `/api/league/invite` | commissioner | Creates invite, sends Resend email (stubbed + disclosed for demo leagues; joiners get `member` role, never commissioner). 7-day expiry. |
| GET | `/api/league/invite?token=` | — | Public (uses `supabaseAdmin`). Returns invite + league info. |
| POST | `/api/league/invite/[token]/accept` | auth | Validates expiry/status, creates `league_members` row, marks invite accepted. |
| GET | `/api/league/[league_id]/roster/[user_id]` | member | Roster split into active/released × starter/bench with per-round points. |
| GET | `/api/league/[league_id]/leaderboard` | member | Standings with per_round breakdown and `scores_updating` flag. |
| POST | `/api/league/[league_id]/scores/manual` | commissioner | Upsert game_score (source='manual'), triggers ScoreAccumulator.runForGames fire-and-forget. |
| GET/POST/PATCH/DELETE | `/api/draft/queue…` | auth | User's private queue: list, add, reorder, soft-delete. |
| POST | `/api/draft/session` | commissioner | Upsert draft session (schedule/timer). |
| POST | `/api/draft/start` | commissioner | Starts draft: validates status='scheduled', snake_order set, scheduled_start<=now(). |
| POST | `/api/draft/pick` | member | Submit a pick via DraftEngine.submitPick(). 409 on lock fail, 422 on position enforcement. |
| GET | `/api/draft/state/[session_id]` | member | Full reconnect snapshot + server-side auto-pick enforcement on timer expiry. |
| POST | `/api/draft/timer/extend` | commissioner | INSERTs timer_extensions row, broadcasts TIMER_EXTENDED. |
| PATCH | `/api/commissioner/settings` | commissioner | Shallow-merges league settings. Triggers ScoreAccumulator.runForLeague on scoring-affecting changes. |
| PATCH | `/api/commissioner/bench-order` | commissioner | Body: `{league_id, user_id, ordered_player_ids}`. |
| PATCH | `/api/commissioner/player/position` | commissioner | League-scoped override written to `league_player_position_overrides` (NOT `players.position`). |
| POST | `/api/commissioner/draft/order` | commissioner | Body: `{league_id, order?}`. Omit order for random shuffle. |
| PATCH | `/api/commissioner/pick/void` | commissioner | Void + replace pick (race-safe; replacement required). |
| POST | `/api/commissioner/injury-sub` | commissioner | Requires `injury_sub_enabled=true`. Auto-resolves sub via BenchOrderService if omitted. |
| GET | `/api/cron/sync-scores` | `CRON_SECRET` | Score sync + elimination detection + bench lock + end_of_round activation. Pinned to `CURRENT_TOURNAMENT_SEASON`; filters out historical players sharing espn_player_id. Returns `{ in_progress }` for adaptive polling. |
| GET | `/api/cron/demo-cleanup` | `CRON_SECRET` | Daily cleanup of orphaned/expired demo leagues + AI member auth users. |
| POST | `/api/ai/draft-advisor` | member | `{draft_session_id, question?}` → `{advice}`. Sonnet 4.6. Demo-capped via `checkAndIncrementDemoAiCap`. |
| POST | `/api/ai/standings-narrator` | member | `{league_id}` → `{narrative}`. Haiku 4.5. Demo-capped. |
| POST | `/api/ai/mock-draft-advisor` | anon auth | Stateless mock-draft advice. Sonnet 4.6. Demo-capped (league_id=null path). |
| POST | `/api/demo/provision` | — (rate-limited) | "Try as Commissioner": Layer-2 cap checks → anonymous sign-in → `DemoProvisioningService.provision()` (7 AI members, atomic RPC, seeded in-season state). 429 with `errorCode` on cap hit. |
| POST | `/api/demo/session` | — | Marks an anonymous user `demo_viewer` (read-only demo) via set-demo-claim Edge Function, falls back to direct admin update. |

---

## Pages

| Route | Notes |
|---|---|
| `/` | Landing page — single primary "Explore as Commissioner" demo CTA (provisions via `/api/demo/provision`), secondary link to static completed-season demo, footer link to mock draft. `DemoCTAs` component handles provisioning states/failures. |
| `/dashboard` | Links to create league / view leagues |
| `/players` | Player explorer. `?league_id=` enables queue + drafted status. |
| `/league/create` | Commissioner creates league → invite modal |
| `/league/[league_id]` | League home: standings summary, draft countdown, nav to sub-pages |
| `/league/[league_id]/leaderboard` | Standings with rank, per-round breakdown, round back/forward stepper ("scrubber") |
| `/league/[league_id]/rounds` | Round-by-round view of every member's lineup per round |
| `/league/[league_id]/rosters` | All members' rosters (enriched, per-round cells) |
| `/league/[league_id]/roster/[user_id]` | Single roster: active/released starters+bench, per-round points |
| `/league/[league_id]/rules` | League settings rendered as human-readable rules |
| `/league/[league_id]/bench-order` | Member's own bench order drag-reorder with lock deadline countdown |
| `/league/invite/[token]` | Invite acceptance page (login-aware) |
| `/commissioner/[league_id]` | Commissioner tools: draft order, scheduler, position override, bench override, injury sub, manual score entry, pick void |
| `/draft/[session_id]` | Live draft room: snake strip, countdown, 4s polling + Realtime, JWT heartbeat, AI advisor panel |
| `/auth/login`, `/auth/signup`, `/auth/callback` | Email+password + Google OAuth |
| `/leagues` | User's leagues list |
| `/demo/league` | Read-only standings + roster for the seeded demo league (anonymous sign-in, is_demo RLS) |
| `/demo/draft` | Mock draft simulator: user + 4 AI, client-side only, zero DB writes, bracket season-simulator (`bracketSim.ts`), AI advisor via mock-draft-advisor |

Middleware (`src/middleware.ts`) redirects unauthenticated users to `/` for `/dashboard`, `/league/*`, `/draft/*`, `/commissioner/*`.

---

## Services (`src/lib/services/`)

| Service | Key methods |
|---|---|
| `DraftEngine.ts` | `submitPick`, `autoPickForUser`, `validatePositionEnforcement`, `broadcastPickMade` |
| `ScoreAccumulator.ts` | `runForGames` (incremental, no round_stage advance), `runForLeague` (full recompute, advances round_stage), `runForPlayer` |
| `BenchOrderService.ts` | `resolveNext(league_id, user_id, open_slot_position, sub_eligibility_matrix)` — Section 5.4 algorithm |
| `RosterActivationService.ts` | `activateImmediate(league_id, eliminated_team_id)`, `activateBatch(league_ids, next_round_stage)` — 3-retry exponential backoff |
| `DemoProvisioningService.ts` | `provision(user_id)` — creates 7 AI auth users (uuidv5-deterministic), atomic `provision_demo_league` RPC, seeds in-season state via `seedDemoLeagueData`; full rollback on failure |
| `RosterEnrichment.ts` | `getEnrichedRoster(league_id, user_id)` — slots + player/team + per-round counted/raw points, partitioned active/released × starter/bench |
| `PlayerPositionOverrides.ts` | `getLeaguePositionOverrides`, `resolvePosition`, `applyLeaguePositionOverride` — league-scoped effective positions; never trust `players.position` directly in game logic |

**ScoreAccumulator important invariants:**
- All round comparisons use `ROUND_STAGE_ORDER.indexOf()` — never string comparison
- `released_at_round_stage` not in `ROUND_STAGE_ORDER` (indexOf=-1) → `relIdx=0` (slot never scores)
- `round_stage` in `leaderboard_snapshots` only advances on `runForLeague`; incremental `runForGames` preserves the existing value

---

## Utilities (`src/lib/utils/`)

| File | Purpose |
|---|---|
| `draft.ts` | Pure: `getActiveUserId(snake_order, pick_number)`, `computeMaxPicks` — client-safe (no server imports) |
| `roundBreakdown.ts` | **Single source of truth for per-round cell semantics** — `getRoundCell()` returns `counted` (plain), `raw` (strikethrough — bench points or elimination-round game), `elim` (badge), or `null`. Used by leaderboard, rounds, rosters, demo, mock draft. Rendered by `RoundCellBadge`. |
| `bracketSim.ts` | Pure client-safe NCAA bracket simulation (real paired matchups) for the mock draft season simulator |
| `demoAiCap.ts` | 4-layer demo AI cost defense (per-league 25, concurrent leagues 50, per-IP provision 5/day, global daily 125, per-IP advisor 15/day) — all server-side; cost math documented in comments; `DEMO_AI_CAP_BYPASS_IPS` tester bypass |
| `seedDemoData.ts` | 609-line in-season demo state seeder (rosters, simulated rounds via bracketSim, bench promotions, prior-season stub for the season switcher) |
| `shuffle.ts`, `formatCountdown.ts`, `wsPolyfill.ts` | Fisher-Yates, countdown formatting, Node WebSocket polyfill |

---

## Components

Everything documented before plus: `AppHeader` (persistent header/logo-home nav on every page), `DemoCTAs` (landing-page provisioning CTA with failure states), `NcaaBracketView` (visual bracket), `RosterSlotList` (shared roster section + `visibleRoundsFor`), `RoundCellBadge` (per-round cell rendering), `TeamBadge` (seed+team chip). Original set: `PlayerCard`, `PlayerFilters`, `PlayerSearch`, `InjuryBadge`, `DraftQueue`, `QueueItem`, `DraftOrderStrip`, `LeagueForm`, `LeagueInviteModal`, `DraftOrderGenerator`, `DraftScheduler`, `PlayerPositionOverride`, `BenchOrderOverride`, `ui/button`.

---

## Supabase Edge Functions (`supabase/functions/`)

Deno runtime — excluded from main tsconfig. Deploy with `npx supabase functions deploy <name>`.

| Function | Purpose |
|---|---|
| `set-demo-claim` | Sets `app_metadata.role = demo_viewer` for an anonymous user (read-only demo). Called by `POST /api/demo/session`. |

**demo_viewer JWT claim:** Supabase promotes `app_metadata` into the JWT root, so `auth.jwt() ->> 'role'` reads it. RLS policies on draft_picks, roster_slots, draft_queues, bench_orders include `AND NOT (auth.jwt() ->> 'role' = 'demo_viewer')` to block mutations from read-only demo users. Provisioned "Try as Commissioner" users do NOT get this claim — they have real write access to their own demo league.

---

## Data: Real 2026 Season + Fixtures

- **The database is now seeded with the REAL 2026 tournament** (all teams/players/round-by-round scores), fetched from ESPN via `scripts/fetch-full-2026-tournament.ts` into `scripts/data/full-2026-tournament-data.json`, then seeded by `scripts/seed-full-2026-tournament.ts`. The demo league is wired to real 2026 season data. Kayli's family's real 2026 league was also imported (`scripts/seed-real-2026-league.ts`, `historical_fixture.json`).
- `src/mocks/fixtures/espn/teams-2026.json` / `players-2026.json` — fictional fixture data, still imported by `ESPNStatsProvider` mocks.
- `src/lib/providers/stats/StatsProvider.ts` — interface: `getPlayerStats`, `getInjuryReport`, `getGameStatus`, `getTeamEliminations`.
- `src/lib/providers/stats/ESPNStatsProvider.ts` — **every method falls back to fixture data even when `MOCK_ESPN=false`; real ESPN integration is not built.** This is the largest 2027-readiness gap.
- `CURRENT_TOURNAMENT_SEASON` (`src/lib/constants/season.ts`) = 2026 — leagues with `season <` this are historical and rendered read-only; `sync-scores` is pinned to it (never inferred from newest draft_session, which would be a demo stub row).

---

## Shared Types (`src/lib/types/index.ts`)

All DB-mapped types live here: `User`, `Team`, `Player`, `League`, `LeagueSettings`, `LeagueMember`, `LeagueInvite`, `DraftSession`, `DraftPick`, `DraftQueue`, `RosterSlot`, `GameScore`, `ScoringEvent`, `LeaderboardSnapshot`, plus all API request/response types.

---

## Constants

- `src/lib/constants/rounds.ts` — `ROUND_STAGE_ORDER` = `['draft','play_in','r64','r32','s16','e8','f4','championship']`, `ROUND_LABELS`, comparison helpers
- `src/lib/constants/settings.ts` — `SCORING_AFFECTING_SETTINGS`
- `src/lib/constants/season.ts` — `CURRENT_TOURNAMENT_SEASON = 2026`

---

## Deployment Reality (production)

- Vercel Hobby plan: crons in `vercel.json` run **daily** (`sync-scores` 6:00 UTC, `demo-cleanup` 3:00 UTC). The 5-minute adaptive cadence from the design doc requires Vercel Pro or an external scheduler — fine today because ESPN data is static fixtures, NOT fine for live 2027.
- `MOCK_ESPN=true` in production (no functional difference — see provider note above).

## What's Not Built Yet

**See `SEASON_2027_CHECKLIST.md`** — the authoritative, self-contained plan for everything needed before the live March 2027 tournament (real ESPN provider, scheduler, bench-lock UI, elimination undo, season finalization guard, 2027 seed script, testing calendar). Headlines:

- **Real ESPN API integration** — all `ESPNStatsProvider` non-mock branches fall back to fixtures. Must be built + tested before March 2027 (fetch scripts in `scripts/fetch-*.ts` contain working ESPN endpoint knowledge).
- **Adaptive cron polling** — 30s/5min polling during live games needs Vercel Pro or an external scheduler (design doc Section 4.7).
- **Season rollover path** — updating `CURRENT_TOURNAMENT_SEASON` to 2027 and seeding 2027 teams/players has no documented/automated path yet (three hardcoded `season = 2026` spots: `/api/teams`, `/api/players`, `DemoProvisioningService`).
- **2026 dataset incomplete** — the real-2026 ESPN fetch stopped at 55 of 68 teams; provisioning survives it (bracket byes) but 13 teams/players are missing.
