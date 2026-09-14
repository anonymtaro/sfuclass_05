-- 002_identity.sql — users · devices · sessions (F5)
--
-- Assumes 001_init.sql created `tenants(id)`. If that table is named differently there,
-- the foreign keys below are the one place to change.
--
-- Expand-only: nothing here drops or rewrites anything from 001.

create extension if not exists pgcrypto;   -- gen_random_uuid()
create extension if not exists citext;     -- case-insensitive email

-- Shared updated_at trigger, created once and reused by every later migration.
create or replace function set_updated_at() returns trigger as $$
begin
  new.updated_at = now();
  return new;
end;
$$ language plpgsql;

-- ---------------------------------------------------------------- --
-- Users
-- ---------------------------------------------------------------- --
create table if not exists users (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  email            citext      not null,
  password_hash    text,                        -- null for SSO-only accounts
  display_name     text        not null,
  role             text        not null default 'learner',
  status           text        not null default 'active',
  locale           text        not null default 'en',
  time_zone        text        not null default 'UTC',
  email_verified_at timestamptz,
  last_seen_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint users_role_check   check (role in ('owner', 'teacher', 'learner')),
  constraint users_status_check check (status in ('active', 'invited', 'suspended', 'deleted'))
);

-- Email is unique per tenant, not globally: the same person may belong to two schools.
-- Partial, so a soft-deleted account does not block re-registration.
create unique index if not exists users_tenant_email_key
  on users (tenant_id, email) where deleted_at is null;

create index if not exists users_tenant_role_idx on users (tenant_id, role) where deleted_at is null;

drop trigger if exists users_set_updated_at on users;
create trigger users_set_updated_at before update on users
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- --
-- Devices — one row per install, carries the push endpoint
-- ---------------------------------------------------------------- --
create table if not exists devices (
  id               uuid        primary key default gen_random_uuid(),
  user_id          uuid        not null references users (id) on delete cascade,
  device_id        text        not null,        -- client-generated, stable per install
  platform         text        not null,
  model            text,
  app_version      text,
  push_token       text,
  sns_endpoint_arn text,
  last_seen_at     timestamptz not null default now(),
  created_at       timestamptz not null default now(),
  retired_at       timestamptz,
  retired_reason   text,
  constraint devices_platform_check check (platform in ('web', 'ios', 'android')),
  constraint devices_user_device_key unique (user_id, device_id)
);

create index if not exists devices_push_idx
  on devices (user_id) where retired_at is null and sns_endpoint_arn is not null;

-- ---------------------------------------------------------------- --
-- Sessions — rotating refresh tokens, bound to a device
-- ---------------------------------------------------------------- --
create table if not exists sessions (
  id                 uuid        primary key default gen_random_uuid(),
  user_id            uuid        not null references users (id) on delete cascade,
  device_id          uuid        references devices (id) on delete set null,
  -- The token is never stored, only its hash: a database leak must not be a session leak.
  refresh_token_hash text        not null,
  -- All rotations of one login share a family. Reuse of a rotated token revokes the family.
  family_id          uuid        not null,
  parent_id          uuid        references sessions (id) on delete set null,
  ip                 inet,
  user_agent         text,
  issued_at          timestamptz not null default now(),
  expires_at         timestamptz not null,
  rotated_at         timestamptz,
  revoked_at         timestamptz,
  revoked_reason     text
);

create unique index if not exists sessions_token_hash_key on sessions (refresh_token_hash);
create index if not exists sessions_user_active_idx
  on sessions (user_id, expires_at) where revoked_at is null;
create index if not exists sessions_family_idx on sessions (family_id);
-- Sweeper index: expired rows are pruned by maintenance.
create index if not exists sessions_expiry_idx on sessions (expires_at) where revoked_at is null;