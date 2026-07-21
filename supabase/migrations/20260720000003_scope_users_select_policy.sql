-- Scopes the public.users SELECT policy, prompted by Supabase's own anonymous-auth
-- guidance: "Anonymous users will use the authenticated role when signing in... we
-- strongly advise reviewing your RLS policies." The prior policy
-- ("authenticated_users_can_select_users", migration 20260608000009) let ANY
-- authenticated session -- including a plain anonymous "Try as Commissioner" session,
-- which now exists specifically because of that same anonymous-auth flow, and now
-- also real Google-authenticated users -- read every user's display_name/avatar_url/
-- bio/notification_preferences, with zero scoping. No emails are exposed (this table
-- has no email column), so this was a profile-metadata leak, not a credential leak --
-- flagged but deliberately left unfixed during the original security pass as low
-- severity. Worth closing now that it's been raised directly.
--
-- Four legitimate read cases, each preserved explicitly (breaking any of these would
-- break real UI — verified locally before this migration was written, including a
-- real regression caught in the process: the STATIC seeded demo league
-- (00000000-0000-0000-0000-000000000001, the "View a completed season" page) has
-- ZERO league_members rows for its fictional managers — src/app/demo/league/page.tsx
-- resolves display names via leaderboard_snapshots.user_id, not league_members. A
-- policy scoped only to league_members would have silently blanked every manager
-- name on that page for anonymous viewers. Confirmed locally: the static demo
-- league's 8 seeded users have leaderboard_snapshots rows but no league_members rows,
-- while "Try as Commissioner" PROVISIONED demo leagues have both.
--
--   1. Your own profile.
--   2. A fellow member's profile in any league you belong to (get_my_league_ids(),
--      the existing SECURITY DEFINER helper from migration 20260608000012 — same
--      anti-recursion pattern already used elsewhere in this file's policies).
--   3. A member's profile in ANY demo league via league_members (is_demo = true) --
--      covers provisioned "Try as Commissioner" leagues, whose AI-pool members and
--      commissioner ARE real league_members rows.
--   4. A participant's profile in ANY demo league via leaderboard_snapshots
--      (is_demo = true) -- covers the static seeded league's fictional managers,
--      who exist only via scoring data, never league_members.

drop policy if exists "authenticated_users_can_select_users" on public.users;

create policy "users_can_select_own_shared_or_demo_profiles" on public.users
  for select using (
    id = auth.uid()
    or id in (
      select user_id from public.league_members
      where league_id in (select public.get_my_league_ids())
    )
    or id in (
      select lm.user_id
      from public.league_members lm
      join public.leagues l on l.id = lm.league_id
      where l.is_demo = true
    )
    or id in (
      select ls.user_id
      from public.leaderboard_snapshots ls
      join public.leagues l on l.id = ls.league_id
      where l.is_demo = true
    )
  );
