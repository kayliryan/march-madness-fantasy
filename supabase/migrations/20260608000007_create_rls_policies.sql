-- Row Level Security Policies for all tables
-- As per Section 6.2 of the design document

-- ====== USERS TABLE ======
-- No RLS needed for users table as it's typically public or handled separately

-- ====== LEAGUES TABLE ======
create policy "users_can_select_their_leagues" on public.leagues
  for select using (
    id in (select league_id from public.league_members where user_id = auth.uid())
    or is_demo = true
  );

create policy "authenticated_users_can_create_leagues" on public.leagues
  for insert with check (auth.uid() is not null);

create policy "commissioners_can_update_leagues" on public.leagues
  for update using (
    commissioner_id = auth.uid()
    or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner'))
  );

create policy "commissioners_can_delete_leagues" on public.leagues
  for delete using (commissioner_id = auth.uid());

-- ====== LEAGUE_MEMBERS TABLE ======
create policy "users_can_select_league_members" on public.league_members
  for select using (
    league_id in (select league_id from public.league_members lm2 where lm2.user_id = auth.uid())
  );

create policy "users_can_insert_league_members" on public.league_members
  for insert with check (user_id = auth.uid());

create policy "commissioners_can_update_league_members" on public.league_members
  for update using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
  );

create policy "commissioners_can_delete_league_members" on public.league_members
  for delete using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
  );

-- ====== LEAGUE_INVITES TABLE ======
create policy "users_can_select_league_invites" on public.league_invites
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or invited_email = (auth.jwt() ->> 'email')
  );

create policy "commissioners_can_create_league_invites" on public.league_invites
  for insert with check (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
  );

create policy "commissioners_can_update_league_invites" on public.league_invites
  for update using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid())
  );

-- ====== DRAFT_SESSIONS TABLE ======
create policy "users_can_select_draft_sessions" on public.draft_sessions
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or league_id in (select id from public.leagues where is_demo = true)
  );

create policy "commissioners_can_create_update_draft_sessions" on public.draft_sessions
  for insert with check (
    league_id in (select id from public.leagues where commissioner_id = auth.uid() or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner')))
  );

create policy "commissioners_can_update_draft_sessions" on public.draft_sessions
  for update using (
    league_id in (select id from public.leagues where commissioner_id = auth.uid() or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner')))
  );

-- ====== DRAFT_PICKS TABLE ======
create policy "users_can_select_draft_picks" on public.draft_picks
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or league_id in (select id from public.leagues where is_demo = true)
  );

create policy "users_can_insert_draft_picks" on public.draft_picks
  for insert with check (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

-- ====== ROSTER_SLOTS TABLE ======
create policy "users_can_select_roster_slots" on public.roster_slots
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or league_id in (select id from public.leagues where is_demo = true)
  );

create policy "users_can_insert_roster_slots" on public.roster_slots
  for insert with check (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

-- ====== SCORING_EVENTS TABLE ======
create policy "users_can_select_scoring_events" on public.scoring_events
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or league_id in (select id from public.leagues where is_demo = true)
  );

create policy "service_role_only_insert_scoring_events" on public.scoring_events
  for insert with check (false);

create policy "service_role_only_update_scoring_events" on public.scoring_events
  for update using (false);

create policy "service_role_only_delete_scoring_events" on public.scoring_events
  for delete using (false);

-- ====== LEADERBOARD_SNAPSHOTS TABLE ======
create policy "users_can_select_leaderboard_snapshots" on public.leaderboard_snapshots
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
    or league_id in (select id from public.leagues where is_demo = true)
  );

create policy "service_role_only_insert_leaderboard_snapshots" on public.leaderboard_snapshots
  for insert with check (false);

create policy "service_role_only_update_leaderboard_snapshots" on public.leaderboard_snapshots
  for update using (false);

-- ====== DRAFT_QUEUES TABLE ======
create policy "users_can_select_own_draft_queues" on public.draft_queues
  for select using (user_id = auth.uid());

create policy "users_can_manage_own_draft_queues" on public.draft_queues
  for insert with check (
    user_id = auth.uid()
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

create policy "users_can_update_own_draft_queues" on public.draft_queues
  for update using (
    user_id = auth.uid()
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

create policy "users_can_delete_own_draft_queues" on public.draft_queues
  for delete using (
    user_id = auth.uid()
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

-- ====== BENCH_ORDERS TABLE ======
create policy "users_can_view_bench_orders" on public.bench_orders
  for select using (
    user_id = auth.uid()
    or league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or (league_id in (select league_id from public.league_members where user_id = auth.uid()) and locked_at is not null)
  );

create policy "users_can_manage_bench_orders" on public.bench_orders
  for insert with check (
    (user_id = auth.uid() or league_id in (select id from public.leagues where commissioner_id = auth.uid()))
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

create policy "users_can_update_bench_orders" on public.bench_orders
  for update using (
    (user_id = auth.uid() or league_id in (select id from public.leagues where commissioner_id = auth.uid()))
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

-- ====== PLAYERS TABLE ======
create policy "everyone_can_select_players" on public.players
  for select using (true);

create policy "service_role_only_insert_players" on public.players
  for insert with check (false);

create policy "service_role_only_update_players" on public.players
  for update using (false);

-- ====== TEAMS TABLE ======
create policy "everyone_can_select_teams" on public.teams
  for select using (true);

create policy "service_role_only_insert_teams" on public.teams
  for insert with check (false);

create policy "service_role_only_update_teams" on public.teams
  for update using (false);

-- ====== TIMER_EXTENSIONS TABLE ======
create policy "users_can_select_timer_extensions" on public.timer_extensions
  for select using (
    draft_session_id in (select id from public.draft_sessions where league_id in (select league_id from public.league_members where user_id = auth.uid()))
  );

create policy "commissioners_can_insert_timer_extensions" on public.timer_extensions
  for insert with check (
    draft_session_id in (select id from public.draft_sessions where league_id in (select id from public.leagues where commissioner_id = auth.uid() or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner'))))
  );

-- ====== LEAGUE_NOTIFICATIONS TABLE ======
create policy "users_can_select_league_notifications" on public.league_notifications
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
  );

create policy "service_role_only_insert_league_notifications" on public.league_notifications
  for insert with check (false);

-- ====== CRON_LOCKS TABLE ======
create policy "service_role_only_cron_locks" on public.cron_locks
  for select using (false);

create policy "service_role_only_insert_cron_locks" on public.cron_locks
  for insert with check (false);

create policy "service_role_only_update_cron_locks" on public.cron_locks
  for update using (false);

create policy "service_role_only_delete_cron_locks" on public.cron_locks
  for delete using (false);
