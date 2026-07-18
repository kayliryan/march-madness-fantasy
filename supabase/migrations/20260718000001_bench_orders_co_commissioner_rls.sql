-- Fix: "users_can_manage_bench_orders" (insert) and "users_can_update_bench_orders"
-- (update) on public.bench_orders only granted commissioner access via
-- `league_id in (select id from public.leagues where commissioner_id = auth.uid())`.
-- A co_commissioner (a role recorded in league_members, not leagues.commissioner_id)
-- was silently rejected by RLS, surfacing as a confusing 500 from the
-- /api/commissioner/bench-order route rather than a clean 403.
--
-- Fix: extend all three bench_orders policies to also allow league_id in
-- get_my_commissioner_league_ids() — the security-definer helper introduced in
-- 20260608000020_fix_commissioner_update_policy_recursion.sql specifically so that
-- policies can check commissioner/co_commissioner membership without re-entering
-- league_members' own RLS-protected SELECT (which caused infinite recursion when
-- queried inline). get_my_commissioner_league_ids() already returns league_ids for
-- role in ('commissioner', 'co_commissioner'), so no new function is needed here.
--
-- "users_can_view_bench_orders" (SELECT) also needs the same co-commissioner branch,
-- not just the two write policies: PATCH /api/commissioner/bench-order does
-- `.insert(...).select().single()` / `.update(...).select().single()`, and Postgres
-- RLS requires the SELECT policy to pass for a row to come back through RETURNING —
-- even though the INSERT's WITH CHECK passes for a co-commissioner, the pre-fix
-- SELECT policy only granted a non-owner unconditional read via
-- `leagues.commissioner_id = auth.uid()` (co-commissioners never satisfy this) or,
-- for any league member, only once `locked_at IS NOT NULL`. A co-commissioner
-- editing another member's still-unlocked bench order therefore passed the INSERT
-- check but failed the implicit SELECT check on RETURNING, surfacing as
-- "new row violates row-level security policy for table bench_orders" — reproduced
-- directly via psql (INSERT ... RETURNING fails; the same INSERT without RETURNING
-- succeeds). Adding the co-commissioner branch unconditionally (mirroring how
-- leagues.commissioner_id already gets unconditional, non-locked-gated access)
-- fixes this the same way it fixes the write policies.
--
-- The demo_viewer denial clause on the two write policies is preserved unchanged.

drop policy if exists "users_can_view_bench_orders" on public.bench_orders;
create policy "users_can_view_bench_orders" on public.bench_orders
  for select using (
    user_id = auth.uid()
    or league_id in (select id from public.leagues where commissioner_id = auth.uid())
    or league_id in (select get_my_commissioner_league_ids())
    or (league_id in (select get_my_league_ids()) and locked_at is not null)
  );

drop policy if exists "users_can_manage_bench_orders" on public.bench_orders;
create policy "users_can_manage_bench_orders" on public.bench_orders
  for insert with check (
    (
      user_id = auth.uid()
      or league_id in (select id from public.leagues where commissioner_id = auth.uid())
      or league_id in (select get_my_commissioner_league_ids())
    )
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );

drop policy if exists "users_can_update_bench_orders" on public.bench_orders;
create policy "users_can_update_bench_orders" on public.bench_orders
  for update using (
    (
      user_id = auth.uid()
      or league_id in (select id from public.leagues where commissioner_id = auth.uid())
      or league_id in (select get_my_commissioner_league_ids())
    )
    and not (auth.jwt() ->> 'role' = 'demo_viewer')
  );
