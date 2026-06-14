-- Section 14.5 Migration 3: identifies provisioned demo leagues whose anonymous
-- commissioner session has been auto-deleted by Supabase (24h anonymous user
-- expiry), or whose commissioner abandoned the session entirely.
-- Requires function owner (postgres role) to have SELECT on auth.users.
-- In Supabase this is true by default. Verify on custom Postgres setups.
create or replace function get_orphaned_demo_league_data()
returns table(league_id uuid, ai_member_user_id uuid)
language plpgsql
security definer
as $$
begin
  return query
    select l.id as league_id, lm.user_id as ai_member_user_id
    from leagues l
    join league_members lm on lm.league_id = l.id
    join users u on u.id = lm.user_id
    where l.is_demo = true
      and u.is_ai_member = true
      -- Query auth.users directly: authoritative source for anonymous user deletion.
      -- Does not depend on cascade from auth.users to public.users.
      and not exists (select 1 from auth.users au where au.id = l.commissioner_id)
      and not exists (
        select 1 from draft_sessions ds
        where ds.league_id = l.id and ds.status = 'live'
      );
end;
$$;
