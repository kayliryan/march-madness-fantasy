-- Fixes "permission denied for table users" on every auth signup (email, OAuth,
-- and anonymous via signInAnonymously — required for Section 14 demo provisioning).
-- The on_auth_user_created trigger (migration 000008) runs public.handle_new_user()
-- as the CALLING role during the auth.users insert, i.e. supabase_auth_admin, which
-- has no privileges on public.users. SECURITY DEFINER runs it as the function owner
-- (postgres) instead. set search_path pinned per Postgres SECURITY DEFINER guidance.
create or replace function public.handle_new_user()
returns trigger as $$
begin
  insert into public.users (id, display_name, created_at)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'display_name', new.email, 'User'),
    now()
  );
  return new;
end;
$$ language plpgsql security definer set search_path = public;
