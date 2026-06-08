-- Create trigger function for creating users on auth signup
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
$$ language plpgsql;

-- Create trigger on auth.users table
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
