create table public.persistent_sessions (
  id               uuid primary key default gen_random_uuid(),
  user_id          uuid not null references auth.users(id) on delete cascade,
  token_hash       text not null,       -- sha256(opaque token) -- the raw token is NEVER stored
  family_id        uuid not null,       -- constant across a chain of rotations
  device_label     text,                -- parsed from User-Agent at issue time
  user_agent       text,
  ip_created       inet,
  created_at       timestamptz not null default now(),
  last_rotated_at  timestamptz not null default now(),
  expires_at       timestamptz not null,               -- absolute cap, e.g. now() + 30 days
  revoked_at       timestamptz,
  revoked_reason   text                                -- 'rotated' | 'reuse_detected' | 'user_signed_out' | 'manual_revoke'
);

create unique index persistent_sessions_token_hash_idx on public.persistent_sessions (token_hash);
create index persistent_sessions_user_id_idx on public.persistent_sessions (user_id);
create index persistent_sessions_family_id_idx on public.persistent_sessions (family_id);

alter table public.persistent_sessions enable row level security;
-- "Your devices" settings page: list and revoke your own sessions. Actually
-- issuing/rotating tokens still only happens via the service-role Edge
-- Function -- these two policies are read/revoke only.
create policy "read own sessions"
  on public.persistent_sessions for select
  using (auth.uid() = user_id);
create policy "revoke own sessions"
  on public.persistent_sessions for update
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id and revoked_at is not null);

create or replace function public.purge_expired_persistent_sessions()
returns void language sql as $$
  delete from public.persistent_sessions
  where expires_at < now() - interval '7 days'  -- keep a short tail for forensics
     or (revoked_at is not null and revoked_at < now() - interval '30 days');
$$;
-- Schedule via pg_cron, e.g. daily.
