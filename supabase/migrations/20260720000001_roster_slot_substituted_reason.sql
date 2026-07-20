-- Allow release_reason='substituted' on roster_slots.
--
-- A bench slot that ends because the player was PROMOTED into a vacated starter
-- slot is semantically different from a slot that ends because the player's team
-- was eliminated. Previously both wrote release_reason='eliminated', which forced
-- getRoundCell()/mergePlayerRounds() to rely on starter-cell masking to hide the
-- bogus post-promotion "Elim" on the vacated bench row. 'substituted' lets the
-- shared round-cell semantics stop the bench row cleanly at the promotion round
-- (rounds >= promotion return null; the player's starter slot owns them).
--
-- Append-only: drop the old inline CHECK and recreate it with the extra value.

alter table public.roster_slots
  drop constraint if exists roster_slots_release_reason_check;

alter table public.roster_slots
  add constraint roster_slots_release_reason_check
  check (release_reason in (
    'eliminated', 'substituted', 'injury_sub', 'correction', 'traded', 'waiver', 'draft_cancelled'
  ));
