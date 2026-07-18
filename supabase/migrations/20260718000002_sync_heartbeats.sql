-- Sync heartbeat (SEASON_2027_CHECKLIST.md Part 1.1, monitoring item).
--
-- Problem this solves: the sync-scores cron can die silently — a revoked
-- CRON_SECRET, a scheduler misconfiguration, or the provider returning nothing
-- all produce zero errors anywhere a human looks. During the live tournament
-- that means standings quietly freeze. This table gives every cron job one row
-- recording its last successful run, so the commissioner page can surface
-- "Scores last synced Xm ago" and a stale value is noticed in minutes.
--
-- Writes are service-role only (no INSERT/UPDATE/DELETE policies — deny-all by
-- omission, same pattern as demo_ai_daily_usage). Reads are allowed for any
-- authenticated session: the value is a non-sensitive timestamp + row counts,
-- and demo commissioners (anonymous-but-authenticated sessions) should see the
-- same operational transparency real leagues do.

create table if not exists public.sync_heartbeats (
  job_name text primary key,
  last_success_at timestamptz not null,
  last_result jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

alter table public.sync_heartbeats enable row level security;

create policy "authenticated_can_read_sync_heartbeats"
  on public.sync_heartbeats
  for select
  using (auth.uid() is not null);
