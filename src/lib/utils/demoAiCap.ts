import { supabaseAdmin } from '@/lib/supabase/admin';

// Lets a known tester's real IP bypass the per-caller (not the global/per-league)
// caps below — set via DEMO_AI_CAP_BYPASS_IPS="1.2.3.4,5.6.7.8" in env vars, comma-
// separated, no spaces needed. Useful for verifying the live production advisor
// actually works end-to-end without burning down the same daily quota real visitors
// share. Does NOT affect the global daily cap or per-league cap — those still apply
// to everyone, since they're the actual cost backstop.
const BYPASS_IPS = new Set(
  (process.env.DEMO_AI_CAP_BYPASS_IPS ?? '').split(',').map((s) => s.trim()).filter(Boolean)
);

function isTrustedTestIp(ip: string | null): boolean {
  if (!ip || ip === 'unknown') return false;
  if (ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.')) return true;
  return BYPASS_IPS.has(ip);
}

// Sonnet pricing: ~$3/M input tokens, ~$15/M output tokens.
// Typical advisor call: ~3000 input + ~300 output tokens.
//   = (3000 × $0.000003) + (300 × $0.000015) = $0.009 + $0.0045 ≈ $0.014
// Range across context sizes: $0.01–$0.08; conservative avg $0.04.

// Layer 1 — per-demo-league cap:
//   Ceiling: $1.00 per demo league. $1.00 / $0.04 avg = 25 calls.
//   This cap is per-league, not per-member — all members of a demo league (the
//   original provisioner and anyone who joins via invite) draw from the same counter,
//   since the cap exists to bound cost for that demo league, not per individual viewer.
export const DEMO_AI_CAP_PER_LEAGUE = 25;

// Layer 2 — global concurrent active demo leagues:
//   50 leagues × $1.00 max AI spend = $50 max AI exposure from Layer 1 alone.
//   50 is enough headroom for realistic organic traffic.
export const DEMO_CONCURRENT_LEAGUE_CAP = 50;

// Layer 2 — per-IP provision rate:
//   Cost per provision: seed writes + up to $1.00 AI (Layer 1 ceiling) ≈ $1.01/session.
//   Tolerable daily spend per IP: $15.00 — raised from the original $2.00 launch-week
//   estimate now that the site is in active interview-season use: a single IP
//   legitimately re-provisions many times a day (Kayli iterating/dogfooding, Claude
//   Code's own browser-automation testing, and reviewers re-running the demo), not
//   just one-and-done candidate evaluation. $15.00 / $1.01 ≈ 14.85, rounded to 15.
//
//   NOTE: IP-based rate limiting has known gaps in both directions:
//   - False positives: corporate NAT puts many real reviewers behind one IP, potentially
//     blocking a legitimate hiring manager mid-evaluation.
//   - Easily bypassed: a motivated abuser can trivially rotate IPs via VPN or proxies.
//   This is why the concurrent-league cap (above), not the IP limit, is the actual
//   spend backstop for this feature. The IP limit is a secondary, best-effort signal.
export const DEMO_PROVISION_PER_IP_PER_DAY = 15;

// Layer 3 — global daily AI-call cap across all demo sessions:
//   Anthropic account is loaded with a hard $5.00/day budget (auto-reload off) for
//   this launch/testing window. $5.00 / $0.04 avg = 125 calls. This is the real,
//   account-enforced backstop — everything else here is defense-in-depth on top of it.
export const DEMO_AI_DAILY_CAP = 125;

// Layer 4 — per-IP cap specifically on AI advisor calls (separate from the Layer 2
// provision rate limit above, which only governs *creating* demo leagues). Without
// this, one caller could exhaust the entire shared daily pool above and make the
// advisor look "down" for every other visitor for the rest of the day. Set generously
// enough for a hiring manager to genuinely explore (ask ~15 questions across a full
// mock draft) while capping any single source well below the daily pool.
export const DEMO_AI_ADVISOR_CALLS_PER_IP_PER_DAY = 15;

export const DEMO_AI_CAP_MESSAGE =
  "You've reached today's AI advisor limit for this connection (this demo caps usage per visitor to keep things fair and control costs — not a bug). Feel free to keep drafting manually, or check back tomorrow!";

export const DEMO_AI_GLOBAL_CAP_MESSAGE =
  "The AI advisor has hit its shared usage limit for today across all visitors. This is a deliberate cost-control cap on this demo, not an error — it resets tomorrow. The rest of the site works normally.";

export const DEMO_AI_LEAGUE_CAP_MESSAGE =
  "This demo league has reached its AI advisor limit. This is an intentional per-league cap to control demo costs, not a bug — everything else in the league still works.";

// Real (non-demo) league cap:
//   Sonnet call ≈ $0.04 avg (see pricing comment above). Ceiling: $4.00/league/day.
//   $4.00 / $0.04 avg = 100 calls/day/league. A real family league (~8 members)
//   asking ~10 AI advisor questions each on draft night is ~80 calls — comfortably
//   under the cap. Unlike the demo caps above, this is the ONLY backstop for real
//   leagues, since they aren't covered by the demo global daily cap or IP limits.
export const REAL_LEAGUE_AI_DAILY_CAP = 100;

export const REAL_LEAGUE_AI_CAP_MESSAGE =
  "This league has reached its AI advisor limit for today. This is an intentional daily cap to control costs, not a bug — it resets tomorrow, and everything else in the league still works.";

export type DemoAiCapResult =
  | { allowed: true }
  | { allowed: false; reason: 'per_league' | 'daily_global' | 'ip_rate_limit'; message: string };

/**
 * Checks Layer 1 (per-league), Layer 3 (global daily), and Layer 4 (per-IP advisor
 * rate) caps before a demo AI call. If all pass, increments all relevant counters.
 * Pass league_id=null for stateless routes (mock-draft-advisor) — Layer 1 is skipped.
 * Pass ip=null to skip Layer 4 (only do this if the route can't determine an IP).
 */
export async function checkAndIncrementDemoAiCap(
  league_id: string | null,
  ip: string | null = null,
): Promise<DemoAiCapResult> {
  const today = new Date().toISOString().slice(0, 10);

  // Layer 1 check (per-league, only for demo leagues) — atomic increment-first via
  // the increment_demo_league_ai_usage() Postgres function, then deny if the
  // returned total exceeds the cap. No more read-then-absolute-update: that pattern
  // let parallel requests all read the same "current" value and lose updates. The
  // function only touches (and returns non-null for) rows where is_demo = true, so
  // this is a no-op for non-demo leagues — pass league_id=null entirely to skip it
  // for stateless routes (mock-draft-advisor).
  if (league_id !== null) {
    const { data: leagueCalls } = await supabaseAdmin.rpc('increment_demo_league_ai_usage', {
      p_league_id: league_id,
    });
    if (leagueCalls !== null && leagueCalls !== undefined && leagueCalls > DEMO_AI_CAP_PER_LEAGUE) {
      return { allowed: false, reason: 'per_league', message: DEMO_AI_LEAGUE_CAP_MESSAGE };
    }
  }

  // Layer 4 check (per-IP advisor call rate) — insert the log row first, then count
  // (including this row) and deny if over. This is bounded and race-safe: two
  // parallel requests each insert their own row, and each sees a count that
  // includes at least its own insert, so neither can under-count past the cap the
  // way a count-then-insert pattern could. A call denied by this check still
  // consumes a log slot — that's by design (fail-closed), not a bug: the cost of
  // slightly over-counting a rate limiter is negligible next to the cost of a
  // race letting unlimited calls through. Localhost and allowlisted tester IPs
  // skip this entirely.
  const isTrusted = isTrustedTestIp(ip);
  if (ip !== null && ip !== 'unknown' && !isTrusted) {
    await supabaseAdmin.from('demo_ai_call_log').insert({ ip });

    const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { count: ipCallCount } = await supabaseAdmin
      .from('demo_ai_call_log')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('called_at', since24h);

    if ((ipCallCount ?? 0) > DEMO_AI_ADVISOR_CALLS_PER_IP_PER_DAY) {
      return { allowed: false, reason: 'ip_rate_limit', message: DEMO_AI_CAP_MESSAGE };
    }
  }

  // Layer 3 check (global daily)
  const { data: dailyRow } = await supabaseAdmin
    .from('demo_ai_daily_usage')
    .select('calls_used')
    .eq('date', today)
    .maybeSingle();

  if ((dailyRow?.calls_used ?? 0) >= DEMO_AI_DAILY_CAP) {
    return { allowed: false, reason: 'daily_global', message: DEMO_AI_GLOBAL_CAP_MESSAGE };
  }

  // Atomic global daily increment via Postgres function
  await supabaseAdmin.rpc('increment_demo_daily_ai_usage', { p_date: today });

  return { allowed: true };
}

/**
 * Checks and increments the per-real-league daily AI advisor cap. Real (non-demo)
 * leagues aren't covered by any of the demo layers above (no global daily pool, no
 * IP rate limit) — this is their only cost backstop. Atomic increment-first via
 * increment_league_ai_usage(), then deny if the returned total exceeds the cap —
 * same race-free pattern as the demo Layer 1 fix above.
 */
export async function checkAndIncrementRealLeagueAiCap(league_id: string): Promise<DemoAiCapResult> {
  const today = new Date().toISOString().slice(0, 10);

  const { data: callsUsed } = await supabaseAdmin.rpc('increment_league_ai_usage', {
    p_league_id: league_id,
    p_date: today,
  });

  if (callsUsed !== null && callsUsed !== undefined && callsUsed > REAL_LEAGUE_AI_DAILY_CAP) {
    return { allowed: false, reason: 'per_league', message: REAL_LEAGUE_AI_CAP_MESSAGE };
  }

  return { allowed: true };
}

/**
 * Checks Layer 2: concurrent active demo leagues and per-IP provision rate.
 * Returns the failing constraint if either cap is hit.
 */
export async function checkDemoProvisionAllowed(
  ip: string,
): Promise<{ allowed: true } | { allowed: false; reason: 'concurrent_cap' | 'ip_rate_limit' }> {
  const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
  const now = new Date().toISOString();

  // The two counts are independent — run them in one parallel round trip instead
  // of two sequential ones (this is on the latency-critical provision path).
  // Localhost and allowlisted tester IPs skip the per-IP count entirely;
  // rate-limiting them defeats testing without providing any real abuse protection.
  const [{ count: activeLeagues }, ipCountResult] = await Promise.all([
    // Concurrent-league cap (primary backstop — not the IP limit)
    supabaseAdmin
      .from('leagues')
      .select('id', { count: 'exact', head: true })
      .eq('is_demo', true)
      .or(`demo_expires_at.is.null,demo_expires_at.gt.${now}`),
    // Per-IP rate limit (secondary signal — see NOTE on limitations above).
    isTrustedTestIp(ip)
      ? Promise.resolve(null)
      : supabaseAdmin
          .from('demo_provision_log')
          .select('id', { count: 'exact', head: true })
          .eq('ip', ip)
          .gte('provisioned_at', since24h),
  ]);

  // Check order preserved from the previous sequential version: the concurrent
  // cap (primary backstop) wins if both are exceeded.
  if ((activeLeagues ?? 0) >= DEMO_CONCURRENT_LEAGUE_CAP) {
    return { allowed: false, reason: 'concurrent_cap' };
  }

  if (ipCountResult !== null && (ipCountResult.count ?? 0) >= DEMO_PROVISION_PER_IP_PER_DAY) {
    return { allowed: false, reason: 'ip_rate_limit' };
  }

  return { allowed: true };
}

/**
 * Logs a provision event for per-IP rate tracking (call after successful provision).
 * Callers on the latency-critical path may fire-and-forget this (with .catch) —
 * it's a rate-limit log write, not a correctness gate. Throws on insert error so
 * a fire-and-forget .catch actually sees failures.
 */
export async function logDemoProvision(ip: string): Promise<void> {
  const { error } = await supabaseAdmin.from('demo_provision_log').insert({ ip });
  if (error) throw error;
}
