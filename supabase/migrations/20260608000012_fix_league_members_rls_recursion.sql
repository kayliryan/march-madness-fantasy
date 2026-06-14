-- Fix: league_members SELECT policy was self-referential, causing infinite recursion
-- when any other table's RLS policy queried league_members.
-- Solution: security definer function bypasses RLS for the inner lookup.

create or replace function public.get_my_league_ids()
returns setof uuid
language sql
security definer
stable
set search_path = public
as $$
  select league_id from public.league_members where user_id = auth.uid();
$$;

drop policy if exists "users_can_select_league_members" on public.league_members;

create policy "users_can_select_league_members" on public.league_members
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );
