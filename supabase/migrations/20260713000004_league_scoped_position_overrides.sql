-- Fixes a real cross-league data leak: the commissioner "Override Player Position"
-- tool used to run `update players set position = ...` keyed only by player_id.
-- players is a single row shared by every league in a season (see
-- 20260608000003_create_teams_players_tables.sql), so overriding a position in one
-- league silently overrode it for every other league using that same player —
-- including a user's real league being corrupted by a change made in a demo league.
--
-- This introduces a per-league override table. The base players.position/
-- position_overridden/position_override_note columns remain as the shared
-- "canonical" classification; a league's effective position is now
-- coalesce(override, canonical).

create table public.league_player_position_overrides (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id) on delete cascade,
  player_id uuid not null references public.players(id) on delete cascade,
  position text not null check (position in ('G', 'F', 'C')),
  override_note text not null,
  overridden_by uuid not null references public.users(id),
  overridden_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (league_id, player_id)
);

alter table public.league_player_position_overrides enable row level security;

create trigger update_league_player_position_overrides_updated_at
  before update on public.league_player_position_overrides
  for each row
  execute function moddatetime();

create index idx_league_player_position_overrides_league
  on public.league_player_position_overrides(league_id);

-- Readable by any member of the league (needed for roster/leaderboard/draft views).
create policy "members_can_view_position_overrides" on public.league_player_position_overrides
  for select using (
    league_id in (select league_id from public.league_members where user_id = auth.uid())
  );

-- Writable only by that league's commissioner/co-commissioner.
create policy "commissioners_can_manage_position_overrides" on public.league_player_position_overrides
  for insert with check (
    league_id in (
      select id from public.leagues
      where commissioner_id = auth.uid()
        or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner'))
    )
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

create policy "commissioners_can_update_position_overrides" on public.league_player_position_overrides
  for update using (
    league_id in (
      select id from public.leagues
      where commissioner_id = auth.uid()
        or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner'))
    )
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

create policy "commissioners_can_delete_position_overrides" on public.league_player_position_overrides
  for delete using (
    league_id in (
      select id from public.leagues
      where commissioner_id = auth.uid()
        or id in (select league_id from public.league_members where user_id = auth.uid() and role in ('commissioner', 'co_commissioner'))
    )
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );
