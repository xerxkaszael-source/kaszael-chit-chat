-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 012: APPLY FK constraints to audit_logs
-- Migration 011 attempted to add FK constraints with `ON DELETE SET NULL`
-- but the `exception when others then null` block silently swallowed the
-- error. The actual issue was: existing rows in audit_logs had
-- actor_id / target_id values pointing to profiles that were already
-- deleted (orphan FK references). Postgres rejected the FK creation
-- because those orphan rows would violate referential integrity.
--
-- This migration:
--   1. Nulls out orphan FK references in audit_logs
--   2. Adds the FK constraints with ON DELETE SET NULL
-- ============================================================

-- 1. null out orphan FK references
update audit_logs
set actor_id = null
where actor_id is not null
  and actor_id not in (select id from profiles);

update audit_logs
set target_id = null
where target_id is not null
  and target_id not in (select id from profiles);

-- 2. add FK constraints (now safe — no orphan rows)
alter table audit_logs
  add constraint audit_logs_actor_id_fkey
  foreign key (actor_id) references profiles(id) on delete set null;

alter table audit_logs
  add constraint audit_logs_target_id_fkey
  foreign key (target_id) references profiles(id) on delete set null;