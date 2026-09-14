-- 004_community.sql — spaces … memberships (F2)
-- Also carries notifications and notification preferences: they are produced by the
-- community domain and consumed by the notification worker, and they have no other home.

-- ---------------------------------------------------------------- --
-- Spaces
-- ---------------------------------------------------------------- --
create table if not exists spaces (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  course_id   uuid        references courses (id) on delete cascade,  -- null = standalone
  name        text        not null,
  description text,
  visibility  text        not null default 'open',
  created_by  uuid        references users (id),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  archived_at timestamptz,
  constraint spaces_visibility_check check (visibility in ('open', 'closed'))
);

-- One auto-provisioned space per course, created when the course is published.
create unique index if not exists spaces_course_key on spaces (course_id) where course_id is not null;
create index if not exists spaces_tenant_idx on spaces (tenant_id) where archived_at is null;

create table if not exists memberships (
  space_id  uuid        not null references spaces (id) on delete cascade,
  user_id   uuid        not null references users (id) on delete cascade,
  role      text        not null default 'member',
  muted     boolean     not null default false,
  joined_at timestamptz not null default now(),
  primary key (space_id, user_id),
  constraint memberships_role_check check (role in ('owner', 'moderator', 'member'))
);

create index if not exists memberships_user_idx on memberships (user_id);

-- ---------------------------------------------------------------- --
-- Threads and posts
-- ---------------------------------------------------------------- --
create table if not exists threads (
  id             uuid        primary key default gen_random_uuid(),
  space_id       uuid        not null references spaces (id) on delete cascade,
  title          text        not null,
  author_id      uuid        not null references users (id),
  pinned         boolean     not null default false,
  locked         boolean     not null default false,
  post_count     integer     not null default 0,
  last_post_at   timestamptz not null default now(),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  deleted_at     timestamptz
);

-- Two orderings the feed actually uses: most recently active, and newest.
create index if not exists threads_space_active_idx
  on threads (space_id, pinned desc, last_post_at desc, id desc) where deleted_at is null;
create index if not exists threads_space_created_idx
  on threads (space_id, created_at desc, id desc) where deleted_at is null;

create table if not exists posts (
  id          uuid        primary key default gen_random_uuid(),
  thread_id   uuid        not null references threads (id) on delete cascade,
  author_id   uuid        not null references users (id),
  reply_to_id uuid        references posts (id) on delete set null,
  body        text        not null,
  client_id   text,                              -- dedupe key for the offline outbox
  created_at  timestamptz not null default now(),
  edited_at   timestamptz,
  deleted_at  timestamptz,
  deleted_by  uuid        references users (id)
);

-- Keyset pagination inside a thread.
create index if not exists posts_thread_keyset_idx on posts (thread_id, created_at, id);
create index if not exists posts_author_idx on posts (author_id, created_at desc);
create unique index if not exists posts_client_id_key
  on posts (author_id, client_id) where client_id is not null;

create table if not exists post_attachments (
  post_id  uuid not null references posts (id) on delete cascade,
  asset_id uuid not null,                        -- fk added in 005
  position integer not null default 0,
  primary key (post_id, asset_id)
);

create table if not exists post_reactions (
  post_id    uuid        not null references posts (id) on delete cascade,
  user_id    uuid        not null references users (id) on delete cascade,
  emoji      text        not null,
  created_at timestamptz not null default now(),
  primary key (post_id, user_id, emoji)
);

-- ---------------------------------------------------------------- --
-- Moderation
-- ---------------------------------------------------------------- --
create table if not exists community_reports (
  id          uuid        primary key default gen_random_uuid(),
  tenant_id   uuid        not null references tenants (id) on delete cascade,
  target_type text        not null,
  target_id   uuid        not null,
  reporter_id uuid        not null references users (id),
  reason      text        not null,
  note        text,
  status      text        not null default 'open',
  resolved_by uuid        references users (id),
  resolved_at timestamptz,
  resolution  text,
  created_at  timestamptz not null default now(),
  constraint community_reports_target_check check (target_type in ('post', 'thread', 'space', 'user')),
  constraint community_reports_status_check check (status in ('open', 'resolved', 'dismissed'))
);

create index if not exists community_reports_queue_idx
  on community_reports (tenant_id, created_at desc) where status = 'open';
-- Retention checks "is this under an open report" by target.
create index if not exists community_reports_target_idx on community_reports (target_type, target_id);

-- ---------------------------------------------------------------- --
-- Notifications
-- ---------------------------------------------------------------- --
create table if not exists notifications (
  id         uuid        primary key default gen_random_uuid(),
  user_id    uuid        not null references users (id) on delete cascade,
  kind       text        not null,
  title      text        not null,
  body       text,
  url        text,
  actor_id   uuid        references users (id) on delete set null,
  data       jsonb       not null default '{}'::jsonb,
  read_at    timestamptz,
  created_at timestamptz not null default now()
);

create index if not exists notifications_user_unread_idx
  on notifications (user_id, created_at desc) where read_at is null;
create index if not exists notifications_user_keyset_idx on notifications (user_id, created_at desc, id desc);

create table if not exists notification_preferences (
  user_id      uuid        primary key references users (id) on delete cascade,
  digest       text        not null default 'daily',
  send_hour    integer     not null default 8,     -- local to users.time_zone
  channels     jsonb       not null default '{}'::jsonb,  -- { kind: { push: bool, email: bool } }
  quiet_start  time,
  quiet_end    time,
  email_suppressed_at timestamptz,                 -- set by an SES bounce or complaint
  updated_at   timestamptz not null default now(),
  constraint notification_preferences_digest_check check (digest in ('off', 'daily', 'weekly')),
  constraint notification_preferences_hour_check check (send_hour between 0 and 23)
);

-- The digest dispatcher selects by (zone, hour); the zone lives on users.
create index if not exists notification_preferences_digest_idx
  on notification_preferences (digest, send_hour) where digest <> 'off';