This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

5. **Open in browser:**

Visit [http://localhost:3000](http://localhost:3000)

### Environment Variables

The `.env.local` file is pre-configured for local development with mock ESPN data. See `.env.example`
for the full list of variables and notes on each. For production deployment, see the
[Deployment](#deployment) section below.

## Project Structure

```
src/
├── app/                    # Next.js App Router pages
├── components/
│   └── ui/                 # shadcn/ui components
├── lib/
│   ├── constants/          # ROUND_STAGE_ORDER, SCORING_AFFECTING_SETTINGS
│   ├── supabase/           # Supabase client
│   ├── services/           # Business logic (DraftEngine, ScoreAccumulator, etc.)
│   └── types/              # TypeScript types
└── middleware.ts           # Protected routing

supabase/
├── migrations/             # SQL migrations (append-only)
└── config.toml             # Supabase configuration
```

## Key Features

### Phase 1: Foundation
- ✅ Next.js 14 + TypeScript setup
- ✅ Supabase local development environment
- ✅ Complete schema with all indexes and constraints
- ✅ Row-Level Security (RLS) policies
- 🔄 Google OAuth and email/password auth
- 🔄 Protected routing for authenticated users
- 🔄 Landing page with demo and sign-up options

### Phase 2: Pre-Draft Features
- 📅 Player explorer with filtering and search
- 📋 Draft queue management
- 📧 League creation and invite system
- 🎯 Commissioner tools

### Phase 3: Live Draft Engine
- 🔴 Real-time snake draft with concurrency safety
- ⏱️ Pick timer with auto-pick fallback
- 📊 Position enforcement
- 🔄 JWT token refresh heartbeat

### Phase 4: Scoring Engine
- 🧮 Live scoring with ScoreAccumulator
- 🏀 Bench player activation on elimination
- 📈 Leaderboard with historical tracking
- 🔒 Bench order lock deadline

### Phase 5: AI & Commissioner Tools
- 🤖 AI draft advisor
- 📝 Standings narrator
- 🛠️ Commissioner pick corrections
- ⚙️ Settings management

### Phase 6: Demo Mode & Polish
- 👥 Anonymous demo session
- 🎮 Mock draft mode
- 📊 Historical rankings
- 📱 Mobile responsive design

## Development Notes

- All migrations are append-only. Never edit existing migration files.
- Business logic lives in `src/lib/services/`. API routes call services, not business logic.
- Stage comparisons use `ROUND_STAGE_ORDER.indexOf()`, never lexicographic.
- RLS policies are enforced at the database layer. Application checks are secondary.
- Optimistic locking on draft picks via UNIQUE constraint on `(draft_session_id, pick_number)`.

## Deployment

This deploys a real, working instance to Vercel + a production Supabase project. `MOCK_ESPN=true`
stays on for now — `ESPNStatsProvider`'s "real" branches all currently fall back to the same fixture
data regardless of this flag, so there's no functional difference yet. It's kept `true` to be
explicit about that until real ESPN integration is built.

### 1. Create a production Supabase project

1. Create a new project at [supabase.com](https://supabase.com) (separate from your local dev instance).
2. From the project's **Settings → API** page, copy the **Project URL**, **anon public key**, and
   **service_role key**.
3. Link the CLI and push all 20 migrations in order:
   ```bash
   npx supabase link --project-ref <your-project-ref>
   npx supabase db push
   ```
4. Deploy the demo Edge Function (used by `/api/demo/session`):
   ```bash
   npx supabase functions deploy set-demo-claim
   ```
5. In **Authentication → URL Configuration**, set the Site URL and add a redirect URL for
   `https://<your-vercel-domain>/auth/callback`. If using Google OAuth, add the same redirect URL
   to the Google Cloud OAuth client and re-enter the client ID/secret in
   **Authentication → Providers → Google**.

### 2. Seed the production database

Create `.env.production.local` (not committed) with the new project's URL + service role key, then
run the same idempotent seed scripts used locally:

```bash
npx tsx --env-file=.env.production.local scripts/seed-players-2026.ts
npx tsx --env-file=.env.production.local scripts/seed-demo-league.ts   # optional — powers /demo/league
```

### 3. Deploy to Vercel

1. Import the GitHub repo (`kayliryan/march-madness-fantasy`) into Vercel.
2. Add the environment variables from `.env.example` in **Settings → Environment Variables**
   (Production scope). Use the production Supabase project's URL/keys from step 1.
3. Set `NEXT_PUBLIC_APP_URL` to the Vercel deployment URL (needed for Resend invite links and the
   OAuth redirect).
4. Deploy. `vercel.json` already configures the cron jobs (`/api/cron/sync-scores` every 5 min,
   `/api/cron/demo-cleanup` daily) — Vercel picks these up automatically on a paid plan (Hobby plans
   only run crons once per day, so `sync-scores` won't run on its 5-minute schedule on Hobby).

### 4. Validate with a real league

Once deployed:
- Sign up for real accounts (yourself + family members) and create a real league.
- Run a real draft end-to-end.
- Use the commissioner's manual score entry form to walk through each round (`r64` → `championship`),
  exercising `ScoreAccumulator`, `BenchOrderService`, and `RosterActivationService` against the real
  database — the same code path that will run automatically once live ESPN sync exists.

Note: the player/team pool (`teams-2026.json` / `players-2026.json`) is **fictional** data, not the
real players your family drafted last season. Exact point totals won't match last year's spreadsheet —
but you can validate the *mechanics* by recreating last year's scenarios (e.g. "a starter's team gets
eliminated mid-tournament") via manual score entry and confirming the bench substitution, per-round
points, and leaderboard update the way you'd expect.

## Design Document

Complete technical specifications available in `DESIGN_DOC_v8.md`:
- Game rules and scoring logic
- Data models and schema
- System architecture and algorithms
- Concurrency model for live draft
- RLS policy enumeration
- API contract
- Scaling plan to 1M DAU
- Architecture decision log

## License

[Add your license here]
