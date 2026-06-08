This is a [Next.js](https://nextjs.org) project bootstrapped with [`create-next-app`](https://nextjs.org/docs/app/api-reference/cli/create-next-app).

## Getting Started

First, run the development server:

```bash
npm run dev
```

5. **Open in browser:**

Visit [http://localhost:3000](http://localhost:3000)

### Environment Variables

The `.env.local` file is pre-configured for local development with mock ESPN data. For production deployment:

- Update `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` to your Supabase project
- Set `MOCK_ESPN=false` to use real ESPN API
- Add `ANTHROPIC_API_KEY` for AI features
- Add `RESEND_API_KEY` for email notifications
- Set a secure `CRON_SECRET` for background jobs

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

See `DesignDoc.md` Section 9 for detailed deployment strategy across preview, staging, and production environments.

## Design Document

Complete technical specifications available in `DesignDoc.md`:
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
>>>>>>> 37d7c8f (feat: Deliverable 1 - Foundation)
