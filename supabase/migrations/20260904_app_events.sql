-- Product instrumentation for the import funnel.
--
-- Insert-only from the client by design: no SELECT policy exists on this
-- table, so rows are readable only over a direct database connection. The
-- insert policy pins user_email to the caller's own JWT claim, so one account
-- cannot write events as another.
--
-- Nothing here records a project name, a client, or a line-item description —
-- only which step of a flow an account reached, the file extension and byte
-- size, row counts, and the project id the event belongs to.
create table if not exists public.app_events (
  id          uuid primary key default gen_random_uuid(),
  created_at  timestamptz not null default now(),
  user_email  text,
  event       text not null,
  props       jsonb not null default '{}'::jsonb
);

create index if not exists app_events_event_created_idx on public.app_events (event, created_at desc);
create index if not exists app_events_email_created_idx on public.app_events (user_email, created_at desc);

alter table public.app_events enable row level security;

drop policy if exists "own inserts" on public.app_events;
create policy "own inserts" on public.app_events
  for insert to authenticated
  with check (user_email = (auth.jwt() ->> 'email'));

comment on table public.app_events is
  'Client-side product events. Insert-only by design: no SELECT policy exists, so rows are readable only over a direct DB connection.';
