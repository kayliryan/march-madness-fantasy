# March Madness Fantasy

A fantasy league for the NCAA Men's Basketball Tournament, built for one family to replace a
manual spreadsheet — snake-draft real college players, score their actual per-round performance,
and watch bench players automatically promote into the lineup when a starter's team gets
eliminated. Live at **[marchmonsters.com](https://marchmonsters.com)**, with a full no-signup demo.

Built solo, end to end: real-time draft room, Postgres RLS on every table, two Claude-powered AI
features, and a from-scratch bracket simulation engine.

---

## Try it

No account required for either path:

- **Explore as Commissioner** — provisions a live, fully-functional 8-team league in a few
  seconds: a real snake draft against 7 auto-drafting opponents, the Claude-powered draft advisor,
  and the full commissioner toolkit (bench overrides, injury subs, manual scoring). This is the
  same code path a real logged-in league uses, not a stripped-down version.
- **View a completed season** — a static, read-only round-by-round standings view of a season
  that's already been drafted and scored through the Elite 8. Instant load, no provisioning.

Both are linked from the homepage. There's also a standalone [mock draft](https://marchmonsters.com/demo/draft)
if you just want to poke at the draft room by itself, with AI opponents and the advisor, entirely
client-side.

---

## Engineering highlights

- **Concurrency-safe snake draft.** Picks are optimistic-locked via a unique constraint on
  `(draft_session_id, pick_number)` — two simultaneous submissions for the same pick produce
  exactly one `200` and one `409`, never a corrupted draft state. Covered by a dedicated
  concurrency test (`scripts/test/concurrency-demo-void.ts`) that fires two simultaneous
  commissioner void requests at the same pick and asserts the same one-success/one-conflict
  invariant.
- **One source of truth for round scoring.** Every place a roster is broken down round-by-round
  (leaderboard, roster page, demo standings) shares a single `getRoundCell` function
  (`src/lib/utils/roundBreakdown.ts`) that decides whether a slot's points counted, showed as raw
  (bench/eliminated-round) game points, or the player was already out — instead of four screens
  quietly reimplementing the same rule slightly differently.
- **Bench auto-promotion engine.** When a starter's team is eliminated, `BenchOrderService`
  resolves the next eligible bench player using position-eligibility rules (G/F interchangeable,
  C isolated) and a commissioner-configurable priority order — real-time on individual
  eliminations, or in batch at round boundaries, with a 3-retry exponential backoff around the
  activation write.
- **Postgres RLS throughout.** Every table is locked down at the database layer, not just in the
  UI — 31 migrations, several of which exist specifically because an audit found a policy gap
  (e.g. anonymous demo sessions share the same `authenticated` Postgres role as real users, which
  turned up two insert policies reachable by anyone with the anon key; see `CHALLENGES.md` #10).
- **Layered cost defense for a public, no-signup AI feature.** The AI draft advisor is fully live
  (not stubbed) for anonymous demo visitors, protected by four independent server-side caps: a
  per-league call cap, a per-IP demo-provisioning limit, a global concurrent-demo-league ceiling,
  and a global daily AI-call cap sized to the actual dollar budget on the Anthropic account — with
  the cost math for each number written out in code comments (`src/lib/utils/demoAiCap.ts`).
  Real (non-demo) leagues get their own separate daily cap, since they aren't covered by any of
  the demo-specific backstops.
- **Anonymous-session demo provisioning with TTL cleanup.** Clicking "Explore as Commissioner"
  spins up a real Supabase anonymous auth session and a fully-seeded league in a few seconds
  (parallelized bot-member creation, in-memory initial scoring instead of the incremental
  real-time recompute path — see `CHALLENGES.md` #11 for the 30+ second hang this replaced), with
  a daily cron sweeping expired demo leagues and their orphaned auth users.
- **Real 2026 tournament dataset.** 68 teams (4 regions × 16 seeds + First Four) and hundreds of
  fictional players with seed-weighted stat lines, run through a real single-elimination bracket
  simulation (`src/lib/utils/bracketSim.ts`) rather than independent per-team coin flips, so
  eliminations and fantasy scoring always stay consistent with each other.
- **Bespoke regression test harness.** No Jest/Vitest — `scripts/test/*.ts` are standalone
  TypeScript scripts run directly against a local Supabase instance, covering scoring correctness,
  bench-order resolution, injury substitution, draft concurrency, and AI-cap enforcement. See
  [Testing](#testing) below.

---

## Stack

| Layer | Choice |
|---|---|
| Framework | Next.js 16 (App Router, Turbopack) |
| Language | TypeScript 5, strict |
| Database | Supabase (Postgres + Row-Level Security + Realtime) |
| Auth | Supabase Auth (email/password, Google OAuth, anonymous demo sessions) |
| Styling | Tailwind CSS v4 |
| AI | Anthropic Claude API — Sonnet-backed draft advisor, Haiku-backed standings narrator |
| Email | Resend (league invites) |
| Hosting | Vercel |

---

## Local development

```bash
# Start local Supabase (Docker required)
npx supabase start

# Supabase Studio
open http://127.0.0.1:54323

# Apply migrations
npx supabase migration up

# Seed players/teams (idempotent — safe to re-run)
npx tsx --env-file=.env.local scripts/seed-players-2026.ts

# Seed the demo league (run after seed-players; idempotent)
npx tsx --env-file=.env.local scripts/seed-demo-league.ts

# Dev server
npm run dev        # http://localhost:3000

# Type check
npx tsc --noEmit

# Lint
npx eslint src/
```

Copy `.env.example` to `.env.local` and fill in the values it documents (Supabase keys are
printed by `npx supabase start`; `ANTHROPIC_API_KEY` is required for the AI features and bills API
credits directly, not a subscription plan).

### Testing

There's no Jest/Vitest suite — tests are standalone scripts in `scripts/test/`, run directly
against a local Supabase instance:

```bash
npx tsx --env-file=.env.local scripts/test/unit-score-accumulator.ts
npx tsx --env-file=.env.local scripts/test/concurrency-demo-void.ts
# ...and so on for the rest of scripts/test/*.ts
```

Some (draft concurrency, AI-cap regression) exercise real API routes and need `npm run dev`
running in another terminal first; the file header of each script says which.

---

## Project structure

```
src/
├── app/                    # Next.js App Router pages + API routes (src/app/api/)
├── components/              # PlayerCard, DraftQueue, LeagueForm, commissioner tools, ui/
├── lib/
│   ├── constants/           # ROUND_STAGE_ORDER, SCORING_AFFECTING_SETTINGS
│   ├── providers/stats/     # StatsProvider interface + ESPNStatsProvider (fixture-backed today)
│   ├── services/            # DraftEngine, ScoreAccumulator, BenchOrderService, RosterActivationService
│   ├── supabase/            # anon + service-role clients
│   ├── types/                # all DB-mapped TypeScript types
│   └── utils/                # roundBreakdown.ts, bracketSim.ts, draft.ts (pure, client-safe)
├── mocks/fixtures/espn/     # 68-team / 356-player 2026 dataset
└── middleware.ts            # protected-route auth redirects

supabase/
├── migrations/               # 31 SQL migrations, append-only
└── functions/                # set-demo-claim Edge Function

scripts/
├── seed-*.ts                 # idempotent seed scripts
└── test/                     # regression test scripts (see Testing above)
```

---

## Further reading

- **[DESIGN_DOC_v8.md](./DESIGN_DOC_v8.md)** — the full technical spec: game rules, data model,
  concurrency model for the live draft, RLS policy enumeration, API contract, and a scaling plan.
- **[DEMO_EXPERIENCE_SPEC.md](./DEMO_EXPERIENCE_SPEC.md)** — the design behind the no-signup demo:
  what's fully live vs. stubbed and why, the layered AI-cost defenses, and the concurrency
  guarantees around a second anonymous visitor joining the same demo league.
- **[CHALLENGES.md](./CHALLENGES.md)** — an engineering-decisions log of real production issues
  hit and fixed while building this: a doubled REST path that broke every query, a missing
  Postgres GRANT that looked like an RLS bug, a 30+ second demo-provisioning hang traced to a
  scoring service being called on the wrong usage pattern, and the reasoning behind the AI-abuse
  cost defenses above.
- **[SEASON_2027_CHECKLIST.md](./SEASON_2027_CHECKLIST.md)** — the honest readiness plan for
  running this with real live-tournament data in March 2027, including exactly what still needs
  to be built (real ESPN sync is the biggest one — see [Deployment](#deployment) below).

---

## Deployment

The live site runs against a real production Supabase project with `MOCK_ESPN=true` — the
`ESPNStatsProvider`'s "real" code paths aren't implemented yet and currently fall back to the same
fixture data either way (see [SEASON_2027_CHECKLIST.md](./SEASON_2027_CHECKLIST.md) for the plan
to close that gap before the real March 2027 tournament).

1. **Create a production Supabase project**, then from **Settings → API** copy the Project URL,
   anon key, and service role key.
2. **Link and push migrations:**
   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
3. **Deploy the demo Edge Function** (used by `POST /api/demo/session`):
   ```bash
   npx supabase functions deploy set-demo-claim
   ```
4. **Configure Auth redirect URLs** in Authentication → URL Configuration (Site URL + the Vercel
   domain's `/auth/callback`), and re-enter the Google OAuth client ID/secret if using it.
5. **Seed the production database** (idempotent, same scripts as local):
   ```bash
   npx tsx --env-file=.env.production.local scripts/seed-players-2026.ts
   npx tsx --env-file=.env.production.local scripts/seed-demo-league.ts   # powers /demo/league
   ```
6. **Deploy to Vercel** — import the repo, add the env vars from `.env.example` under Production
   scope, set `NEXT_PUBLIC_APP_URL` to the deployed domain. `vercel.json` already configures the
   cron jobs; note that **Vercel's Hobby plan only runs crons once daily**, so a 5-minute
   `sync-scores` schedule silently collapses to daily until upgrading to Pro (harmless today since
   scores are fixture data, but a blocker for live 2027 scoring — see the checklist doc).

---

Personal project — all rights reserved.
