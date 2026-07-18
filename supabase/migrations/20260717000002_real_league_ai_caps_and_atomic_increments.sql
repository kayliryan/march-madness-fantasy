-- AI cost-protection follow-up (Section 4 addendum):
--
-- Problem 1: real (non-demo) leagues had ZERO AI rate limiting — draft-advisor and
-- standings-narrator only checked the demo cap when leagues.is_demo = true. Adds a
-- per-league daily cap table + atomic increment function for real leagues.
--
-- Problem 2: checkAndIncrementDemoAiCap's Layer 1 (leagues.demo_ai_calls_used) did a
-- read-then-absolute-update, which loses updates under concurrent requests. Adds an
-- atomic increment function mirroring increment_demo_daily_ai_usage (20260615000003).
--
-- Cap math for real leagues (Sonnet call ≈ $0.04 avg — see demoAiCap.ts comments):
--   REAL_LEAGUE_AI_DAILY_CAP = 100 calls/day/league → worst case $4.00/league/day.
--   A real family league (~8 members) asking ~10 questions each on draft night is
--   ~80 calls — comfortably under the cap without materially exposing spend.

-- ── Problem 1: per-real-league daily AI usage table ────────────────────────

create table if not exists league_ai_daily_usage (
  league_id uuid not null references leagues(id) on delete cascade,
  date date not null,
  calls_used int not null default 0,
  primary key (league_id, date)
);

-- RLS enabled with NO policies — deny-all via PostgREST, matching the existing
-- demo_ai_daily_usage / demo_provision_log pattern (20260615000003). Only the
-- service-role client (which bypasses RLS) and the SECURITY DEFINER function
-- below ever touch this table.
alter table league_ai_daily_usage enable row level security;

-- Atomic per-league daily increment: INSERT ... ON CONFLICT ... DO UPDATE is a
-- single serializable Postgres statement — no read-then-write race. Returns the
-- new total for (league_id, date).
create or replace function increment_league_ai_usage(p_league_id uuid, p_date date)
returns int
language plpgsql security definer as $$
declare
  v_calls int;
begin
  insert into league_ai_daily_usage (league_id, date, calls_used)
  values (p_league_id, p_date, 1)
  on conflict (league_id, date) do update
    set calls_used = league_ai_daily_usage.calls_used + 1
  returning calls_used into v_calls;
  return v_calls;
end;
$$;

-- ── Problem 2: atomic per-demo-league increment (fixes Layer 1 TOCTOU) ─────

-- Atomic demo-league call counter increment. Only increments (and returns non-null)
-- when the target row is actually a demo league — mirrors the existing
-- `.eq('is_demo', true)` guard in the old read-then-update code. Returns NULL (no
-- row updated) if the league isn't a demo league or doesn't exist.
create or replace function increment_demo_league_ai_usage(p_league_id uuid)
returns int
language plpgsql security definer as $$
declare
  v_calls int;
begin
  update leagues
    set demo_ai_calls_used = coalesce(demo_ai_calls_used, 0) + 1
  where id = p_league_id and is_demo = true
  returning demo_ai_calls_used into v_calls;
  return v_calls;
end;
$$;

-- ── Lock down EXECUTE ───────────────────────────────────────────────────────
-- These functions are SECURITY DEFINER and mutate cost-control counters directly
-- (bypassing RLS) — only the service-role client (used exclusively by demoAiCap.ts
-- server-side) should ever invoke them. PostgreSQL grants EXECUTE on newly created
-- functions to PUBLIC by default, which would let anon/authenticated call these
-- directly via PostgREST RPC and manipulate usage counters. Revoke that.
revoke execute on function increment_league_ai_usage(uuid, date) from public, anon, authenticated;
revoke execute on function increment_demo_league_ai_usage(uuid) from public, anon, authenticated;
