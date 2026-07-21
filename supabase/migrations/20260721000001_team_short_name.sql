-- Adds teams.short_name — the school name WITHOUT its mascot ("Duke" instead of
-- "Duke Blue Devils"), for the "Player Name — School #Seed" display format.
-- teams.name was seeded from ESPN's `displayName` field (school+mascot combined);
-- the split-out school-only value was never captured. Nullable: backfilled by
-- scripts/backfill-team-short-names.ts immediately after this migration, but the
-- column must tolerate a null until that script runs (and for any future team
-- inserted before its own backfill).

alter table public.teams add column short_name text;
