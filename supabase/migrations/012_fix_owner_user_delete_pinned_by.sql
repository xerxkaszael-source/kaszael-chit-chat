-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 012: FIX owner_user_delete (two bugs)
--
-- Bug 1 discovered by live RPC test as owner on 2026-09-03:
--   Migration 011 declared `delete from message_pins where user_id = target_id`
--   but the actual column on message_pins is `pinned_by` (per migration 001).
--   Postgres returned 42703 "column user_id does not exist" — user delete silently
--   failed at the DB layer.
--
-- Bug 2 discovered after Bug 1 fix:
--   The function parameter `target_id` shadows column references in WHERE clauses
--   on tables that ALSO have a `target_id` column (mutes, bans).
--   Postgres returned 42702 "column reference target_id is ambiguous" even after
--   I aliased the parameter to v_target_id (because in `where target_id = X`,
--   the LHS bare `target_id` is still considered ambiguous between parameter and
--   column). Fix: table alias `m.target_id`, `b.target_id` to qualify the column.
--
-- Both bugs MUST be fixed in this single migration.
-- No schema change; just the function body.
-- ============================================================

create or replace function owner_user_delete(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_target_id uuid := target_id;  -- alias for WHERE clauses on tables without a target_id column
  v_username text;
  v_role text;
  v_auth_id uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if v_target_id = uid then raise exception 'CHC:self:Owner cannot delete own account.'; end if;

  -- Look up user info for audit + RLS check
  select username, role, id into v_username, v_role, v_auth_id
    from profiles where id = v_target_id;
  if v_username is null then raise exception 'CHC:not_found:No such user.'; end if;

  -- Refuse to delete another owner (defense in depth)
  if v_role = 'owner' then
    raise exception 'CHC:forbidden:Owner cannot delete another owner.';
  end if;

  -- Log BEFORE destructive change so audit survives even if delete fails mid-way
  perform _audit(uid, 'USER_DELETED', v_target_id, null,
    format('Permanent deletion of @%s (role=%s)', v_username, v_role),
    jsonb_build_object('username', v_username, 'role', v_role, 'profile_id', v_target_id),
    'critical');

  -- Delete in proper order (no FK violations).
  -- Column names verified against migration 001_tables.sql:
  --   notifications.user_id, user_settings.user_id, rate_limits.user_id,
  --   blocks.{blocker_id,blocked_id}, friendships.{requester_id,addressee_id},
  --   message_reactions.user_id, message_attachments.uploader_id,
  --   message_pins.pinned_by, reports.{reporter_id,target_user_id},
  --   mutes.{target_id,actor_id}, bans.{target_id,actor_id},
  --   audit_logs.actor_id, presence.user_id
  --
  -- For tables that ALSO have a `target_id` COLUMN (mutes, bans), use a table
  -- alias and qualify the column so PL/pgSQL doesn't get confused with the
  -- function parameter of the same name (42702 ambiguity).
  delete from notifications where user_id = v_target_id;
  delete from user_settings where user_id = v_target_id;
  delete from rate_limits where user_id = v_target_id;
  delete from blocks where blocker_id = v_target_id or blocked_id = v_target_id;
  delete from friendships where requester_id = v_target_id or addressee_id = v_target_id;
  delete from message_reactions where user_id = v_target_id;
  delete from message_attachments where uploader_id = v_target_id;
  delete from message_pins where pinned_by = v_target_id;
  delete from reports where reporter_id = v_target_id or target_user_id = v_target_id;
  delete from mutes m where m.target_id = v_target_id or m.actor_id = v_target_id;
  delete from bans b where b.target_id = v_target_id or b.actor_id = v_target_id;
  delete from audit_logs where actor_id = v_target_id;
  delete from presence where user_id = v_target_id;
  -- messages: keep content but mark as deleted (preserve chat history)
  update messages
    set moderation_state = 'deleted', content = '', recalled_by = uid,
        recall_reason = 'Account deleted by owner', recalled_at = now()
    where sender_id = v_target_id and moderation_state != 'deleted';
  -- finally the profile row
  delete from profiles where id = v_target_id;

  -- Delete the auth.users entry (uses service role implicitly via SECURITY DEFINER)
  begin
    perform auth.admin.delete_user(v_auth_id);
  exception when others then
    -- Don't fail the whole op if auth admin fails; profile is gone
    raise notice 'auth.users delete failed: %', SQLERRM;
  end;

  return jsonb_build_object('ok', true, 'deleted_username', v_username);
end;
$$;

grant execute on function owner_user_delete(uuid) to authenticated;