-- Mirrors what an auth.users -> public.users ON DELETE CASCADE would do if such
-- an FK existed (it doesn't — public.users.id has no FK to auth.users). Called by
-- /api/cron/demo-cleanup after delete_orphaned_demo_leagues, for AI member ids
-- (whose auth.users rows it just deleted via admin.deleteUser) and the commissioner
-- id (whose auth.users row get_orphaned_demo_league_data already confirmed is gone).
-- Requires function owner (postgres role) to have SELECT on auth.users.
create or replace function delete_orphaned_demo_users(p_user_ids uuid[])
returns void
language plpgsql
security definer
as $$
begin
  delete from public.users
  where id = any(p_user_ids)
    and not exists (select 1 from auth.users au where au.id = public.users.id);
end;
$$;
