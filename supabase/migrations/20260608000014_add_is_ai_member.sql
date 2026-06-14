-- Section 14.5 Migration 1: marks AI-controlled demo league members for cleanup.
alter table public.users add column is_ai_member boolean not null default false;
