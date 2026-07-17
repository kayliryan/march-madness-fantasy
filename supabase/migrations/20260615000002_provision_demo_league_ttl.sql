-- Section 5: Update provision_demo_league RPC to set demo_expires_at.
-- TTL = 8 hours (2-3h thorough review × 2.5 safety buffer; see migration 20260615000001).
create or replace function provision_demo_league(
  p_commissioner_id uuid,
  p_ai_member_ids uuid[],
  p_ai_display_names text[],
  p_draft_order uuid[],
  p_season int
)
returns table(league_id uuid, draft_session_id uuid)
language plpgsql
security definer
as $$
declare
  v_league_id uuid;
  v_session_id uuid;
  i int;
begin
  insert into leagues (name, season, commissioner_id, is_demo, demo_expires_at, settings)
  values (
    'Your Demo League', p_season, p_commissioner_id, true,
    now() + interval '8 hours',
    '{"draft_type":"snake","pick_timer_seconds":90,"starter_slots":{"G":2,"F":2,"C":1},"bench_slots":3,"sub_eligibility_matrix":{"G":["G","F"],"F":["G","F"],"C":["C"]},"bench_lock_mode":"before_first_game","activation_timing":"immediate","injury_sub_enabled":false,"tiebreaker_strategies":["highest_single_active_game"],"scoring_includes_play_in":true,"stats_provider":"espn"}'::jsonb
  )
  returning id into v_league_id;

  -- Commissioner row: the on_auth_user_created trigger already inserted a row with
  -- display_name defaulted to 'User' (anonymous users have no email/metadata).
  -- Overwrite that default, but never clobber a real user's chosen display name.
  insert into users (id, display_name, is_ai_member, created_at)
  values (p_commissioner_id, 'You (Commissioner)', false, now())
  on conflict (id) do update
    set display_name = excluded.display_name
    where users.display_name is null or users.display_name = 'User';

  -- AI member rows. admin.createUser() also fires the auth trigger, which inserts
  -- a row with is_ai_member defaulting to false — force it to true here regardless
  -- of insert order so the cleanup job's is_ai_member=true join always matches.
  for i in 1..array_length(p_ai_member_ids, 1) loop
    insert into users (id, display_name, is_ai_member, created_at)
    values (p_ai_member_ids[i], p_ai_display_names[i], true, now())
    on conflict (id) do update
      set is_ai_member = true,
          display_name = excluded.display_name;
  end loop;

  insert into league_members (league_id, user_id, role, draft_order_position, joined_at)
  values (v_league_id, p_commissioner_id, 'commissioner',
    array_position(p_draft_order, p_commissioner_id), now());

  for i in 1..array_length(p_ai_member_ids, 1) loop
    insert into league_members (league_id, user_id, role, draft_order_position, joined_at)
    values (v_league_id, p_ai_member_ids[i], 'member',
      array_position(p_draft_order, p_ai_member_ids[i]), now());
  end loop;

  -- scheduled_start: now() - 1 minute so Start Draft validation (scheduled_start <= now()) passes immediately.
  -- bench_lock_deadline: hardcoded — no real games to derive from. Intentional.
  -- snake_order: empty — populated when the commissioner clicks Start Draft.
  insert into draft_sessions (
    league_id, season, status, draft_type, scheduled_start,
    snake_order, current_pick_number, pick_timer_seconds, bench_lock_deadline
  )
  values (
    v_league_id, p_season, 'scheduled', 'snake',
    now() - interval '1 minute', '{}', 1, 90,
    now() + interval '7 days'
  )
  returning id into v_session_id;

  return query select v_league_id, v_session_id;
end;
$$;
