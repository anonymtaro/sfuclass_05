-- 010_scheduling.sql — sessions · reminders (F1, F3)
-- Expand-only: no destructive statement in this release.

create extension if not exists pgcrypto;

-- ---------------------------------------------------------------- --
-- Live lesson slots
-- ---------------------------------------------------------------- --
create table if not exists scheduled_sessions (
  id            uuid primary key default gen_random_uuid(),
  tenant_id     uuid        not null references tenants (id) on delete cascade,
  series_id     uuid,                      -- set when the row came from a recurrence
  course_id     uuid        references courses (id) on delete cascade,
  lesson_id     uuid        references lessons (id) on delete cascade,
  host_id       uuid        not null references users (id),
  room_id       text,                      -- classroom Room id, set on start
  title         text        not null,
  description   text,
  starts_at     timestamptz not null,
  ends_at       timestamptz not null,
  time_zone     text        not null,      -- IANA zone the wall clock was entered in
  status        text        not null default 'scheduled',
  sequence      integer     not null default 0,  -- iCalendar SEQUENCE
  waiting_room  boolean     not null default true,
  recurrence    jsonb,
  created_by    uuid        not null references users (id),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  cancelled_at  timestamptz,
  cancel_reason text,
  constraint scheduled_sessions_status_check
    check (status in ('scheduled', 'live', 'ended', 'cancelled')),
  constraint scheduled_sessions_window_check
    check (ends_at > starts_at)
);

create index if not exists scheduled_sessions_tenant_start_idx
  on scheduled_sessions (tenant_id, starts_at);

create index if not exists scheduled_sessions_host_start_idx
  on scheduled_sessions (host_id, starts_at)
  where status in ('scheduled', 'live');

create index if not exists scheduled_sessions_lesson_idx
  on scheduled_sessions (lesson_id) where lesson_id is not null;

create index if not exists scheduled_sessions_course_start_idx
  on scheduled_sessions (course_id, starts_at) where course_id is not null;

create index if not exists scheduled_sessions_series_idx
  on scheduled_sessions (series_id, starts_at) where series_id is not null;

-- ---------------------------------------------------------------- --
-- Explicit audience for ad-hoc sessions (course enrolment covers the rest)
-- ---------------------------------------------------------------- --
create table if not exists session_invitees (
  session_id uuid        not null references scheduled_sessions (id) on delete cascade,
  user_id    uuid        not null references users (id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);

create index if not exists session_invitees_user_idx on session_invitees (user_id);

-- ---------------------------------------------------------------- --
-- Reminder plan — Postgres is the source of truth, the queue is transport
-- ---------------------------------------------------------------- --
create table if not exists session_reminders (
  id         uuid        primary key default gen_random_uuid(),
  session_id uuid        not null references scheduled_sessions (id) on delete cascade,
  rule_key   text        not null,         -- 'T-24h', 'T-10m'
  fire_at    timestamptz not null,
  sequence   integer     not null default 0,
  template   text        not null,
  channels   text[]      not null default '{}',
  status     text        not null default 'pending',
  attempts   integer     not null default 0,
  sent_at    timestamptz,
  recipients integer,
  last_error text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint session_reminders_status_check
    check (status in ('pending', 'queued', 'sent', 'failed', 'skipped', 'cancelled')),
  constraint session_reminders_unique unique (session_id, rule_key)
);

create index if not exists session_reminders_due_idx
  on session_reminders (fire_at) where status = 'pending';

-- ---------------------------------------------------------------- --
-- Calendar feed tokens — the URL is the credential, so it must be revocable
-- ---------------------------------------------------------------- --
create table if not exists calendar_feed_tokens (
  user_id          uuid        primary key references users (id) on delete cascade,
  token_id         uuid        not null default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  rotated_at       timestamptz,
  last_accessed_at timestamptz,
  revoked_at       timestamptz
);