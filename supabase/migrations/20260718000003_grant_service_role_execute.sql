-- HOTFIX for a production regression introduced by 20260717000001 / 20260717000002.
--
-- Those migrations did `REVOKE EXECUTE ... FROM PUBLIC, anon, authenticated` on
-- the service-role-only RPCs, to close a hole where anon could call them over
-- PostgREST. That was correct — BUT on the production database `service_role`
-- was inheriting its EXECUTE privilege *through* the PUBLIC grant, not via a
-- direct grant of its own. Revoking from PUBLIC therefore also stripped
-- service_role, so every `supabaseAdmin.rpc(...)` call started failing with
-- `42501 permission denied` the moment those migrations were pushed to prod:
--   - provision_demo_league        -> "Explore as Commissioner" 500s (demo dead)
--   - acquire_cron_lock            -> both cron jobs can't run
--   - get_orphaned_demo_league_data / delete_orphaned_demo_users -> demo cleanup dead
--   - increment_demo_daily_ai_usage / increment_league_ai_usage /
--     increment_demo_league_ai_usage -> every AI advisor call 500s
--
-- (This did not surface on local Supabase because the local role setup grants
-- service_role EXECUTE directly, independent of PUBLIC.)
--
-- Fix: grant EXECUTE explicitly to service_role — and ONLY service_role, so the
-- security intent of the revoke migrations (anon/authenticated cannot call
-- these) is fully preserved. Idempotent: a no-op wherever service_role already
-- has the grant (e.g. local).

grant execute on function public.provision_demo_league(uuid, uuid[], text[], uuid[], int) to service_role;
grant execute on function public.delete_orphaned_demo_leagues(uuid[]) to service_role;
grant execute on function public.acquire_cron_lock(text, text) to service_role;
grant execute on function public.increment_demo_daily_ai_usage(date) to service_role;
grant execute on function public.get_orphaned_demo_league_data() to service_role;
grant execute on function public.delete_orphaned_demo_users(uuid[]) to service_role;
grant execute on function public.increment_league_ai_usage(uuid, date) to service_role;
grant execute on function public.increment_demo_league_ai_usage(uuid) to service_role;
