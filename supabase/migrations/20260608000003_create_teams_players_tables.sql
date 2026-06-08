-- Create teams table
create table public.teams (
  id uuid primary key default gen_random_uuid(),
  season integer not null,
  name text not null,
  seed integer not null,
  region text not null,
  is_eliminated boolean not null default false,
  eliminated_in_round_stage text,
  eliminated_in_round_number integer,
  espn_team_id text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.teams enable row level security;

-- Create trigger for updated_at
create trigger update_teams_updated_at
  before update on public.teams
  for each row
  execute function moddatetime();

-- Create players table
create table public.players (
  id uuid primary key default gen_random_uuid(),
  season integer not null,
  name text not null,
  team_id uuid references public.teams(id),
  position text not null check (position in ('G', 'F', 'C')),
  position_overridden boolean not null default false,
  position_override_note text,
  avg_ppg numeric not null default 0,
  injury_status text check (injury_status in ('active', 'day_to_day', 'out')),
  injury_note text,
  injury_updated_at timestamptz,
  espn_player_id text,
  synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.players enable row level security;

-- Create trigger for updated_at
create trigger update_players_updated_at
  before update on public.players
  for each row
  execute function moddatetime();

-- Create indexes for players
create index idx_players_season_team_id on public.players(season, team_id);
create unique index idx_players_espn_player_id on public.players(espn_player_id);
