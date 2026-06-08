-- Create draft_sessions table
create table public.draft_sessions (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  season integer not null,
  status text not null check (status in ('scheduled', 'live', 'complete', 'cancelled')) default 'scheduled',
  draft_type text not null check (draft_type in ('snake', 'linear', 'auction')) default 'snake',
  scheduled_start timestamptz not null,
  started_at timestamptz,
  completed_at timestamptz,
  snake_order uuid[] not null default '{}',
  current_pick_number integer not null default 1,
  pick_timer_seconds integer,
  bench_lock_deadline timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.draft_sessions enable row level security;

-- Create trigger for updated_at
create trigger update_draft_sessions_updated_at
  before update on public.draft_sessions
  for each row
  execute function moddatetime();

-- Create draft_picks table
create table public.draft_picks (
  id uuid primary key default gen_random_uuid(),
  draft_session_id uuid not null references public.draft_sessions(id),
  league_id uuid not null references public.leagues(id),
  pick_number integer not null,
  round_number integer not null,
  user_id uuid not null references public.users(id),
  player_id uuid not null references public.players(id),
  picked_at timestamptz not null default now(),
  time_taken_seconds integer,
  was_auto_picked boolean not null default false,
  voided_at timestamptz,
  voided_by uuid references public.users(id),
  void_reason text,
  replaces_pick_id uuid references public.draft_picks(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.draft_picks enable row level security;

-- Create trigger for updated_at
create trigger update_draft_picks_updated_at
  before update on public.draft_picks
  for each row
  execute function moddatetime();

-- Create indexes for draft_picks
create unique index idx_draft_picks_session_pick_number on public.draft_picks(draft_session_id, pick_number);
create unique index idx_draft_picks_session_player_active on public.draft_picks(draft_session_id, player_id) where voided_at is null;

-- Create draft_queues table
create table public.draft_queues (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  draft_session_id uuid not null references public.draft_sessions(id),
  user_id uuid not null references public.users(id),
  player_id uuid not null references public.players(id),
  queue_position integer not null,
  added_at timestamptz not null default now(),
  removed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.draft_queues enable row level security;

-- Create trigger for updated_at
create trigger update_draft_queues_updated_at
  before update on public.draft_queues
  for each row
  execute function moddatetime();

-- Create timer_extensions table
create table public.timer_extensions (
  id uuid primary key default gen_random_uuid(),
  draft_session_id uuid not null references public.draft_sessions(id),
  pick_number integer not null,
  extended_by uuid not null references public.users(id),
  extension_seconds integer,
  reason text,
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.timer_extensions enable row level security;
