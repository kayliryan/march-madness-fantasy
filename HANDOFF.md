# Handoff — July 2026 Audit & Fix Engagement

**For the next AI model (or future Kayli) picking up this project.** Written 2026-07-17/18 at
the end of a four-phase orchestrated engagement. Read this alongside `CLAUDE.md` (kept accurate,
auto-loaded every session) — this file is the narrative of *what just happened and why*;
CLAUDE.md is *what the codebase is*.

## The two goals that drive every priority call

1. **Short-term (now):** marchmonsters.com is on Kayli's resume. A hiring manager must be able
   to see the full engineering depth without an account. Anything broken-looking in the demo is
   a direct negative interview signal.
2. **Long-term (March 2027):** the app runs Kayli's family's real league during the live NCAA
   tournament — real draft, real ESPN data, real-time scoring. The plan for that is
   `SEASON_2027_CHECKLIST.md` (self-contained; do not duplicate it here).

When any tradeoff comes up, decide against these two goals.

## What the engagement did (all on `main`, one commit per work package)

| Commit | What |
|---|---|
| `aeb63a5` | Split supabase module: browser-safe `client.ts` vs server-only `admin.ts` (throws without service key, no silent anon fallback) |
| `693d7b9` | **Security:** REVOKE public EXECUTE on 6 SECURITY DEFINER RPCs (one allowed unauthenticated deletion of ANY league); `is_demo` guard inside the delete RPC; CRON_SECRET-unset guard; testHelpers cleanup rewrite + `withTeamsRestored` |
| `fbc93cc` | **AI cost:** real leagues capped 100 calls/day/league (were unlimited); atomic cap counters; mock-draft-advisor input size limits |
| `4a966df` | **Scoring engine:** bench slots never credit points; `activateBatch` now releases eliminated starters for `end_of_round` leagues (previously never released → phantom "active" eliminated players); `runForLeague` self-heals prior corruption |
| `17804ed` | **Display:** `/rounds` rewritten onto shared `getRoundCell`/`RoundCellBadge` semantics; slot-history rows merged one-per-player on leaderboard expands + demo page (`mergePlayerRounds.ts`); demo page injury badge, archived-season indicator, friendly missing-league state |
| `9730905` | **Provisioning crash fix:** bracket byes — the real-2026 dataset has only 55/68 teams (ESPN fetch silently stopped early) and the odd field crashed `simulateBracketRound`, 500ing the primary homepage CTA against that data |
| `845e35f` | **Provisioning perf:** ~22 sequential round-trips → Promise.all groups (9.4s prod baseline → ~0.45s local HTTP); fixed silent FK delete-order failure on idempotent re-seed |
| `83af4bc` | **Demo UX:** disclosed invite-email stub + copyable invite links (was a false "Invite sent"); localStorage session persistence ("Return to your demo league" instead of silently re-provisioning); spec-exact CTA copy; truthful HOW_IT_WORKS/FEATURES |
| `9571c92` | **Authz hardening:** explicit role checks on 3 commissioner routes; bench-order ownership check; co-commissioner RLS for bench_orders incl. the SELECT-policy-for-RETURNING fix |
| (docs commit) | CLAUDE.md refresh, README rewrite (portfolio front door), `SEASON_2027_CHECKLIST.md`, CHALLENGES.md entries 13–15, this file |
| `86b20c0` | **Dataset completed:** the 13 missing games (all 4 First Four + 9 r64) discovered via ESPN scoreboard sweep and merged — 68 teams / 718 players / 67 games with completeness assertions; ESPN API confirmed directly reachable locally |
| (heartbeat commit) | `sync_heartbeats` table + cron write + commissioner-page "Scores last synced Xm ago" indicator (checklist Part 1.1 monitoring item) |
| `b3072d9` | **ESPN client library** (`src/lib/providers/stats/espnClient.ts`) — discovery/box-score/status parsing for the future live provider, validated by replaying all 67 real 2026 games (`scripts/test/validate-espn-client-2026.ts`, network test). The replay found and fixed 6 games of WRONG box-score data in the dataset (57 bad lines). NOT wired into the live sync path — in_progress/scheduled mapping still needs the Nov-2026 shadow sync. |
| `49653a4` | **Dash-policy fix in `getRoundCell`** (user-reported screenshot bug): within an owned window cells are never "—" — score / strikethrough / 0 / Elim; bench post-release now renders Elim like starters (promotions masked by per-player merge preference). New suite `unit-round-cell-semantics.ts`. |

Four new migrations: `20260717000001` (RPC lockdown), `20260717000002` (AI caps),
`20260718000001` (bench_orders co-commissioner RLS) — plus everything earlier. All applied
locally; **none pushed to production yet.**

## THE most important next action

**Production is still running pre-engagement code and the old complete *fictional* dataset.**
That means, live right now: the RPC security holes are open, real leagues have uncapped AI
routes, and none of the demo polish exists. Conversely, the local repo's real-2026 dataset is
incomplete (55/68 teams) — production only avoids the provisioning crash because it *hasn't*
been reseeded. The deploy order matters:

1. Push code (Vercel deploy from `main`) **and** `npx supabase db push` (the new migrations) —
   the RPC lockdown should land ASAP regardless of anything else.
2. ~~Only reseed prod data after the missing 13 teams are fetched~~ — **done (2026-07-18)**:
   the dataset is now complete (68 teams / 718 players / 67 games, assertions in place) and
   verified locally end-to-end (reseed → provisioning 200 → demo page healthy). Prod reseed is
   now unblocked: `npx tsx --env-file=.env.production.local scripts/seed-full-2026-tournament.ts`
   (note: it purges existing demo leagues by design) then re-run `seed-demo-league.ts`.
   Also learned: **ESPN's API is directly reachable from the local environment** — the old
   agent-driven web_fetch workaround is unnecessary; a plain `fetch()` provider will work.
3. Smoke-test live: homepage CTA end-to-end, `/demo/league`, one AI advisor call
   (`DEMO_AI_CAP_BYPASS_IPS` exists for this), invite-link copy flow.

## Test suite — read this before trusting red/green

Run: `npx tsx --env-file=.env.local scripts/test/<name>.ts` (several need `npm run dev` running).
14 suites; at the end of the engagement, 63 cases pass. **Three failures are expected and
documented, none are code bugs:**

- `test-injury-sub` Case 6 — marked KNOWN FAILING in the test itself; `injury_sub_reversible`
  is deliberately unimplemented (documented dead code).
- `unit-score-accumulator` Case 5 and `test-score-recalculation` Case B — **environmental**:
  tests draft real seeded players, and the shared season-scoped `game_scores` table accumulates
  rows from `advanceRound()` (test helper) and the real-2026 seed. Full-recompute paths then see
  games the test didn't create. They pass on a pristine DB and fail after `test-full-tournament`
  (or similar) has polluted shared state. `test-full-tournament` itself fails the same way.
  The proper fix is a synthetic test season (checklist Part 1.9).
- Do **not** casually `npx supabase db reset` to get a pristine DB: the local database holds the
  real-2026 dataset + the family's historical league, and the exact re-seed chain
  (`seed-full-2026-tournament` → `seed-historical-data` → `seed-real-2026-league` →
  `fix-real-2026-user-ids` → `seed-demo-league`?) is not fully documented. Reconstructing it is
  itself a checklist-worthy task.

## Known remaining issues (deliberately not done)

- `users` table SELECT policy lets any authenticated session (incl. anonymous demo users) read
  every user's display_name/avatar/bio (NOT emails — `public.users` has no email column).
  Scoping it is nontrivial because demo pages legitimately read non-co-members' names; low harm,
  needs care. (Phase 1 finding #12.)
- Season-switcher UI: the demo seeds a prior-season stub and the demo page now *indicates* it
  ("1 archived season"), but there's no actual switcher anywhere.
- Everything in `SEASON_2027_CHECKLIST.md` Parts 1–3 — the real ESPN provider is the big one;
  the provider today is 100% mock regardless of `MOCK_ESPN`.
- Prod provisioning latency: the parallelization is committed but unmeasured against prod until
  deployed (local went 0.87s → 0.45s; prod baseline was 9.4s).

## Where knowledge lives

| Doc | What it's for |
|---|---|
| `CLAUDE.md` | Accurate what-is-built reference; auto-loaded each session |
| `SEASON_2027_CHECKLIST.md` | Everything needed before the live 2027 tournament, incl. testing calendar and the honest Portfolio Assessment |
| `CHALLENGES.md` | Interview-prep log of real issues (15 entries; 13–15 are from this engagement: the RPC EXECUTE hole, the 55/68-team bracket crash, the RLS RETURNING gotcha) |
| `DEMO_EXPERIENCE_SPEC.md` | The audited spec the demo UX was built/fixed against |
| `DESIGN_DOC_v8.md` | Original full technical spec (design intent, incl. unbuilt §16/§17) |
| Memory (`~/.claude/.../memory/`) | `project_phases.md` summarizes this engagement + next actions for future sessions |

## Working-style notes for the next model (from this engagement)

- Kayli runs multi-phase, confirmation-gated engagements with subagent orchestration; briefs to
  subagents must be fully self-contained (they only see CLAUDE.md + the prompt).
- Verify claims empirically before reporting (this engagement found the provisioning crash only
  because a concurrency test actually *ran* provisioning; prod status was checked by hitting the
  live endpoint once, not assumed).
- The test suites share one mutable DB — run order changes results; check whether a failure is
  environmental (see above) before treating it as a regression.
- Nothing here was force-pushed or rebased; history is append-only, matching the migration
  discipline.

## Production deploy status (2026-07-18, end of final session)

- **Live on marchmonsters.com:** all code through `a6f4154`, plus the complete real 2026
  dataset (reseeded) and a fresh static demo league. "Explore as Commissioner" warm latency:
  ~5s → **2.2s** (shared AI-member pool `a6f4154`: zero GoTrue createUser calls warm; the 7
  pool auth users are permanent infrastructure — demo-cleanup exempts them by id).
- **NOT done: the 5 pending migrations** (`20260713000004` through `20260718000002`).
  `supabase db push` requires the prod database password, which only Kayli has (the attempt
  in-session failed auth). Until she runs it, prod degrades gracefully but notably: the RPC
  EXECUTE security lockdown is NOT in effect, demo per-league + real-league AI caps are
  inactive, sync heartbeat isn't recorded, and league-scoped position overrides are
  unavailable. **Running `npx supabase db push` (it will prompt for the DB password) is the
  single most important remaining step.**
- Remaining latency (~2.2s warm) is round-trip count × Vercel↔Supabase RTT; check region
  alignment (no `regions` key in vercel.json → default iad1) before further code changes.
