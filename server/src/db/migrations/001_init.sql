-- 001_init.sql — plans · subs · rooms  [BASELINE from v5]
--
-- REFERENCE RECONSTRUCTION. If this file already exists and has already been applied in
-- any environment, keep yours: migrate.js stores a checksum per applied file and will
-- refuse the deploy if this one differs from what ran. Compare, do not replace.
--
-- Everything in 002-010 hangs off `tenants (id)`, so that table is the one thing this file
-- must get right for the rest of the chain to apply.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- --
-- Tenants
-- ---------------------------------------------------------------- --
create table if not exists tenants (
  id          uuid        primary key default gen_random_uuid(),
  name        text        not null,
  slug        text        not null,
  status      text        not null default 'active',
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  deleted_at  timestamptz,
  constraint tenants_slug_key unique (slug),
  constraint tenants_status_check check (status in ('active', 'suspended', 'deleted'))
);

-- ---------------------------------------------------------------- --
-- Plans and subscriptions
-- ---------------------------------------------------------------- --
create table if not exists plans (
  id                uuid        primary key default gen_random_uuid(),
  code              text        not null,          -- 'free', 'pro', 'school'
  name              text        not null,
  stripe_price_id   text,
  max_seats         integer     not null default 0,   -- 0 = unlimited
  max_rooms         integer     not null default 0,
  max_courses       integer     not null default 0,
  -- [EXT in v6] LimitResolver reads storage alongside seats and courses.
  storage_quota_gb  integer     not null default 0,
  features          jsonb       not null default '{}'::jsonb,
  active            boolean     not null default true,
  created_at        timestamptz not null default now(),
  constraint plans_code_key unique (code)
);

create table if not exists subscriptions (
  id                     uuid        primary key default gen_random_uuid(),
  tenant_id              uuid        not null references tenants (id) on delete cascade,
  plan_id                uuid        not null references plans (id),
  status                 text        not null default 'active',
  stripe_customer_id     text,
  stripe_subscription_id text,
  seats                  integer     not null default 1,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean     not null default false,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_status_check check (
    status in ('trialing', 'active', 'past_due', 'canceled', 'expired')
  ),
  constraint subscriptions_tenant_key unique (tenant_id)
);

create unique index if not exists subscriptions_stripe_key
  on subscriptions (stripe_subscription_id) where stripe_subscription_id is not null;
-- checkExpiredSubscriptions sweeps by this.
create index if not exists subscriptions_period_end_idx
  on subscriptions (current_period_end) where status in ('active', 'trialing', 'past_due');

-- Stripe delivers every webhook at least once, and retries for days. The event id is the
-- idempotency key: inserting it is what makes a handler run exactly once.
create table if not exists processed_events (
  event_id     text        primary key,
  type         text        not null,
  processed_at timestamptz not null default now()
);

create index if not exists processed_events_age_idx on processed_events (processed_at);

-- ---------------------------------------------------------------- --
-- Rooms
-- ---------------------------------------------------------------- --

-- The durable record of a room. Live state (which SFU node, who is in it) lives in Redis;
-- this table is what survives a node dying.
create table if not exists rooms (
  id          text        primary key,          -- client-visible room id
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  created_by  uuid,                              -- fk added in 002, once users exist
  status      text        not null default 'open',
  max_peers   integer,
  opened_at   timestamptz not null default now(),
  closed_at   timestamptz,
  constraint rooms_status_check check (status in ('open', 'live', 'closed'))
);

create index if not exists rooms_tenant_status_idx on rooms (tenant_id, status) where closed_at is null;