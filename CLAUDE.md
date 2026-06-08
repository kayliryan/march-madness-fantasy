# March Madness Fantasy — Claude Code Guide

This file is read automatically at the start of every Claude Code session.
It is the source of truth for **what is actually built**. The design intent lives in `DesignDoc.md`.

---

## Tech Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5, strict |
| Database | Supabase (Postgres + RLS + Realtime) |
| Auth | Supabase Auth (middleware in `src/middleware.ts`) |
| Styling | Tailwind CSS v4 |
| UI primitives | Base UI (`@base-ui/react`) + shadcn pattern, `lucide-react` icons |
| Types/validation | Manual validation in API routes (Zod installed but not yet used) |
| Node compat | Node 20 — polyfill `globalThis.WebSocket` with `ws` before `createClient` in scripts |

---

## Environment Variables (`.env.local`)

```
NEXT_PUBLIC_SUPABASE_URL        local: http://127.0.0.1:54321
NEXT_PUBLIC_SUPABASE_ANON_KEY
SUPABASE_SERVICE_ROLE_KEY       used by supabaseAdmin and seed script
MOCK_ESPN=true                  ESPNStatsProvider returns fixture data instead of hitting ESPN
ANTHROPIC_API_KEY               set in ~/.zshrc, bills API credits (not Pro plan)
RESEND_API_KEY                  present but not yet wired — email invites log to console
CRON_SECRET
DEMO_LEAGUE_ID
```

---

## Local Development

```bash
# Start local Supabase (Docker required)
npx supabase start

# Supabase Studio
open http://127.0.0.1:54323

# Apply any new migrations
npx supabase migration up

# Seed players/teams (safe to re-run — idempotent upsert)
npx tsx --env-file=.env.local scripts/seed-players-2026.ts

# Dev server
npm run dev        # http://localhost:3000

# Type check
npx tsc --noEmit

# Lint
npx eslint src/
```

---

## Database

11 migrations in `supabase/migrations/`, applied in order:

| Migration | What it creates |
|---|---|
| 000000 | Extensions (moddatetime, uuid-ossp), shared functions |
| 000001 | `users` table |
| 000002 | `leagues`, `league_members`, `league_invites` |
| 000003 | `teams`, `players` |
| 000004 | `draft_sessions`, `draft_picks`, `draft_queues` |
| 000005 | `scoring_events`, `leaderboard_snapshots` |
| 000006 | `roster_slots`, `bench_orders`, `timer_extensions` |
| 000007 | RLS policies for all tables |
| 000008 | Auth triggers (create `users` row on signup) |
| 000009 | Missing RLS policy additions |
| 000010 | Unique constraints on `espn_team_id` and `espn_player_id` (required for seed upsert) |

Key RLS rules to know:
- `players` — publicly readable; writes are service-role only (use `supabaseAdmin`)
- `draft_queues` — private per user (`user_id = auth.uid()`)
- `league_invites` — readable by league members OR invited email; writable by commissioner only
- `bench_orders` / `draft_sessions` — readable by league members; writable by commissioner/co-commissioner

---

## Supabase Clients (`src/lib/supabase/client.ts`)

```ts
supabase       // anon key — for public reads and client-side RLS-authenticated queries
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
| GET | `/api/players` | — | Public. Supports `?position=G\|F\|C`, `?sort=avg_ppg_desc\|team_seed\|name`, `?search=`, `?team_id=`. Returns players with `teams` join. |
| PATCH | `/api/players/[player_id]` | commissioner | Position override. Requires `league_id` + `note` in body. Uses `supabaseAdmin` to write. |
| POST | `/api/league` | auth | Create league. Returns `{ league, league_member }`. Commissioner row created automatically. |
| GET | `/api/leagues` | auth | User's leagues (via `league_members`). |
| GET | `/api/league/[league_id]` | member | League + members + current_member. |
| PATCH | `/api/league/[league_id]/settings` | commissioner (via RLS) | Shallow-merges partial settings. |
| PUT | `/api/league/[league_id]/bench-order` | member or commissioner | Upserts bench order for a given `user_id`. |
| POST | `/api/league/invite` | commissioner | Creates invite, stubs email to console. 7-day expiry. |
| GET | `/api/league/invite?token=` | — | Public (uses `supabaseAdmin`). Returns invite + league info. |
| POST | `/api/league/invite/[token]/accept` | auth | Validates expiry/status, creates `league_members` row, marks invite accepted. |
| GET | `/api/draft/queue?session_id=` | auth | User's own queue (with player + team join). |
| POST | `/api/draft/queue` | auth | Add player to queue. Looks up `league_id` from `draft_sessions`. |
| PATCH | `/api/draft/queue/[session_id]/[player_id]` | auth | Update `queue_position` (drag-reorder). |
| DELETE | `/api/draft/queue/[session_id]/[player_id]` | auth | Soft delete (`removed_at`). |
| POST | `/api/draft/session` | commissioner (via RLS) | Upsert draft session for a league (create or update). |

---

## Pages

| Route | Component | Notes |
|---|---|---|
| `/` | `src/app/page.tsx` | Landing page |
| `/dashboard` | `src/app/dashboard/page.tsx` | Links to create league / view leagues |
| `/players` | `src/app/players/page.tsx` | Player explorer. Pass `?league_id=` to enable queue + drafted status. |
| `/league/create` | `src/app/league/create/page.tsx` | Commissioner creates league → invite modal |
| `/commissioner/[league_id]` | `src/app/commissioner/[league_id]/page.tsx` | Draft order, scheduler, position override, bench order override |
| `/auth/login` | stub | UI scaffolded, auth not yet wired |
| `/auth/signup` | stub | UI scaffolded, auth not yet wired |

Middleware (`src/middleware.ts`) redirects unauthenticated users to `/` for `/dashboard`, `/league/*`, `/draft/*`, `/commissioner/*`.

---

## Components

| Component | Description |
|---|---|
| `PlayerCard` | Player name, position, team+seed, PPG, injury badge, optional "Add to Queue" button |
| `PlayerFilters` | Position pills (All/G/F/C) + sort dropdown |
| `PlayerSearch` | Text input filtering by player or team name |
| `InjuryBadge` | Hover tooltip showing injury note + date. Hidden when status is `active` or null. |
| `DraftQueue` | Full queue panel: fetches from API, drag-reorder (HTML5 DnD), soft-delete remove, empty-state PPG fallback note |
| `QueueItem` | Single queue row: rank badge, drag handle, player info, remove button |
| `LeagueForm` | League creation fields (name, season, draft type, pick timer, starter slots, bench slots) |
| `LeagueInviteModal` | Send invites by email after creation. Status per invite (sending/sent/error). |
| `DraftOrderGenerator` | Random shuffle or manual arrow-reorder of draft order |
| `DraftScheduler` | Date/time picker + pick timer, saves to `/api/draft/session` |
| `PlayerPositionOverride` | Search-as-you-type player selector, position toggle, required note field |
| `BenchOrderOverride` | Select participant → arrow-reorder their bench players |
| `Button` | `src/components/ui/button.tsx` — Base UI backed, CVA variants: default/outline/secondary/ghost/destructive/link |

---

## Data & Fixtures

- `src/mocks/fixtures/espn/teams-2026.json` — 68 NCAA teams (4 regions × 16 seeds + 4 First Four play-ins)
- `src/mocks/fixtures/espn/players-2026.json` — 356 fictional players with realistic seed-weighted PPG
- `src/lib/providers/stats/StatsProvider.ts` — interface: `getPlayerStats`, `getInjuryReport`, `getGameStatus`, `getTeamEliminations`
- `src/lib/providers/stats/ESPNStatsProvider.ts` — returns fixture data when `MOCK_ESPN=true`; real ESPN calls stubbed

---

## Shared Types (`src/lib/types/index.ts`)

All DB-mapped types live here: `User`, `Team`, `Player` (with optional `teams` join field), `League`, `LeagueSettings`, `LeagueMember`, `LeagueInvite`, `DraftSession`, `DraftPick`, `DraftQueue` (with optional `players` join field), `RosterSlot`, plus all API request/response types.

---

## Constants

- `src/lib/constants/rounds.ts` — `ROUND_STAGE_ORDER`, comparison helpers (`isStageBefore`, etc.)
- `src/lib/constants/settings.ts` — `SCORING_AFFECTING_SETTINGS` (settings keys that require score recalculation when changed)

---

## What's Not Built Yet (Phase 3+)

- **Auth flows** — login/signup pages are UI stubs only
- **Real-time draft room** — pick timer, live picks, auto-pick from queue
- **Scoring engine** — `scoring_events`, `leaderboard_snapshots`, `ScoreAccumulator`
- **Live stats sync** — real ESPN/SportsRadar integration (replace mock in `ESPNStatsProvider`)
- **Email** — `RESEND_API_KEY` is in env but invite emails only log to console
- **Demo league** — `DEMO_LEAGUE_ID` in env, but `/demo/*` routes not built
- **Leagues list page** — `/leagues` route linked from dashboard but not created
