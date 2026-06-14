-- Fix: PATCH /api/commissioner/pick/void always failed with 500
-- "Failed to insert correction pick" (23505 duplicate key value violates unique
-- constraint "idx_draft_picks_session_pick_number").
--
-- The void/replace flow intentionally inserts a correction pick with the SAME
-- pick_number as the voided original (the original row stays in draft_picks with
-- voided_at set, per its self-referential design via replaces_pick_id). But
-- idx_draft_picks_session_pick_number (migration 20260608000004) was a full unique
-- index on (draft_session_id, pick_number), so the correction insert always
-- collided with the still-present voided row.
--
-- Fix: make it a partial unique index over voided_at is null, mirroring
-- idx_draft_picks_session_player_active (same migration). This preserves
-- DraftEngine.submitPick's concurrency guard (racing inserts for the same
-- (draft_session_id, pick_number) both have voided_at null, so the constraint
-- still rejects the loser with 23505 -> 409) while allowing a correction pick
-- (voided_at null) to share pick_number with its now-voided original
-- (voided_at not null, excluded from the partial index).

drop index if exists public.idx_draft_picks_session_pick_number;
create unique index idx_draft_picks_session_pick_number
  on public.draft_picks(draft_session_id, pick_number)
  where voided_at is null;
