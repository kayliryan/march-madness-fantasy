-- service_role bypasses RLS (BYPASSRLS attribute) but is not a Postgres superuser --
-- it still requires standard table-level GRANTs to touch any table at all.
-- anon/authenticated also need base table-level grants for the operation types
-- their RLS policies allow; RLS restricts *rows*, not the operation type itself.
-- This project's tables were apparently never granted these on the cloud instance
-- (can happen when schema is built via CLI migrations rather than the Studio UI).
-- Safe to grant broadly here because every table already has RLS enabled
-- (verified across migrations 000001-000007) — RLS remains the real access gate.

grant usage on schema public to anon, authenticated, service_role;

grant select, insert, update, delete on all tables in schema public to service_role;
grant usage, select on all sequences in schema public to service_role;

grant select, insert, update, delete on all tables in schema public to authenticated;
grant usage, select on all sequences in schema public to authenticated;

grant select on all tables in schema public to anon;

-- Make this stick for any tables added by future migrations too.
alter default privileges in schema public grant select, insert, update, delete on tables to service_role;
alter default privileges in schema public grant select, insert, update, delete on tables to authenticated;
alter default privileges in schema public grant select on tables to anon;
alter default privileges in schema public grant usage, select on sequences to service_role, authenticated;
