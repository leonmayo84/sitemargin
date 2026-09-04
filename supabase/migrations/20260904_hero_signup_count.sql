-- Public, aggregate-only signup count for the marketing-site hero.
--
-- sitemargin.co.za used to carry a hardcoded "23 South African contractors
-- already on site". This replaces the hand-edited number with a live one:
-- index.html keeps 23 as the display baseline and records the real user count
-- on the day that baseline was set (data-baseline-users), and main.js calls
-- this RPC unauthenticated to apply the delta since.
--
-- Safety: SECURITY DEFINER is needed to read auth.users, but the function is
-- STABLE, takes no arguments, pins an empty search_path, and can only ever
-- return a single integer. No row, email or id is reachable through it.
create or replace function public.hero_signup_count()
returns integer
language sql
security definer
set search_path = ''
stable
as $$
  select count(*)::int from auth.users where deleted_at is null;
$$;

revoke all on function public.hero_signup_count() from public;
grant execute on function public.hero_signup_count() to anon, authenticated;

comment on function public.hero_signup_count() is
  'Aggregate count of live auth users. Called unauthenticated by sitemargin.co.za to drive the hero proof number.';
