-- 009_profiles.sql — profiles · blocks · reports (F6)
--
-- The profile is the anchor for direct messages, so the DM policy lives here rather than in
-- a generic settings blob: it is read on every send, and it has to be indexable.

create table if not exists profiles (
  user_id          uuid        primary key references users (id) on delete cascade,
  avatar_asset_id  uuid        references assets (id) on delete set null,
  headline         text,
  bio              text,
  links            jsonb       not null default '[]'::jsonb,
  visibility       text        not null default 'tenant',
  -- 'shared-only' = people I share a course or space with. Enforced server-side on send,
  -- never in the UI.
  dm_policy        text        not null default 'shared-only',
  show_presence    boolean     not null default true,
  show_read_receipts boolean   not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint profiles_visibility_check check (visibility in ('tenant', 'shared-only', 'private')),
  constraint profiles_dm_policy_check  check (dm_policy in ('anyone', 'shared-only', 'nobody'))
);

drop trigger if exists profiles_set_updated_at on profiles;
create trigger profiles_set_updated_at before update on profiles
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- --
-- Blocks
-- ---------------------------------------------------------------- --

-- One row per direction, but enforcement is symmetric: a send is refused if a row exists
-- either way round. Storing one direction and inferring the other makes every check a
-- two-branch query that someone eventually writes wrong.
create table if not exists blocks (
  user_id    uuid        not null references users (id) on delete cascade,
  blocked_id uuid        not null references users (id) on delete cascade,
  reason     text,
  created_at timestamptz not null default now(),
  primary key (user_id, blocked_id),
  constraint blocks_no_self check (user_id <> blocked_id)
);

-- The send-path check: "is there a block in either direction between A and B".
create index if not exists blocks_blocked_idx on blocks (blocked_id, user_id);

-- ---------------------------------------------------------------- --
-- Reports — messages and users
-- ---------------------------------------------------------------- --
create table if not exists chat_reports (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  reporter_id uuid        not null references users (id) on delete cascade,
  -- Exactly one target: a message, or a person.
  message_id  uuid        references messages (id) on delete set null,
  reported_id uuid        references users (id) on delete cascade,
  evidence_message_ids uuid[] not null default '{}',
  reason      text        not null,
  note        text,
  status      text        not null default 'open',
  resolved_by uuid        references users (id) on delete set null,
  resolved_at timestamptz,
  resolution  text,
  created_at  timestamptz not null default now(),
  constraint chat_reports_target_check check (message_id is not null or reported_id is not null),
  constraint chat_reports_status_check check (status in ('open', 'resolved', 'dismissed'))
);

create index if not exists chat_reports_queue_idx
  on chat_reports (tenant_id, created_at desc) where status = 'open';
-- Retention asks "is this message under an open report" before deleting it.
create index if not exists chat_reports_message_idx
  on chat_reports (message_id) where status = 'open' and message_id is not null;
create index if not exists chat_reports_reported_idx on chat_reports (reported_id, created_at desc);

-- ---------------------------------------------------------------- --
-- Moderation actions — append-only, survives the thing it acted on
-- ---------------------------------------------------------------- --
create table if not exists moderation_actions (
  id          bigserial   primary key,
  tenant_id   uuid        not null,
  actor_id    uuid        references users (id) on delete set null,
  action      text        not null,              -- 'mute', 'remove', 'delete', 'slow-mode', 'ban'
  target_type text        not null,              -- 'message', 'user', 'channel', 'post'
  target_id   uuid,
  scope_id    uuid,                              -- channel, space or room it applied to
  -- What was removed, in case the row it pointed at is gone. Moderation history must
  -- outlive the content it is about.
  snapshot    jsonb,
  expires_at  timestamptz,
  created_at  timestamptz not null default now()
);

create index if not exists moderation_actions_target_idx on moderation_actions (target_type, target_id);
create index if not exists moderation_actions_tenant_idx on moderation_actions (tenant_id, created_at desc);
create index if not exists moderation_actions_active_idx
  on moderation_actions (scope_id, target_id) where expires_at is not null;