-- Create bench_orders table
create table public.bench_orders (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  user_id uuid not null references public.users(id),
  ordered_player_ids uuid[] not null default '{}',
  submitted_at timestamptz,
  locked_at timestamptz,
  last_edited_by uuid references public.users(id),
  last_edited_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Enable RLS
alter table public.bench_orders enable row level security;

-- Create trigger for updated_at
create trigger update_bench_orders_updated_at
  before update on public.bench_orders
  for each row
  execute function moddatetime();

-- Create league_notifications table
create table public.league_notifications (
  id uuid primary key default gen_random_uuid(),
  league_id uuid not null references public.leagues(id),
  type text not null check (type in ('round_end_digest', 'draft_reminder', 'custom_blast', 'draft_turn_alert')),
  channel text not null check (channel in ('email', 'sms')),
  subject text,
  body text not null,
  ai_generated boolean not null default false,
  sent_at timestamptz,
  created_by uuid references public.users(id),
  created_at timestamptz not null default now()
);

-- Enable RLS
alter table public.league_notifications enable row level security;

-- Create cron_locks table
create table public.cron_locks (
  job_name text primary key,
  locked_at timestamptz not null,
  locked_by text not null,
  timeout_minutes integer not null default 10
);

-- Enable RLS
alter table public.cron_locks enable row level security;
