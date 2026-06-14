-- Section 14.5 Migration 4: deletes orphaned provisioned demo leagues.
-- DEVIATION FROM SPEC: none of the FK constraints on league-scoped tables in this
-- schema are ON DELETE CASCADE (see migrations 000002, 000004, 000005, 000006) —
-- a bare `delete from leagues` would raise a foreign key violation. Explicitly
-- delete dependents in FK-safe order instead of relying on cascade.
-- NOTE: game_scores NOT deleted — player-scoped, shared across leagues.
-- NEVER add a FK from game_scores to leagues.
create or replace function delete_orphaned_demo_leagues(p_league_ids uuid[])
returns void
language plpgsql
security definer
as $$
begin
  -- p_league_ids must not be empty; empty array is a no-op (safe but unintended).
  delete from scoring_events where league_id = any(p_league_ids);
  delete from timer_extensions where draft_session_id in (
    select id from draft_sessions where league_id = any(p_league_ids)
  );
  delete from draft_picks where league_id = any(p_league_ids);
  delete from draft_queues where league_id = any(p_league_ids);
  delete from roster_slots where league_id = any(p_league_ids);
  delete from bench_orders where league_id = any(p_league_ids);
  delete from leaderboard_snapshots where league_id = any(p_league_ids);
  delete from league_notifications where league_id = any(p_league_ids);
  delete from league_invites where league_id = any(p_league_ids);
  delete from league_members where league_id = any(p_league_ids);
  delete from draft_sessions where league_id = any(p_league_ids);
  delete from leagues where id = any(p_league_ids);
end;
$$;
