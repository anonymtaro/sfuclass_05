-- 003_courses.sql — courses … enrollments (F3)
--
-- `cover_asset_id` and `lessons.asset_id` have no foreign key yet: assets arrive in
-- 005_media.sql, which adds the constraints. Ordering, not an oversight.

-- ---------------------------------------------------------------- --
-- Courses and versions
-- ---------------------------------------------------------------- --
create table if not exists courses (
  id             uuid        primary key default gen_random_uuid(),
  tenant_id      uuid        not null references tenants (id) on delete cascade,
  title          text        not null,
  summary        text,
  cover_asset_id uuid,
  visibility     text        not null default 'tenant',
  status         text        not null default 'draft',
  current_version integer    not null default 0,
  created_by     uuid        not null references users (id),
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  published_at   timestamptz,
  archived_at    timestamptz,
  constraint courses_visibility_check check (visibility in ('private', 'tenant', 'public')),
  constraint courses_status_check     check (status in ('draft', 'published', 'archived'))
);

create index if not exists courses_tenant_status_idx
  on courses (tenant_id, status) where archived_at is null;

drop trigger if exists courses_set_updated_at on courses;
create trigger courses_set_updated_at before update on courses
  for each row execute function set_updated_at();

-- A published version is a snapshot, so editing the draft never changes what learners see.
create table if not exists course_versions (
  id           uuid        primary key default gen_random_uuid(),
  course_id    uuid        not null references courses (id) on delete cascade,
  version      integer     not null,
  snapshot     jsonb       not null,
  note         text,
  published_by uuid        references users (id),
  published_at timestamptz not null default now(),
  constraint course_versions_key unique (course_id, version)
);

-- ---------------------------------------------------------------- --
-- Structure
-- ---------------------------------------------------------------- --
create table if not exists modules (
  id         uuid        primary key default gen_random_uuid(),
  course_id  uuid        not null references courses (id) on delete cascade,
  title      text        not null,
  position   integer     not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create index if not exists modules_course_position_idx
  on modules (course_id, position) where deleted_at is null;

create table if not exists lessons (
  id               uuid        primary key default gen_random_uuid(),
  course_id        uuid        not null references courses (id) on delete cascade,
  module_id        uuid        not null references modules (id) on delete cascade,
  title            text        not null,
  type             text        not null,
  position         integer     not null default 0,
  asset_id         uuid,                         -- fk added in 005
  duration_minutes integer,
  body             jsonb       not null default '{}'::jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  deleted_at       timestamptz,
  constraint lessons_type_check check (type in ('live', 'video', 'doc', 'quiz', 'task'))
);

create index if not exists lessons_module_position_idx
  on lessons (module_id, position) where deleted_at is null;
create index if not exists lessons_course_type_idx on lessons (course_id, type);

drop trigger if exists lessons_set_updated_at on lessons;
create trigger lessons_set_updated_at before update on lessons
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- --
-- Learning paths — a DAG over modules
-- ---------------------------------------------------------------- --
create table if not exists learning_paths (
  id         uuid        primary key default gen_random_uuid(),
  course_id  uuid        not null references courses (id) on delete cascade,
  title      text        not null default 'Default path',
  created_at timestamptz not null default now()
);

create table if not exists path_edges (
  path_id        uuid not null references learning_paths (id) on delete cascade,
  from_module_id uuid not null references modules (id) on delete cascade,
  to_module_id   uuid not null references modules (id) on delete cascade,
  primary key (path_id, from_module_id, to_module_id),
  -- Self-edges are the one cycle the database can catch. Longer cycles are checked in
  -- CurriculumGraph before publishing, because Postgres cannot express that constraint.
  constraint path_edges_no_self_loop check (from_module_id <> to_module_id)
);

create index if not exists path_edges_to_idx on path_edges (to_module_id);

-- ---------------------------------------------------------------- --
-- Enrollments
-- ---------------------------------------------------------------- --
create table if not exists enrollments (
  id           uuid        primary key default gen_random_uuid(),
  course_id    uuid        not null references courses (id) on delete cascade,
  user_id      uuid        not null references users (id) on delete cascade,
  status       text        not null default 'active',
  enrolled_by  uuid        references users (id),
  enrolled_at  timestamptz not null default now(),
  completed_at timestamptz,
  constraint enrollments_status_check check (status in ('active', 'completed', 'withdrawn')),
  constraint enrollments_key unique (course_id, user_id)
);

-- Drives "my courses" and the audience resolution for scheduled sessions.
create index if not exists enrollments_user_idx on enrollments (user_id, status);