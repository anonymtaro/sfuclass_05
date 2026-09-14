-- 005_media.sql — assets (F4)
--
-- `submissions` is in 006_assignments.sql, not here: it references assignments, which do
-- not exist yet. The tree lists it under media because a submission is an upload; the
-- dependency decides where it lands.
--
-- This migration also closes the foreign keys that 003 and 004 left open, now that the
-- assets table exists.

-- ---------------------------------------------------------------- --
-- Assets
-- ---------------------------------------------------------------- --
create table if not exists assets (
  id               uuid        primary key default gen_random_uuid(),
  tenant_id        uuid        not null references tenants (id) on delete cascade,
  owner_id         uuid        references users (id) on delete set null,
  purpose          text        not null,
  context_id       uuid,                          -- lesson, assignment, conversation…
  filename         text        not null,
  content_type     text        not null,
  size_bytes       bigint      not null default 0,
  checksum_sha256  text,
  -- Where the bytes are right now. `raw` and `quarantine` are not reachable by anyone.
  bucket           text        not null,
  object_key       text        not null,
  status           text        not null default 'uploading',
  -- Multipart bookkeeping, so a resumed upload can be signed again and an abandoned one
  -- can be aborted (S3 bills for incomplete multipart uploads until they are).
  upload_id        text,
  reservation_id   uuid,
  transcode_job_id text,
  scan_result      text,
  scanned_at       timestamptz,
  duration_seconds numeric(10, 2),
  language         text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  ready_at         timestamptz,
  deleted_at       timestamptz,
  deleted_reason   text,
  constraint assets_status_check check (
    status in ('uploading', 'processing', 'quarantined', 'rejected', 'ready', 'failed', 'deleted')
  ),
  constraint assets_purpose_check check (
    purpose in ('lesson', 'submission', 'avatar', 'chat', 'post', 'cover', 'recording', 'certificate')
  ),
  constraint assets_object_key unique (bucket, object_key)
);

create index if not exists assets_tenant_status_idx on assets (tenant_id, status) where deleted_at is null;
create index if not exists assets_context_idx on assets (context_id) where context_id is not null;
create index if not exists assets_owner_idx on assets (owner_id, created_at desc);
-- The reconcile sweeper: anything processing for too long.
create index if not exists assets_processing_idx on assets (updated_at) where status = 'processing';
-- The stale-upload sweeper.
create index if not exists assets_uploading_idx on assets (created_at) where status = 'uploading';

drop trigger if exists assets_set_updated_at on assets;
create trigger assets_set_updated_at before update on assets
  for each row execute function set_updated_at();

-- HLS ladder output, one row per rendition.
create table if not exists asset_renditions (
  id          uuid        primary key default gen_random_uuid(),
  asset_id    uuid        not null references assets (id) on delete cascade,
  label       text        not null,              -- '1080p', '720p', 'audio'
  object_key  text        not null,
  width       integer,
  height      integer,
  bitrate_bps integer,
  size_bytes  bigint      not null default 0,
  created_at  timestamptz not null default now(),
  constraint asset_renditions_key unique (asset_id, label)
);

create table if not exists asset_captions (
  id         uuid        primary key default gen_random_uuid(),
  asset_id   uuid        not null references assets (id) on delete cascade,
  language   text        not null,
  object_key text        not null,
  source     text        not null default 'transcribe',
  created_at timestamptz not null default now(),
  constraint asset_captions_key unique (asset_id, language),
  constraint asset_captions_source_check check (source in ('transcribe', 'upload', 'manual'))
);

-- ---------------------------------------------------------------- --
-- Storage accounting
-- ---------------------------------------------------------------- --

-- Reserved before presigning, released when the upload completes or is abandoned. Without
-- this, ten parallel uploads all pass a quota check that only one of them should.
create table if not exists storage_reservations (
  id         uuid        primary key default gen_random_uuid(),
  tenant_id  uuid        not null references tenants (id) on delete cascade,
  user_id    uuid        references users (id) on delete set null,
  bytes      bigint      not null,
  purpose    text,
  created_at timestamptz not null default now(),
  settled_at timestamptz
);

create index if not exists storage_reservations_open_idx
  on storage_reservations (tenant_id) where settled_at is null;
create index if not exists storage_reservations_stale_idx
  on storage_reservations (created_at) where settled_at is null;

-- The counter the quota gate reads. Authoritative until the nightly recount disagrees.
create table if not exists storage_usage (
  tenant_id      uuid        primary key references tenants (id) on delete cascade,
  used_bytes     bigint      not null default 0,
  recomputed_at  timestamptz,
  last_drift_bytes bigint    not null default 0,
  updated_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------- --
-- Download audit — append-only, read by security review
-- ---------------------------------------------------------------- --
create table if not exists asset_downloads (
  id           bigserial   primary key,
  asset_id     uuid        not null references assets (id) on delete cascade,
  user_id      uuid        references users (id) on delete set null,
  tenant_id    uuid        not null,
  ip           inet,
  user_agent   text,
  disposition  text,
  created_at   timestamptz not null default now()
);

create index if not exists asset_downloads_asset_idx on asset_downloads (asset_id, created_at desc);
create index if not exists asset_downloads_user_idx on asset_downloads (user_id, created_at desc);

-- ---------------------------------------------------------------- --
-- Close the foreign keys left open by 003 and 004
-- ---------------------------------------------------------------- --
alter table courses
  drop constraint if exists courses_cover_asset_fk,
  add  constraint courses_cover_asset_fk
       foreign key (cover_asset_id) references assets (id) on delete set null;

alter table lessons
  drop constraint if exists lessons_asset_fk,
  add  constraint lessons_asset_fk
       foreign key (asset_id) references assets (id) on delete set null;

alter table post_attachments
  drop constraint if exists post_attachments_asset_fk,
  add  constraint post_attachments_asset_fk
       foreign key (asset_id) references assets (id) on delete cascade;