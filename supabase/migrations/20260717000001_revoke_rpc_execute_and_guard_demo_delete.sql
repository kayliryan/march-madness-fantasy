-- Security fix: Postgres grants EXECUTE on newly-created functions to PUBLIC by
-- default. None of the SECURITY DEFINER functions below ever had that default
-- revoked, which means they were directly callable by anon/authenticated over
-- PostgREST at POST /rest/v1/rpc/<function_name> using nothing but the public
-- anon key -- completely bypassing the app-layer checks (commissioner-only,
-- rate limits, cron-lock ownership, etc.) that were supposed to gate them.
--
-- Concretely, before this migration, anyone with the anon key could:
--   - delete_orphaned_demo_leagues(uuid[])  -> permanently delete ANY league
--     (demo or not), since the function never checked is_demo on the rows
--     it deletes.
--   - provision_demo_league(...)            -> spam-create demo leagues with
--     an arbitrary p_commissioner_id, injecting leagues into real users'
--     accounts and bypassing every app-layer rate limit.
--   - acquire_cron_lock(...)                -> hold the sync-scores /
--     demo-cleanup cron lock forever in a loop, starving both crons.
--   - increment_demo_daily_ai_usage(...)    -> spam the global daily AI
--     counter to fake "at capacity" for every visitor.
--   - get_orphaned_demo_league_data() /
--     delete_orphaned_demo_users(uuid[])    -> read/delete data that should
--     only ever be touched by the service-role cron.
--
-- Fix has two parts:
--   1. REVOKE EXECUTE from PUBLIC/anon/authenticated on all six functions.
--      Every legitimate caller of these already goes through supabaseAdmin.rpc()
--      (service role / postgres owner), which is unaffected by these grants --
--      GRANT/REVOKE on EXECUTE only gates PostgREST's anon/authenticated roles.
--   2. Defense-in-depth for delete_orphaned_demo_leagues specifically: even a
--      trusted service-role caller could pass in non-demo league_ids by mistake
--      (or via a compromised code path), so the function body itself now filters
--      p_league_ids down to is_demo = true rows before doing anything destructive.
--
-- Deliberately NOT touched: get_my_league_ids(), get_my_commissioner_league_ids(),
-- handle_new_user(), and moddatetime/trigger functions. The first two run inside
-- RLS policies with the invoking (anon/authenticated) user's own privileges --
-- revoking PUBLIC execute on them would break every RLS-gated query in the app.

-- ── 1. Revoke PostgREST-reachable EXECUTE ──────────────────────────────────

revoke execute on function public.delete_orphaned_demo_leagues(uuid[])
  from public, anon, authenticated;

revoke execute on function public.provision_demo_league(uuid, uuid[], text[], uuid[], int)
  from public, anon, authenticated;

revoke execute on function public.acquire_cron_lock(text, text)
  from public, anon, authenticated;

revoke execute on function public.increment_demo_daily_ai_usage(date)
  from public, anon, authenticated;

revoke execute on function public.get_orphaned_demo_league_data()
  from public, anon, authenticated;

revoke execute on function public.delete_orphaned_demo_users(uuid[])
  from public, anon, authenticated;

-- ── 2. Defense-in-depth: is_demo guard inside delete_orphaned_demo_leagues ──
-- Body copied verbatim from 20260608000017_delete_orphaned_demo_leagues.sql
-- (never replaced by a later migration), with one line added at the top that
-- filters p_league_ids down to demo leagues only. FK-safe delete order preserved.

create or replace function delete_orphaned_demo_leagues(p_league_ids uuid[])
returns void
language plpgsql
security definer
as $$
begin
  -- Defense-in-depth: even though EXECUTE is now revoked from anon/authenticated
  -- (this function is only reachable via supabaseAdmin.rpc()), never let a caller
  -- -- trusted or not -- delete a real (non-demo) league through this path.
  p_league_ids := array(
    select id from public.leagues where id = any(p_league_ids) and is_demo = true
  );

  -- p_league_ids must not be empty; empty array is a no-op (safe but unintended).
  delete from scoring_events where league_id = any(p_league_ids);
  delete from timer_extensions where draft_session_id in (
    select id from draft_sessions where league_id = any(p_league_ids)
  );
  delete from draft_picks where league_id = any(p_league_ids);
  delete from draft_queues where league_id = any(p_league_ids);
  delete from roster_slots where league_id = any(p_league_ids);
  delete from bench_orders where league_id = any(p_league_ids);
  delete from leaderboard_snapshots where league_id = any(p_league_ids);
  delete from league_notifications where league_id = any(p_league_ids);
  delete from league_invites where league_id = any(p_league_ids);
  delete from league_members where league_id = any(p_league_ids);
  delete from draft_sessions where league_id = any(p_league_ids);
  delete from leagues where id = any(p_league_ids);
end;
$$;

-- CREATE OR REPLACE does not reset grants, but the REVOKE above was already run
-- against this function's exact signature in this same migration, so re-stating
-- it here is redundant -- kept anyway as a belt-and-suspenders guard in case a
-- future edit reorders these statements.
revoke execute on function public.delete_orphaned_demo_leagues(uuid[])
  from public, anon, authenticated;
