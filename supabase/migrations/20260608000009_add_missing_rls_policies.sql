-- Add missing RLS policies for game_scores and users tables

-- ====== GAME_SCORES TABLE ======
-- SELECT policy: league members and demo leagues can see game scores
create policy "users_can_select_game_scores" on public.game_scores
  for select using (
    true  -- Game scores are player-level data, visible to all authenticated users
         -- Filtering by league happens at the application layer
  );

-- INSERT/UPDATE/DELETE: service role only
create policy "service_role_only_insert_game_scores" on public.game_scores
  for insert with check (false);

create policy "service_role_only_update_game_scores" on public.game_scores
  for update using (false);

create policy "service_role_only_delete_game_scores" on public.game_scores
  for delete using (false);

-- ====== USERS TABLE ======
-- SELECT: any authenticated user can see any user
create policy "authenticated_users_can_select_users" on public.users
  for select using (auth.uid() is not null);

-- UPDATE: users can only update their own profile
create policy "users_can_update_own_profile" on public.users
  for update using (auth.uid() = id);

-- INSERT/DELETE: disabled
create policy "service_role_only_insert_users" on public.users
  for insert with check (false);

create policy "service_role_only_delete_users" on public.users
  for delete using (false);
