-- Replace every inline league_members subquery across all RLS policies with
-- get_my_league_ids() so the security definer function is the sole path into
-- that table, eliminating infinite recursion.

-- ── LEAGUES ──────────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_their_leagues" on public.leagues;
create policy "users_can_select_their_leagues" on public.leagues
  for select using (
    id in (select get_my_league_ids())
    or is_demo = true
  );

drop policy if exists "commissioners_can_update_leagues" on public.leagues;
create policy "commissioners_can_update_leagues" on public.leagues
  for update using (
    commissioner_id = auth.uid()
    or id in (
      select lm.league_id from public.league_members lm
      where lm.user_id = auth.uid()
        and lm.role in ('commissioner', 'co_commissioner')
    )
  );

-- ── LEAGUE_INVITES ────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_league_invites" on public.league_invites;
create policy "users_can_select_league_invites" on public.league_invites
  for select using (
    league_id in (select get_my_league_ids())
    or invited_email = (auth.jwt() ->> 'email')
  );

-- ── DRAFT_SESSIONS ────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_draft_sessions" on public.draft_sessions;
create policy "users_can_select_draft_sessions" on public.draft_sessions
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );

drop policy if exists "commissioners_can_create_update_draft_sessions" on public.draft_sessions;
create policy "commissioners_can_create_update_draft_sessions" on public.draft_sessions
  for insert with check (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or league_id in (
      select lm.league_id from public.league_members lm
      where lm.user_id = auth.uid()
        and lm.role in ('commissioner', 'co_commissioner')
    )
  );

drop policy if exists "commissioners_can_update_draft_sessions" on public.draft_sessions;
create policy "commissioners_can_update_draft_sessions" on public.draft_sessions
  for update using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or league_id in (
      select lm.league_id from public.league_members lm
      where lm.user_id = auth.uid()
        and lm.role in ('commissioner', 'co_commissioner')
    )
  );

-- ── DRAFT_PICKS ───────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_draft_picks" on public.draft_picks;
create policy "users_can_select_draft_picks" on public.draft_picks
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );

-- ── ROSTER_SLOTS ──────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_roster_slots" on public.roster_slots;
create policy "users_can_select_roster_slots" on public.roster_slots
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );

-- ── SCORING_EVENTS ────────────────────────────────────────────────────────────
drop policy if exists "users_can_select_scoring_events" on public.scoring_events;
create policy "users_can_select_scoring_events" on public.scoring_events
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );

-- ── LEADERBOARD_SNAPSHOTS ─────────────────────────────────────────────────────
drop policy if exists "users_can_select_leaderboard_snapshots" on public.leaderboard_snapshots;
create policy "users_can_select_leaderboard_snapshots" on public.leaderboard_snapshots
  for select using (
    league_id in (select get_my_league_ids())
    or league_id in (select id from public.leagues where is_demo = true)
  );

-- ── BENCH_ORDERS ──────────────────────────────────────────────────────────────
drop policy if exists "users_can_view_bench_orders" on public.bench_orders;
create policy "users_can_view_bench_orders" on public.bench_orders
  for select using (
    user_id = auth.uid()
    or league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or (league_id in (select get_my_league_ids()) and locked_at is not null)
  );

-- ── TIMER_EXTENSIONS ──────────────────────────────────────────────────────────
drop policy if exists "users_can_select_timer_extensions" on public.timer_extensions;
create policy "users_can_select_timer_extensions" on public.timer_extensions
  for select using (
    draft_session_id in (
      select id from public.draft_sessions
      where league_id in (select get_my_league_ids())
    )
  );

-- ── LEAGUE_NOTIFICATIONS ──────────────────────────────────────────────────────
drop policy if exists "users_can_select_league_notifications" on public.league_notifications;
create policy "users_can_select_league_notifications" on public.league_notifications
  for select using (
    league_id in (select get_my_league_ids())
  );
