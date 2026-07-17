# Implementation Spec: Logged-Out Demo Experience Redesign

## Goal
A hiring manager who will not create a real account should be able to see the full depth of what a real logged-in family member has access to, with no functionality hidden, and with cost/abuse risk bounded regardless of how the feature is discovered or scripted.

This spec went through four rounds of audit. Read it in full before implementing — several decisions here correct earlier instincts that turned out to be wrong on closer inspection (e.g., grayed-out UI being worse than functional-with-disclosed-stub; per-member caps being worse than per-league caps).

---

## 1. Homepage Restructure

- **One primary CTA:** "Explore as Commissioner — see everything, no signup." On click, show a brief skeleton/preview animation (dashboard glimpse) during the provisioning wait rather than a blank spinner. Provisioning is already under 5 seconds.
- **One secondary, smaller link below it:** "Just want to see the data? View a completed season" → static round-by-round demo standings page, no provisioning required, instant load.
- **Mock draft** demoted to a secondary/footer link — no longer a homepage-level CTA, since the provisioned commissioner flow already includes a real draft room with real AI-controlled opponents.

---

## 2. The Three-Category Mutation Rule

Every feature in the demo experience falls into exactly one of three categories. Audit every feature against this list explicitly during implementation — do not default anything into "hidden" just because it's inconvenient to support.

**Category A — Internal mutation** (affects only the demo league's own data: draft picks, bench order, league settings, score corrections, starting a draft): always fully functional, no restriction, no cap.

**Category B — External call with controllable, bounded cost** (AI draft advisor, AI standings narrator): always fully functional and live — never stubbed, since this is the most impressive feature to show off. Gated only by the usage caps in Section 4 below.

**Category C — External call with an irreversible real-world effect on a third party** (sending real invite emails): fully functional internal state change, but the irreversible side-effect is stubbed and visibly disclosed to the user — never silently swallowed, never hidden behind a grayed-out field (grayed-out reads as "broken," not "intentional").

**Hidden entirely** is reserved only for features with no meaningful internal behavior in a single-league demo context (e.g., cross-league commissioner tools, billing/payment settings if those ever exist). Audit explicitly for these.

---

## 3. Invites (Category C) — Real Link, Member-Only Join, Stubbed Email

- Generate a real, working invite link scoped to the demo league.
- Suppress only the email dispatch (the Resend API call), with inline copy: "Invite link generated — email delivery is simulated in demo mode. Copy the link below to test joining as a second member."
- **Anyone who joins via the link gets `member` role, never `commissioner`.** This matches real product permissions exactly, demonstrates the actual permission model, and eliminates the risk of a second anonymous tab-opener having commissioner tools (renaming teams, voiding picks, editing settings) before the original viewer finishes evaluating the app.
- This means two anonymous users can have simultaneous write access to the same demo league (commissioner-role provisioner + member-role joiner). See Section 6 for required concurrency testing on this specific path.

---

## 4. AI Advisor Usage Caps (Category B) — Three-Layer Defense, All Server-Side

**Cost reference:** Based on current Anthropic pricing (Sonnet 4.6: $3/$15 per million input/output tokens), a typical AI draft advisor call costs approximately $0.01–$0.08 depending on context size. Use this to justify the specific cap numbers chosen below — show the calculation in code comments, don't pick round numbers by convention.

### Layer 1 — Per-league AI usage cap

- The cap is **per-league, not per-member**. All members of a demo league (the original provisioner and anyone who joins via the invite link from Section 3) draw from the same shared cap, since the cap exists to bound total cost for that demo league, not cost per individual viewer. State this explicitly in the implementation — do not leave it as an implicit consequence of how the counter happens to be keyed.
- Track the call count server-side, keyed to the demo `league_id` (a counter column on the `leagues` row, or a `demo_ai_usage` table keyed by `league_id`) — never a client-side counter, never anything stored only in the browser.
- Refreshing the page, clearing local storage, reopening the tab, or a second member joining must NOT reset or duplicate the cap, because it's tied to the persistent server-side record for that league.
- Calculate the cap number from the cost reference above and a tolerable per-demo-league spend ceiling (e.g., if tolerable spend per demo league is $1.00 and average call cost is $0.04, the cap is ~25 calls). Show this math in a code comment next to the constant.
- When the cap is reached, show this exact disclosed message and stop there — no call to action, no suggestion to provision again (that nudges toward the exact provision-spam behavior Layer 2 defends against), no unverified product claims:
  ```
  "You've used your demo AI queries for this session."
  ```

### Layer 2 — Provision rate limit + global concurrent-league cap

- Layer 1 alone is insufficient: a scripted attacker can call `POST /api/demo/provision` repeatedly to mint a fresh `league_id` every time, getting a fresh Layer 1 cap on every call.
- **The global concurrent-active-demo-league cap is the primary backstop for this entire feature**, not a secondary signal to the per-IP limit. Implement this as a hard ceiling on the count of currently-active (non-expired, non-cleaned-up) demo leagues system-wide. When hit, new provisioning requests are rejected — see Section 7 for the required failure-state UX.
- The per-IP rate limit is a secondary, documented-as-insufficient-alone signal. Calculate it from the cost reference above (estimated cost per provision = seed writes + plausible Layer 1 AI usage within the cap, multiplied by a tolerable daily spend per IP) and show the math rather than asserting a number.
- Document explicitly in code comments: IP-based limiting alone has known gaps in both directions — corporate NAT causes false positives (one hiring manager's company network blocking real reviewers who share an IP), and a motivated abuser can trivially bypass IP limits with rotating proxies or VPN exit nodes. This is why the concurrent-league cap, not the IP limit, is the actual backstop.

### Layer 3 — Global daily AI-call spend ceiling

- Neither Layer 1 (per-league) nor Layer 2 (per-IP + concurrent-league) bounds the case where many different IPs each individually stay under their own limits but collectively drive unbounded cumulative spend over a day — a distributed low-and-slow pattern, or simply high organic traffic on a popular day, with leagues provisioned and abandoned in sequence rather than held open simultaneously.
- Implement a global daily cap on total AI advisor calls across all demo sessions combined, independent of league count or IP. Once hit, stop serving new AI advisor responses for the remainder of the day across all demo leagues — show the same disclosed "You've used your demo AI queries for this session" message rather than failing with a generic error.
- Calculate this number from the cost reference above and a tolerable total daily spend on this feature (e.g., if tolerable daily spend is $20 and average call cost is $0.04, the daily cap is ~500 calls). Show this math in a code comment.

---

## 5. Demo Session TTL — Verify Before Writing Copy, Fix If Missing, Justify the Number

- Before adding any user-facing text about session duration, **verify the actual enforced TTL** in the existing Section 14 implementation — check the Supabase anonymous user auto-deletion setting and the cleanup cron's actual behavior. Report what you find before proceeding.
- **If verification reveals there is no enforced TTL** (anonymous users or demo leagues persist indefinitely until a manual cleanup job happens to run), the correct fix is to **implement an actual enforced TTL first** — do not write copy describing a TTL that doesn't exist. An unenforced cleanup policy is itself a resource-accumulation risk that compounds the Layer 1 cap-bypass risk in Section 4 (abandoned demo sessions with unused AI usage cap headroom accumulating forever).
- If a TTL must be implemented from scratch, the value needs a stated basis, not a round number chosen by convention: long enough to cover a thorough reviewer reading every page once in a single sitting (a few hours is generous), short enough to bound storage and compute accumulation between cleanup cron runs. Calculate and document this the same way the AI usage cap and rate limit numbers are calculated and documented.
- Only write session-duration copy once the TTL is confirmed to be actually enforced, and make the copy match the verified behavior exactly.

---

## 6. Demo League Seed Data + Required Concurrency Testing

- One fully-seeded season with complete round-by-round history (using the same Round-by-Round component already built and used for real logged-in leagues, not the old deprecated flat-table implementation), using realistic fictional manager and player names — not real players, not your family's real names.
- Include deliberate edge cases in the seed data to demonstrate engineering maturity to a reviewer who pokes at corner cases:
  - A tied score scenario between two managers
  - At least one injured/benched player
  - At least one eliminated team with no eligible bench replacement remaining (the existing "no eligible sub" path in `BenchOrderService`)
- A second season entry that is visibly present in the UI (season switcher shows "2 seasons" / "Season 1 of 2 — view archive") but minimally seeded — just enough data to prove the multi-season capability exists, not a full duplicate seed effort.
- **Required test before launch:** the seeded edge cases (especially the eliminated-team-no-sub-available state) are boundary conditions by design, and combined with the two-anonymous-members-with-write-access path from Section 3, they are the most likely place a careful reviewer triggers a concurrency bug. Explicitly test: two anonymous members (commissioner + joined member) both attempting a bench move or pick void on the same eliminated-team-no-sub roster slot at the same time. Confirm the existing optimistic locking (the same mechanism real leagues already rely on for concurrent edits) produces a clean 409/conflict response for the loser of the race — not a corrupted state, not silent data loss. This needs its own explicit test pass; "concurrency generally works" is not sufficient confirmation for this specific intersection.

---

## 7. Provisioning Failure State — Explicit Design Required

The primary homepage CTA funnels essentially all interested visitors through a single action. Its failure state must be explicitly designed, not left as a generic error, because it is the highest-stakes failure path in the entire plan.

Specify exact behavior for each failure mode:

- **Global concurrent-league cap hit (Section 4, Layer 2):** "We're at capacity for live demos right now. Try again in a moment, or view a completed season instead" — with a direct, prominent link to the static demo standings page (Section 1's secondary CTA).
- **Per-IP rate limit hit (Section 4, Layer 2):** same message pattern and same fallback link — never a dead end.
- **Network or transient error:** standard retry affordance, with the same static-page fallback link visible alongside it.

In all three cases, the visitor must never see a blank failure with no path forward. The static demo standings page (already built, already fast, requires no provisioning) is the universal fallback for every failure mode on the primary CTA.

---

## 8. Navigation Fix

Every page in the app, logged in or logged out, must have a persistent way back to the homepage (the logo in the header, linking to `/`). Currently missing specifically on the mock draft page — this becomes more important now that mock draft is demoted to a secondary/footer link rather than a homepage CTA, since visitors reaching it are no longer one tap from the page they started on.

---

## Build Order

1. Section 8 (navigation fix) — trivial, do first
2. Section 5 (TTL verification and fix if needed) — must happen before any session-duration copy is written anywhere else in this spec
3. Section 4 (three-layer AI cost defense) — must be in place before Section 1's primary CTA is promoted to the homepage, since promoting it increases expected traffic to the feature this section protects
4. Section 7 (provisioning failure states) — depends on Section 4's caps existing to have failure modes to handle
5. Section 1 (homepage restructure) — now safe to promote the primary CTA since cost/abuse protections are in place
6. Section 3 (invites — real link, member-only join)
7. Section 6 (seed data + concurrency test) — concurrency test depends on Section 3's member-join path existing
8. Section 2 (mutation rule audit) — final pass confirming every feature in the demo experience has been explicitly categorized, nothing defaulted to hidden without justification

## Reporting

After each numbered section, report: what was built or verified, what numbers were calculated and why (caps, TTL, rate limits), and confirm `npx tsc --noEmit` and `npx eslint` are clean before moving to the next section.
