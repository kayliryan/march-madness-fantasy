import { supabaseAdmin } from '@/lib/supabase/client';

// Sonnet 4.6 pricing: $3/M input tokens, $15/M output tokens.
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
//   Tolerable daily spend per IP: $2.00. $2.00 / $1.01 ≈ 2 provisions.
//   Bumped to 5 to tolerate corporate NAT (multiple real reviewers sharing one IP).
//
//   NOTE: IP-based rate limiting has known gaps in both directions:
//   - False positives: corporate NAT puts many real reviewers behind one IP, potentially
//     blocking a legitimate hiring manager mid-evaluation.
//   - Easily bypassed: a motivated abuser can trivially rotate IPs via VPN or proxies.
//   This is why the concurrent-league cap (above), not the IP limit, is the actual
//   spend backstop for this feature. The IP limit is a secondary, best-effort signal.
export const DEMO_PROVISION_PER_IP_PER_DAY = 5;

// Layer 3 — global daily AI-call cap across all demo sessions:
//   Tolerable daily spend on this feature: $20.00. $20.00 / $0.04 avg = 500 calls.
//   This covers the case where many IPs each stay under their per-IP limit but
//   collectively drive unbounded cumulative spend (distributed low-and-slow, or simply
//   high organic traffic with leagues provisioned and abandoned in sequence).
export const DEMO_AI_DAILY_CAP = 500;

export const DEMO_AI_CAP_MESSAGE = "You've used your demo AI queries for this session.";

export type DemoAiCapResult =
  | { allowed: true }
  | { allowed: false; reason: 'per_league' | 'daily_global' };

/**
 * Checks Layer 1 (per-league) and Layer 3 (global daily) caps before a demo AI call.
 * If both pass, increments both counters.
 * Pass league_id=null for stateless routes (mock-draft-advisor) — Layer 1 is skipped.
 */
export async function checkAndIncrementDemoAiCap(
  league_id: string | null,
): Promise<DemoAiCapResult> {
  const today = new Date().toISOString().slice(0, 10);

  // Layer 1 check (per-league, only for demo leagues)
  let isDemo = false;
  let currentLeagueCalls = 0;

  if (league_id !== null) {
    const { data: leagueRow } = await supabaseAdmin
      .from('leagues')
      .select('is_demo, demo_ai_calls_used')
      .eq('id', league_id)
      .single();

    if (leagueRow?.is_demo) {
      isDemo = true;
      currentLeagueCalls = leagueRow.demo_ai_calls_used ?? 0;
      if (currentLeagueCalls >= DEMO_AI_CAP_PER_LEAGUE) {
        return { allowed: false, reason: 'per_league' };
      }
    }
  }

  // Layer 3 check (global daily)
  const { data: dailyRow } = await supabaseAdmin
    .from('demo_ai_daily_usage')
    .select('calls_used')
    .eq('date', today)
    .maybeSingle();

  if ((dailyRow?.calls_used ?? 0) >= DEMO_AI_DAILY_CAP) {
    return { allowed: false, reason: 'daily_global' };
  }

  // Both checks passed — increment counters after the AI call succeeds
  // (increments fire after this function returns; the caller is responsible)
  if (league_id !== null && isDemo) {
    await supabaseAdmin
      .from('leagues')
      .update({ demo_ai_calls_used: currentLeagueCalls + 1 })
      .eq('id', league_id)
      .eq('is_demo', true);
  }

  // Atomic global daily increment via Postgres function
  await supabaseAdmin.rpc('increment_demo_daily_ai_usage', { p_date: today });

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

  // Concurrent-league cap (primary backstop — not the IP limit)
  const { count: activeLeagues } = await supabaseAdmin
    .from('leagues')
    .select('id', { count: 'exact', head: true })
    .eq('is_demo', true)
    .or(`demo_expires_at.is.null,demo_expires_at.gt.${now}`);

  if ((activeLeagues ?? 0) >= DEMO_CONCURRENT_LEAGUE_CAP) {
    return { allowed: false, reason: 'concurrent_cap' };
  }

  // Per-IP rate limit (secondary signal — see NOTE on limitations above).
  // Localhost is always the developer; rate-limiting it defeats testing without
  // providing any abuse protection (local requests can't come from external attackers).
  const isLocalhost =
    ip === '::1' || ip === '127.0.0.1' || ip.startsWith('::ffff:127.');

  if (!isLocalhost) {
    const { count: ipCount } = await supabaseAdmin
      .from('demo_provision_log')
      .select('id', { count: 'exact', head: true })
      .eq('ip', ip)
      .gte('provisioned_at', since24h);

    if ((ipCount ?? 0) >= DEMO_PROVISION_PER_IP_PER_DAY) {
      return { allowed: false, reason: 'ip_rate_limit' };
    }
  }

  return { allowed: true };
}

/** Logs a provision event for per-IP rate tracking (call after successful provision). */
export async function logDemoProvision(ip: string): Promise<void> {
  await supabaseAdmin.from('demo_provision_log').insert({ ip });
}
