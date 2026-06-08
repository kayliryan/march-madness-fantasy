-- Create users table
create table public.users (
  id uuid primary key,
  external_auth_id text unique,
  display_name text not null,
  avatar_url text,
  bio text,
  notification_preferences jsonb not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.users enable row level security;

-- Create trigger for updated_at
create trigger update_users_updated_at
  before update on public.users
  for each row
  execute function moddatetime();
