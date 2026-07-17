-- Section 4: Three-layer AI cost defense for demo experience.
--
-- Layer 1 — per-demo-league cap: demo_ai_calls_used column on leagues.
-- Layer 2 — concurrent-league cap + per-IP rate limit: demo_provision_log table.
-- Layer 3 — global daily AI-call cap: demo_ai_daily_usage table.
--
-- Cap math (Sonnet 4.6: $3/M input, $15/M output tokens):
--   Typical call: ~3000 input + ~300 output = $0.009 + $0.0045 ≈ $0.014; avg $0.04
--   Layer 1: $1.00 ceiling / $0.04 avg = 25 calls per league
--   Layer 2 concurrent: 50 leagues × $1.00 max AI = $50 max exposure
--   Layer 2 per-IP: $2.00 tolerable / $1.01 per session ≈ 2, bumped to 5 for NAT
--   Layer 3: $20.00 daily ceiling / $0.04 avg = 500 calls/day

-- Layer 1: add call counter to leagues
alter table leagues
  add column if not exists demo_ai_calls_used int not null default 0;

-- Layer 2: provision log for per-IP rate limiting
create table if not exists demo_provision_log (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  provisioned_at timestamptz not null default now()
);
alter table demo_provision_log enable row level security;
create index if not exists demo_provision_log_ip_time
  on demo_provision_log (ip, provisioned_at desc);

-- Layer 3: global daily call counter
create table if not exists demo_ai_daily_usage (
  date date primary key,
  calls_used int not null default 0
);
alter table demo_ai_daily_usage enable row level security;

-- Atomic daily increment: INSERT ... ON CONFLICT ... DO UPDATE in a single Postgres
-- statement is serializable — no separate lock needed. Returns new total for the day.
create or replace function increment_demo_daily_ai_usage(p_date date)
returns int
language plpgsql security definer as $$
declare
  v_calls int;
begin
  insert into demo_ai_daily_usage (date, calls_used)
  values (p_date, 1)
  on conflict (date) do update
    set calls_used = demo_ai_daily_usage.calls_used + 1
  returning calls_used into v_calls;
  return v_calls;
end;
$$;
