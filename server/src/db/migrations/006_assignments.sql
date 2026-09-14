-- 006_assignments.sql — assignments · submissions · grades (F4)

create table if not exists assignments (
  id                 uuid        primary key default gen_random_uuid(),
  tenant_id          uuid        not null references tenants (id) on delete cascade,
  course_id          uuid        not null references courses (id) on delete cascade,
  lesson_id          uuid        references lessons (id) on delete set null,
  title              text        not null,
  instructions       text,
  due_at             timestamptz,
  time_zone          text,                        -- the zone the due date was set in
  max_points         numeric(6, 2) not null default 100,
  allow_late         boolean     not null default false,
  allow_resubmission boolean     not null default true,
  max_attachments    integer     not null default 5,
  rubric             jsonb,
  status             text        not null default 'draft',
  created_by         uuid        not null references users (id),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  archived_at        timestamptz,
  constraint assignments_status_check check (status in ('draft', 'open', 'closed'))
);

create index if not exists assignments_course_idx
  on assignments (course_id, due_at) where archived_at is null;
create index if not exists assignments_due_idx
  on assignments (due_at) where status = 'open' and archived_at is null;

drop trigger if exists assignments_set_updated_at on assignments;
create trigger assignments_set_updated_at before update on assignments
  for each row execute function set_updated_at();

-- ---------------------------------------------------------------- --
-- Submissions
-- ---------------------------------------------------------------- --
create table if not exists submissions (
  id             uuid        primary key default gen_random_uuid(),
  assignment_id  uuid        not null references assignments (id) on delete cascade,
  user_id        uuid        not null references users (id) on delete cascade,
  attempt        integer     not null default 1,
  note           text,
  status         text        not null default 'submitted',
  -- Recorded at submit time rather than derived later: moving a due date must not
  -- retroactively make an on-time submission late.
  late           boolean     not null default false,
  client_id      text,                            -- dedupe key for the offline outbox
  submitted_at   timestamptz not null default now(),
  returned_at    timestamptz,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint submissions_status_check check (
    status in ('draft', 'submitted', 'returned', 'graded')
  ),
  constraint submissions_attempt_key unique (assignment_id, user_id, attempt)
);

-- One current submission per learner per assignment; older attempts are kept as history.
create index if not exists submissions_current_idx
  on submissions (assignment_id, user_id, attempt desc);
create index if not exists submissions_grading_queue_idx
  on submissions (assignment_id, submitted_at) where status = 'submitted';
create unique index if not exists submissions_client_id_key
  on submissions (user_id, client_id) where client_id is not null;

create table if not exists submission_assets (
  submission_id uuid    not null references submissions (id) on delete cascade,
  asset_id      uuid    not null references assets (id) on delete restrict,
  position      integer not null default 0,
  primary key (submission_id, asset_id)
);

-- restrict, not cascade: a graded submission must not lose its evidence because someone
-- deleted the asset from their media library.

-- ---------------------------------------------------------------- --
-- Grades
-- ---------------------------------------------------------------- --
create table if not exists grades (
  id            uuid        primary key default gen_random_uuid(),
  submission_id uuid        not null references submissions (id) on delete cascade,
  grader_id     uuid        references users (id) on delete set null,
  score         numeric(6, 2) not null,
  feedback      text,
  rubric_scores jsonb,
  -- A draft grade is visible to the teacher only. Publishing is what the learner sees.
  published_at  timestamptz,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  constraint grades_submission_key unique (submission_id)
);

create index if not exists grades_published_idx on grades (submission_id) where published_at is not null;

drop trigger if exists grades_set_updated_at on grades;
create trigger grades_set_updated_at before update on grades
  for each row execute function set_updated_at();