# Engineering Challenges — March Madness Fantasy

A running log of real problems hit while building and shipping this app, how they were diagnosed, and how they were fixed. Kept for interview prep — these are the stories worth telling, not the features.

Each entry: what broke, how it was found, root cause, the fix, and the takeaway.

---

## 1. Real PII leaked into git history via a code comment

**What broke:** A code comment in `scripts/seed-historical-data.ts` referenced two real personal Gmail addresses (explaining a data-dedup edge case for a real historical league). The comment had already been pushed to the GitHub remote in an earlier commit.

**How it was found:** A deliberate security sweep before a public deploy — grepped the repo for email-pattern strings, not something that surfaced on its own.

**Root cause:** Explaining a real-world data quirk in a comment by naming the actual people involved, instead of describing the situation generically.

**Fix:** Rewrote the comment to describe the scenario without naming anyone, then used `git filter-repo` to strip the raw email strings from every commit in history (not just HEAD), and force-pushed the rewritten history.

**Takeaway:** A security sweep needs to check git *history*, not just the current working tree — `git log -p` or `git filter-repo --analyze` for secrets, not just a grep of checked-out files. Comments explaining "why" are exactly where PII sneaks in, because they don't feel like data.

---

## 2. Plaintext real password sitting in an untracked script

**What broke:** `scripts/set-pooka-password.ts` hardcoded a real family member's Supabase auth password in plaintext. Never committed to git, but sitting on disk.

**How it was found:** Same security sweep — grepped for `supabaseAdmin.auth.admin.updateUserById` and similar patterns across all files, tracked or not.

**Fix:** Deleted the file. Recommended the real account holder rotate that password anyway, since "never pushed" doesn't mean "never exposed" — it lived in plaintext on a real disk.

**Takeaway:** `.gitignore` and "untracked" protect against *remote* leaks, not local ones. A one-off admin script is still a liability the moment it's written.

---

## 3. Vercel Hobby plan silently limits cron jobs to once a day

**What broke:** `vercel.json` had `/api/cron/sync-scores` scheduled `*/5 * * * *` (every 5 minutes). Vercel's Hobby (free) tier only supports daily cron schedules.

**How it was found:** Caught before deploy, not after — checked the Vercel plan against the cron config as part of a pre-launch checklist, rather than finding out via a silently-ignored (or rejected) deployment.

**Fix:** Dropped the sync-scores cron to once daily. Since the launch uses `MOCK_ESPN=true` fixture data (no live score changes), this has zero functional impact today; documented in a code comment to bump back to 5-minute cadence if upgrading to Pro later.

**Takeaway:** Hosting-tier limits are easy to miss because they fail *silently* or with a vague dashboard warning, not a build error. Worth an explicit checklist item before any deploy: "does this config assume a paid tier?"

---

## 4. Doubled REST path in the Supabase URL broke every single query

**What broke:** Cloud database seeding failed on *every* table with `PGRST125: Invalid path specified in request URL`.

**How it was found:** The error code alone wasn't informative; recognized the doubled-path pattern once seeing `NEXT_PUBLIC_SUPABASE_URL=https://xxx.supabase.co/rest/v1/` in the actual env file — `supabase-js` already appends `/rest/v1/...` internally, so the base URL should never include that suffix.

**Root cause:** A copy-paste of the wrong URL (the REST API endpoint shown in some Supabase docs/dashboards, instead of the bare project URL) into the env file.

**Fix:** Trimmed the URL to just `https://xxx.supabase.co`.

**Takeaway:** A single misconfigured env var can produce an error that looks like a code bug (wrong table? wrong RLS policy?) when it's actually a copy-paste mistake one layer down. Worth checking the simplest explanation before assuming the complex one.

---

## 5. `service_role` isn't a superuser — missing table grants caused 42501 errors everywhere

**What broke:** Seeding the cloud database failed with `permission denied for table teams` / `users` / `leagues` (Postgres error `42501`), despite using the service-role client that's supposed to bypass RLS.

**Root cause:** `service_role` in Supabase has the `BYPASSRLS` attribute, which skips *row-level* policies — but it's still a normal Postgres role that needs standard `GRANT SELECT, INSERT, UPDATE...` privileges to touch a table at all. Those grants apparently never got set up on this specific cloud project (this can happen when a schema is built via CLI migrations rather than the Studio UI, which normally wires this up automatically).

**Fix:** Wrote a migration granting `service_role`, `authenticated`, and `anon` the appropriate baseline table/sequence privileges, plus `ALTER DEFAULT PRIVILEGES` so future migrations inherit the same grants automatically.

**Takeaway:** "Bypasses RLS" and "has full access" are not the same thing. Worth understanding the actual privilege model (GRANTs + RLS as two independent layers) rather than treating `service_role` as a magic admin key.

---

## 6. Invalid model name silently broke every AI advisor call

**What broke:** The AI draft advisor returned `500 Internal Server Error` on every single call, both in the mock draft and the real draft room.

**How it was found:** Server logs showed `Error: 400 {"type":"invalid_request_error", ...}` from Anthropic's API — the code was requesting `model: 'claude-sonnet-4-6'`, which isn't a real model identifier.

**Fix:** Corrected to a valid model string.

**Takeaway:** A model name is just a string to the type system — nothing catches a typo'd or hallucinated model name at compile time. The generic 500 the route returned on any thrown error made this look like a much bigger problem than it was; the actual Anthropic error message (buried one level deeper than the first log line) had the real answer the whole time.

---

## 7. A file the app depended on was never committed — broke the Vercel build

**What broke:** After pushing a commit that wired a new utility (`demoAiCap.ts`) into two API routes, the Vercel build failed: `Module not found: Can't resolve '@/lib/utils/demoAiCap'`.

**Root cause:** The file existed locally (and had for a while, alongside other in-progress work) but had never actually been `git add`-ed — it was sitting as an untracked file. Every route that imported it worked fine locally (the file was right there on disk) but the commit that referenced it never actually included it.

**Fix:** Committed the missing file, plus two other routes that depended on the same utility and were sitting in the same uncommitted state.

**Takeaway:** "Works on my machine" is a precise description of this bug: local disk state and git state had quietly diverged. `git status` before every push, not just before the first one of the day.

---

## 8. Anthropic account had zero credits — looked like a code bug, wasn't

**What broke:** After fixing #6, the advisor still failed — this time a clean `500` with the message `"Your credit balance is too low to access the Anthropic API."`

**Fix:** Not a code fix — added credits to the Anthropic Console. Also set a hard `$5/day` cap with auto-reload off for the launch window, rather than an unbounded pay-as-you-go budget, specifically *because* it's easy to not notice usage until a bill shows up.

**Takeaway:** Not every production error is a bug. Billing/quota/capacity errors from a third-party API look identical to code errors from the outside (a 400 or 500 with a JSON body) — the fix is reading the actual error message, not assuming and re-debugging code that's already correct.

---

## 9. Designing real cost/abuse protection for a public, no-signup AI feature

**Context:** A "no signup, try it now" AI feature on a public URL is a standing invitation for automated abuse — a bot can hit the endpoint far faster and more persistently than any real user.

**Design (four layers, tightened over the course of the launch):**
- **Per-league cap** — a single demo league can't rack up more than 25 AI calls total.
- **Concurrent-league cap** — at most 50 demo leagues can exist at once (bounds total exposure even from Layer 1 alone).
- **Per-IP provisioning limit** — at most 5 new demo leagues per IP per day (explicitly documented as a soft, bypassable signal — a determined abuser can rotate IPs — the real backstops are the caps above and below it).
- **Global daily AI-call cap** — a hard ceiling across the entire feature, sized to match the actual dollar budget set on the Anthropic account (started at 500 calls/~$20/day, retuned to 125 calls/~$5/day when the budget was tightened).
- **Added later: per-IP cap on AI calls specifically** — the first three layers governed *creating* a demo league, but nothing stopped one caller from single-handedly exhausting the whole shared daily AI-call pool and making the feature look "down" for every other visitor. Added a 15-calls/IP/day limit on the advisor endpoints themselves once this gap was noticed.

**On CAPTCHA:** Supabase recommends CAPTCHA when enabling anonymous auth. Deliberately skipped it for this launch — the actual worst-case dollar exposure is already hard-capped by the Anthropic account's own $5/day budget regardless of bot volume, and CAPTCHA adds real friction to a feature whose entire pitch is "click one button, no signup." Documented as an easy add-later if real abuse shows up in practice, rather than a day-one requirement.

**Takeaway:** Rate limiting isn't one control, it's a set of them at different layers (creation vs. usage, per-actor vs. global), and each layer should have a written-down reason for its specific number. A single limit almost always has a gap that becomes obvious once you think about what it *doesn't* cover.

---

## 10. Anonymous auth quietly shares a Postgres role with real users

**What broke:** Nothing was broken yet — this was a proactive question ("are we secure enabling anonymous sign-ins?") that turned up a real gap.

**The nuance:** Supabase's anonymous users authenticate as the same Postgres `authenticated` role as real signed-up users for RLS purposes. Any policy gated only on "is someone logged in" (`auth.uid() is not null`) applies equally to a real user and to someone who clicked a button four seconds ago with no signup at all.

**What that turned up:** Two RLS insert policies (`leagues`, `league_members`) that had no legitimate caller in the actual app (confirmed by checking — every real write path uses the service-role client, which bypasses RLS entirely) but were still reachable by anyone hitting the Supabase REST API directly with the public anon key. One of them would have let *any* authenticated-or-anonymous session insert itself as `commissioner` into someone else's real league.

**Fix:** Locked both policies to service-role-only (`with check (false)`), matching the pattern already used elsewhere for tables that should only ever be written by trusted server code.

**Takeaway:** "Nobody calls this from the UI" is not the same as "nobody can call this." An RLS policy is reachable by anyone with the public anon key and *any* valid session, not just by the app's own frontend — and now that anonymous sessions are one click away with zero commitment, that pool of "anyone" got a lot bigger and easier to reach.

---

## 11. A demo-provisioning request that hung 30–45+ seconds, sometimes never resolving

**What broke:** Clicking "Try as Commissioner" (the flagship zero-signup demo entry point) sometimes took 30+ seconds and, at least once, never returned a response at all.

**How it was found:** Reproduced directly with a raw timed API call rather than guessing from the UI — confirmed a real multi-second-plus hang, not a one-off network blip.

**Root cause, two compounding issues:**
1. Seven "AI bot" league members were created with a sequential loop — `await`-ing each `auth.admin.createUser()` call one at a time instead of running them concurrently.
2. Far larger: after provisioning, the code called a scoring-recalculation service built for *incremental, real-time* updates during a live tournament — which does roughly 400 sequential database round-trips per invocation. Calling that synchronously, inline, in the middle of a user-facing request that's supposed to return in a couple of seconds, was enough on its own to blow past any reasonable timeout.

**Fix:** Parallelized the bot-member creation. Replaced the ~400-round-trip service call with an in-memory computation of the same scoring logic (same rules, applied to data already sitting in memory from the same function) followed by exactly two bulk database operations.

**Takeaway:** A service designed for one usage pattern (small incremental updates, called often) can be catastrophically wrong for another (one-time bulk computation, called once) — even though it's "the same logic" and produces the same correct result either way. The fix isn't "make the slow thing faster," it's recognizing the call site needed a fundamentally different approach (bulk/in-memory vs. incremental/round-trip-per-item).

---

## 12. AI advisor returning a "successful" empty response

**What broke:** The AI advisor UI would show "No advice available." after a several-second wait — worse than an error message, because it gives no indication anything went wrong versus just... not having an opinion.

**How it was found:** Reproduced live with a real-shaped request (the actual 50-player payload the real UI sends) — got back an HTTP `200` with a literal empty `{}` body. Not a rate limit (which returns a clear message), not a thrown exception (which was already logged) — a "successful" response with no usable content.

**Root cause:** The code assumed Claude's response content is always exactly one text block at index 0 (`message.content[0].text`), with no check that it actually is one. When that assumption doesn't hold, `.text` is `undefined`, `JSON.stringify` silently drops the key, and the client receives `{}` — no error, no log line, nothing to debug from after the fact. *(Root cause of why the assumption failed on this particular request is still unconfirmed — ran into the very rate limit described in #9 while trying to reproduce it further, which at least confirmed that protection works as designed.)*

**Fix:** Search the response's content array for an actual text block instead of assuming its position; if none exists, log the response's shape (stop reason + content block types) and return an honest error instead of a silent empty success.

**Takeaway:** The worst failure mode isn't an error — it's a "successful" response with nothing useful in it and nothing logged to explain why. Any code that assumes a specific shape from an external API's response should verify that shape, especially when the fallback path (an empty/default value) looks superficially fine and won't visibly break anything downstream.
