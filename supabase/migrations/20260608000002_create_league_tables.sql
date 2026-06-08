-- Create leagues table
create table public.leagues (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  season integer not null,
  commissioner_id uuid references public.users(id),
  settings jsonb not null,
  invite_token text unique,
  is_demo boolean not null default false,
  stats_sync_status text not null default 'ok' check (stats_sync_status in ('ok', 'degraded', 'manual')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.leagues enable row level security;

-- Create trigger for updated_at
create trigger update_leagues_updated_at
  before update on public.leagues
  for each row
  execute function moddatetime();

-- Create league_members table
create table public.league_members (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references public.users(id),
  role text not null check (role in ('member', 'co_commissioner', 'commissioner')),
  draft_order_position integer,
  joined_at timestamptz not null default now(),
  invited_by uuid references public.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.league_members enable row level security;

-- Create trigger for updated_at
create trigger update_league_members_updated_at
  before update on public.league_members
  for each row
  execute function moddatetime();

-- Create league_invites table
create table public.league_invites (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  invited_email text not null,
  invited_by uuid not null references public.users(id),
  token text unique not null,
  status text not null check (status in ('pending', 'accepted', 'expired')) default 'pending',
  sent_at timestamptz not null default now(),
  accepted_at timestamptz,
  expires_at timestamptz not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.league_invites enable row level security;

-- Create trigger for updated_at
create trigger update_league_invites_updated_at
  before update on public.league_invites
  for each row
  execute function moddatetime();
