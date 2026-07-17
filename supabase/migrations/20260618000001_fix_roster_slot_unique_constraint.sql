-- The original idx_roster_slots_active_slot_key was a non-partial unique index on
-- (league_id, user_id, slot_key), which blocks bench-activation history: when a bench
-- player is promoted to fill a starter slot, there are two rows sharing the same slot_key
-- (the original starter row, now released, and the promoted row). Drop and re-create as a
-- partial unique index so only one UNRELEASED (active) slot exists per key at a time.
DROP INDEX IF EXISTS public.idx_roster_slots_active_slot_key;

CREATE UNIQUE INDEX idx_roster_slots_active_slot_key
  ON public.roster_slots(league_id, user_id, slot_key)
  WHERE released_at_round_stage IS NULL;
