-- 007_progress.sql — lesson_progress (F3)
-- Plus the rolled-up course progress and the certificates that completion produces.

create table if not exists lesson_progress (
  user_id          uuid        not null references users (id) on delete cascade,
  lesson_id        uuid        not null references lessons (id) on delete cascade,
  course_id        uuid        not null references courses (id) on delete cascade,
  -- Monotonic: the service keeps the furthest position it has seen, so a replayed offline
  -- heartbeat can never rewind a learner.
  position_seconds integer     not null default 0,
  watched_seconds  integer     not null default 0,
  completed_at     timestamptz,
  score            numeric(6, 2),
  client_id        text,
  first_seen_at    timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  primary key (user_id, lesson_id)
);

-- "Continue where I left off" reads this ordering directly.
create index if not exists lesson_progress_resume_idx
  on lesson_progress (user_id, updated_at desc) where completed_at is null;
create index if not exists lesson_progress_course_idx on lesson_progress (course_id, user_id);

drop trigger if exists lesson_progress_set_updated_at on lesson_progress;
create trigger lesson_progress_set_updated_at before update on lesson_progress
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- --
-- Rolled-up per course
-- ---------------------------------------------------------------- --

-- Denormalised on purpose: a dashboard listing twenty courses must not count lessons
-- twenty times. Recomputed by ProgressService on every completion, and repairable.
create table if not exists course_progress (
  user_id          uuid        not null references users (id) on delete cascade,
  course_id        uuid        not null references courses (id) on delete cascade,
  lessons_total    integer     not null default 0,
  lessons_complete integer     not null default 0,
  percent          numeric(5, 2) not null default 0,
  started_at       timestamptz not null default now(),
  completed_at     timestamptz,
  updated_at       timestamptz not null default now(),
  primary key (user_id, course_id)
);

create index if not exists course_progress_completed_idx
  on course_progress (course_id) where completed_at is not null;

-- ---------------------------------------------------------------- --
-- Certificates
-- ---------------------------------------------------------------- --
create table if not exists certificates (
  id              uuid        primary key default gen_random_uuid(),
  tenant_id       uuid        not null references tenants (id) on delete cascade,
  user_id         uuid        not null references users (id) on delete cascade,
  course_id       uuid        references courses (id) on delete set null,
  path_id         uuid        references learning_paths (id) on delete set null,
  -- Public, human-quotable, and not guessable from a sequence.
  serial          text        not null,
  holder_name     text        not null,           -- frozen at issue time
  course_title    text        not null,           -- frozen: renaming a course must not
                                                  -- rewrite a certificate already issued
  asset_id        uuid        references assets (id) on delete set null,
  issued_at       timestamptz not null default now(),
  revoked_at      timestamptz,
  revoked_reason  text,
  constraint certificates_serial_key unique (serial),
  constraint certificates_once_key unique (user_id, course_id)
);

create index if not exists certificates_user_idx on certificates (user_id, issued_at desc);
-- Public verification looks up by serial; the unique index above serves it.