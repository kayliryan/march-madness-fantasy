-- Section 5: Add demo_expires_at to leagues table.
-- TTL rationale: a thorough reviewer takes ~2-3h to walk every page once;
-- 8h = 2-3h review × 2.5 safety buffer. The daily 3AM cron cleans up expired
-- leagues, so worst-case lifetime is 8h TTL + up to 24h before cron fires = ~32h.
-- This also bounds the Layer 2 concurrent-league cap accumulation in Section 4.
alter table leagues
  add column if not exists demo_expires_at timestamptz;

-- Backfill: existing demo leagues without a TTL get 8h from now so the cron
-- picks them up promptly the next time it runs.
update leagues
set demo_expires_at = now() + interval '8 hours'
where is_demo = true and demo_expires_at is null;

-- Update get_orphaned_demo_league_data to also return TTL-expired leagues.
-- A league is orphaned if:
--   (a) its commissioner's auth.users row is gone (existing condition), OR
--   (b) demo_expires_at is set and in the past — enforces TTL regardless of
--       whether Supabase Cloud anonymous-user auto-deletion is configured.
-- Both conditions skip leagues with a live draft in progress.
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
      and (
        -- Condition A: commissioner auth row gone (Supabase Cloud anonymous deletion)
        not exists (select 1 from auth.users au where au.id = l.commissioner_id)
        -- Condition B: TTL expired (always-enforced, doesn't rely on anonymous deletion)
        or (l.demo_expires_at is not null and l.demo_expires_at < now())
      )
      and not exists (
        select 1 from draft_sessions ds
        where ds.league_id = l.id and ds.status = 'live'
      );
end;
$$;
