-- Create roster_slots table
create table public.roster_slots (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references public.users(id),
  player_id uuid not null references public.players(id),
  slot_key text not null,
  slot_position text not null check (slot_position in ('G', 'F', 'C')),
  is_active boolean not null,
  is_bench boolean not null,
  acquired_at_round_stage text not null,
  released_at_round_stage text,
  release_reason text check (release_reason in ('eliminated', 'injury_sub', 'correction', 'traded', 'waiver', 'draft_cancelled')),
  override_by uuid references public.users(id),
  override_reason text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.roster_slots enable row level security;

-- Create trigger for updated_at
create trigger update_roster_slots_updated_at
  before update on public.roster_slots
  for each row
  execute function moddatetime();

-- Create indexes for roster_slots
create unique index idx_roster_slots_active_slot_key on public.roster_slots(league_id, user_id, slot_key)
  where is_active = true and released_at_round_stage is null;
create index idx_roster_slots_user_active on public.roster_slots(league_id, user_id, is_active);
create index idx_roster_slots_player_league on public.roster_slots(player_id, league_id);
create index idx_roster_slots_acquired_released on public.roster_slots(league_id, acquired_at_round_stage, released_at_round_stage);

-- Create game_scores table
create table public.game_scores (
  id uuid primary key default gen_random_uuid(),
  player_id uuid not null references public.players(id),
  season integer not null,
  round_stage text not null,
  round_number integer not null default 1,
  game_date date not null,
  game_status text not null check (game_status in ('scheduled', 'in_progress', 'final')) default 'scheduled',
  points integer not null default 0,
  source text not null check (source in ('manual', 'espn_api', 'sportsradar_api')),
  synced_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.game_scores enable row level security;

-- Create trigger for updated_at
create trigger update_game_scores_updated_at
  before update on public.game_scores
  for each row
  execute function moddatetime();

-- Create indexes for game_scores - UNIQUE constraint required for UPSERT ON CONFLICT
create unique index idx_game_scores_player_round_date on public.game_scores(player_id, round_stage, round_number, game_date);
create index idx_game_scores_player_round_status on public.game_scores(player_id, round_stage, game_status);

-- Create scoring_events table
create table public.scoring_events (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references public.users(id),
  player_id uuid not null references public.players(id),
  game_score_id uuid not null references public.game_scores(id),
  round_stage text not null,
  points_credited integer not null,
  roster_slot_id uuid references public.roster_slots(id),
  is_stale boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.scoring_events enable row level security;

-- Create trigger for updated_at
create trigger update_scoring_events_updated_at
  before update on public.scoring_events
  for each row
  execute function moddatetime();

-- Create indexes for scoring_events
create unique index idx_scoring_events_game_league_user on public.scoring_events(game_score_id, league_id, user_id);
create index idx_scoring_events_league_user on public.scoring_events(league_id, user_id);
create index idx_scoring_events_league_stale on public.scoring_events(league_id, is_stale);

-- Create leaderboard_snapshots table
create table public.leaderboard_snapshots (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references public.users(id),
  total_points integer not null default 0,
  active_player_count integer not null default 0,
  highest_single_game_points integer not null default 0,
  last_computed_at timestamptz not null default now(),
  round_stage text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.leaderboard_snapshots enable row level security;

-- Create trigger for updated_at
create trigger update_leaderboard_snapshots_updated_at
  before update on public.leaderboard_snapshots
  for each row
  execute function moddatetime();

-- Create indexes for leaderboard_snapshots
create unique index idx_leaderboard_snapshots_league_user on public.leaderboard_snapshots(league_id, user_id);
