-- Create extensions and utility functions that other migrations depend on
-- This migration must run first

-- Create pgcrypto extension for UUID functions
create extension if not exists pgcrypto;

-- Create moddatetime function for automatic updated_at timestamps
create or replace function public.moddatetime()
returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;
