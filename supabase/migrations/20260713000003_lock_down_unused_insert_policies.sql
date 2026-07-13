-- Anonymous sign-ins use the same `authenticated` Postgres role as real signed-up
-- users for RLS purposes (per Supabase's own anonymous-auth guidance). Auditing all
-- write policies under that lens surfaced two that are pure latent attack surface:
--
-- 1. "authenticated_users_can_create_leagues" — allowed any authenticated session
--    (auth.uid() is not null) to insert directly into public.leagues via the anon key,
--    no restriction on commissioner_id or any other field.
-- 2. "users_can_insert_league_members" — allowed any authenticated session to insert
--    itself into league_members for ANY league_id with ANY role (including
--    'commissioner'), no scoping to that league at all.
--
-- Neither is used by the app: POST /api/league and every membership-creation path
-- (invite accept, demo provisioning) write through supabaseAdmin (service role),
-- which bypasses RLS entirely. These policies only mattered as a hole a malicious
-- client could exploit by calling the Supabase REST API directly with the public
-- anon key -- e.g. self-inserting as 'commissioner' into someone else's real league.
-- Now that "Try as Commissioner" hands out a fully-authenticated session to any
-- anonymous visitor with one click, this became a much easier hole to reach.
--
-- Locking both down to service-role-only, matching the existing pattern already used
-- for players/teams/scoring_events/leaderboard_snapshots.

drop policy if exists "authenticated_users_can_create_leagues" on public.leagues;
create policy "service_role_only_insert_leagues" on public.leagues
  for insert with check (false);

drop policy if exists "users_can_insert_league_members" on public.league_members;
create policy "service_role_only_insert_league_members" on public.league_members
  for insert with check (false);
