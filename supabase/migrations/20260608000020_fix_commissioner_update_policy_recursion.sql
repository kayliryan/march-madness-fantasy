-- Fix: "commissioners_can_update_leagues" (on leagues), and
-- "commissioners_can_create_update_draft_sessions" / "commissioners_can_update_draft_sessions"
-- (on draft_sessions) were missed by migration 20260608000013 — they still queried
-- public.league_members inline, which re-enters that table's RLS-protected SELECT
-- (users_can_select_league_members), whose "leagues where is_demo = true" branch
-- queries public.leagues again, producing "infinite recursion detected in policy
-- for relation leagues" (42P17) on any commissioner UPDATE to leagues/draft_sessions.
--
-- Fix: introduce a security-definer function (mirrors get_my_league_ids(), but
-- filtered to commissioner/co_commissioner roles) as the sole path into
-- league_members for these policies, bypassing RLS for the inner lookup.

create or replace function public.get_my_commissioner_league_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select league_id from public.league_members
  where user_id = auth.uid()
    and role in ('commissioner', 'co_commissioner');
$$;

drop policy if exists "commissioners_can_update_leagues" on public.leagues;
create policy "commissioners_can_update_leagues" on public.leagues
  for update using (
    commissioner_id = auth.uid()
    or id in (select get_my_commissioner_league_ids())
  );

drop policy if exists "commissioners_can_create_update_draft_sessions" on public.draft_sessions;
create policy "commissioners_can_create_update_draft_sessions" on public.draft_sessions
  for insert with check (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or league_id in (select get_my_commissioner_league_ids())
  );

drop policy if exists "commissioners_can_update_draft_sessions" on public.draft_sessions;
create policy "commissioners_can_update_draft_sessions" on public.draft_sessions
  for update using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or league_id in (select get_my_commissioner_league_ids())
  );
