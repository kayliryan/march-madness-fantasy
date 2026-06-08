-- Add unique constraints on external ESPN IDs so the seed script can upsert
-- idempotently (ON CONFLICT requires a matching unique constraint).
-- Postgres permits multiple NULLs under a unique constraint, so rows without
-- an ESPN id are unaffected.

alter table public.teams
  add constraint teams_espn_team_id_key unique (espn_team_id);

alter table public.players
  add constraint players_espn_player_id_key unique (espn_player_id);
