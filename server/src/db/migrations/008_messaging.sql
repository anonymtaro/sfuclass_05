-- 008_messaging.sql — channels · conversations · messages (F6)
--
-- One message table for direct messages, group chats and public channels. A conversation is
-- a participant set; a channel is a scope. Splitting them into separate tables means every
-- read path, search index and retention job is written twice.

-- ---------------------------------------------------------------- --
-- Channels — public, space-bound, course-bound
-- ---------------------------------------------------------------- --
create table if not exists channels (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  scope           text        not null default 'public',
  space_id        uuid        references spaces (id) on delete cascade,
  course_id       uuid        references courses (id) on delete cascade,
  name            text        not null,
  topic           text,
  slow_mode_seconds integer   not null default 0,
  archived_at     timestamptz,
  created_at      timestamptz not null default now(),
  constraint channels_scope_check check (scope in ('public', 'space', 'course')),
  -- A space or course channel must say which; a public one must not.
  constraint channels_scope_target_check check (
    (scope = 'public' and space_id is null and course_id is null) or
    (scope = 'space'  and space_id is not null) or
    (scope = 'course' and course_id is not null)
  )
);

create unique index if not exists channels_space_key on channels (space_id) where space_id is not null;
create unique index if not exists channels_course_key on channels (course_id) where course_id is not null;
create index if not exists channels_tenant_idx on channels (tenant_id) where archived_at is null;

-- ---------------------------------------------------------------- --
-- Conversations — direct 1:1 and small groups
-- ---------------------------------------------------------------- --
create table if not exists conversations (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  kind            text        not null default 'direct',
  title           text,
  -- Sorted participant ids for a 1:1, hashed. This is what makes open-or-create idempotent:
  -- the same pair always collides on the unique index below, whichever side clicks first.
  participant_key text,
  created_by      uuid        references users (id) on delete set null,
  created_at      timestamptz not null default now(),
  last_message_at timestamptz,
  constraint conversations_kind_check check (kind in ('direct', 'group'))
);

create unique index if not exists conversations_participant_key
  on conversations (tenant_id, participant_key) where participant_key is not null;
create index if not exists conversations_recent_idx on conversations (tenant_id, last_message_at desc);

create table if not exists conversation_participants (
  conversation_id uuid        not null references conversations (id) on delete cascade,
  user_id         uuid        not null references users (id) on delete cascade,
  role            text        not null default 'member',
  muted           boolean     not null default false,
  last_read_at    timestamptz,
  last_read_message_id uuid,
  joined_at       timestamptz not null default now(),
  left_at         timestamptz,
  primary key (conversation_id, user_id)
);

-- The conversation list: every thread a user is in, newest first.
create index if not exists conversation_participants_user_idx
  on conversation_participants (user_id) where left_at is null;

-- Channel membership is implicit (everyone in the tenant, space or course), so only the
-- per-user state needs a row.
create table if not exists channel_participants (
  channel_id           uuid        not null references channels (id) on delete cascade,
  user_id              uuid        not null references users (id) on delete cascade,
  muted                boolean     not null default false,
  last_read_at         timestamptz,
  last_read_message_id uuid,
  muted_until          timestamptz,               -- moderation mute, not a preference
  primary key (channel_id, user_id)
);

-- ---------------------------------------------------------------- --
-- Messages
-- ---------------------------------------------------------------- --
create table if not exists messages (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  conversation_id uuid        references conversations (id) on delete cascade,
  channel_id      uuid        references channels (id) on delete cascade,
  sender_id       uuid        not null references users (id),
  body            text        not null default '',
  reply_to_id     uuid        references messages (id) on delete set null,
  mentions        uuid[]      not null default '{}',
  -- Client-generated. At-least-once delivery from the outbox becomes exactly-once here.
  client_id       text,
  created_at      timestamptz not null default now(),
  edited_at       timestamptz,
  deleted_at      timestamptz,
  deleted_by      uuid        references users (id) on delete set null,
  delete_reason   text,
  legal_hold      boolean     not null default false,
  constraint messages_scope_check check (
    (conversation_id is not null and channel_id is null) or
    (conversation_id is null and channel_id is not null)
  )
);

-- The index the whole product leans on: keyset paging by (scope, created_at, id) stays
-- flat when a channel reaches six figures.
create index if not exists messages_conversation_keyset_idx
  on messages (conversation_id, created_at desc, id desc) where conversation_id is not null;
create index if not exists messages_channel_keyset_idx
  on messages (channel_id, created_at desc, id desc) where channel_id is not null;

create unique index if not exists messages_client_id_key
  on messages (sender_id, client_id) where client_id is not null;

-- Retention sweeps by age within a tenant.
create index if not exists messages_retention_idx
  on messages (tenant_id, created_at) where deleted_at is null and legal_hold = false;
-- Mentions lookup for the fan-out worker.
create index if not exists messages_mentions_idx on messages using gin (mentions);

create table if not exists message_attachments (
  message_id uuid    not null references messages (id) on delete cascade,
  asset_id   uuid    not null references assets (id) on delete restrict,
  position   integer not null default 0,
  detached_at timestamptz,                        -- set by retention before the message goes
  primary key (message_id, asset_id)
);

create index if not exists message_attachments_asset_idx on message_attachments (asset_id);

-- Delivered / read markers. Only stored per participant, not per message per participant:
-- a read marker is a position, and storing a row per message per reader is how a chat
-- table becomes the largest table in the database.
create table if not exists message_receipts (
  message_id   uuid        not null references messages (id) on delete cascade,
  user_id      uuid        not null references users (id) on delete cascade,
  delivered_at timestamptz,
  read_at      timestamptz,
  primary key (message_id, user_id)
);

-- ---------------------------------------------------------------- --
-- Per-tenant retention policy, read by pruneChatRetention
-- ---------------------------------------------------------------- --
create table if not exists chat_retention_policies (
  tenant_id      uuid        primary key references tenants (id) on delete cascade,
  -- null or 0 means keep forever. Silence is never consent to delete.
  retention_days integer,
  updated_by     uuid        references users (id) on delete set null,
  updated_at     timestamptz not null default now()
);