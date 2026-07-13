-- Layer 4: per-IP rate limit specifically on AI advisor calls (mock-draft-advisor,
-- draft-advisor, standings-narrator). The existing Layer 3 global daily cap bounds
-- total spend, but doesn't stop one IP from consuming the whole shared daily pool
-- and starving other visitors. This table tracks individual advisor calls per IP
-- so a single caller can be capped independently of the global counter.

create table if not exists demo_ai_call_log (
  id uuid primary key default gen_random_uuid(),
  ip text not null,
  called_at timestamptz not null default now()
);
alter table demo_ai_call_log enable row level security;
create index if not exists demo_ai_call_log_ip_time
  on demo_ai_call_log (ip, called_at desc);
