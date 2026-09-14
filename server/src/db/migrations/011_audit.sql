-- 011_audit.sql — append-only audit trail (F7)  [ADDITION — not in the v6 tree]
--
-- security/auditLog.js has no table to write to without this. The tree lists the module but
-- no migration for it, which is the gap this closes.

create table if not exists audit_log (
  id          bigserial   primary key,
  tenant_id   uuid,                              -- null for platform-level events
  actor_id    uuid,                              -- null for a system action (job, webhook)
  actor_role  text,
  action      text        not null,
  target_type text,
  target_id   uuid,
  metadata    jsonb       not null default '{}'::jsonb,
  ip          inet,
  user_agent  text,
  request_id  text,
  trace_id    text,                              -- joins a row to its X-Ray trace
  created_at  timestamptz not null default now()
);

-- No foreign keys to users or tenants on purpose. An audit row must survive the deletion
-- of the account it describes — "who deleted this account" is exactly the row that a
-- cascade would remove.

create index if not exists audit_log_tenant_idx  on audit_log (tenant_id, id desc);
create index if not exists audit_log_actor_idx   on audit_log (actor_id, id desc);
create index if not exists audit_log_action_idx  on audit_log (action, id desc);
create index if not exists audit_log_target_idx  on audit_log (target_type, target_id, id desc);
create index if not exists audit_log_time_idx    on audit_log (created_at);
-- Metadata search for investigations; GIN so a jsonb containment query stays usable.
create index if not exists audit_log_metadata_idx on audit_log using gin (metadata jsonb_path_ops);

-- ---------------------------------------------------------------- --
-- Append-only, enforced by grants rather than by convention
-- ---------------------------------------------------------------- --
--
-- Replace `app_user` with the role in DATABASE_URL. Run this as the owner; it is the whole
-- reason the word "append-only" in auditLog.js means anything. Left commented so the
-- migration does not fail on an environment where the role has a different name.
--
--   revoke update, delete, truncate on audit_log from app_user;
--   grant  insert, select            on audit_log to app_user;
--   grant  usage, select             on sequence audit_log_id_seq to app_user;
--
-- Retention is a partition drop, not a DELETE — the role above cannot DELETE, which is the
-- point. When this table gets large enough to matter, convert it to monthly partitions and
-- drop the oldest partition as the owner.