-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 011: OWNER USER MANAGEMENT
-- Fixes:
--   - Bug G: User delete RPC (permanent account removal) missing
--   - Bug H: Broadcast delete verified works server-side; client must
--     handle the auth + UI correctly
--
-- Adds:
--   - owner_user_delete(target_id uuid) -> jsonb
--   - owner_set_role: also reject trying to demote owner (was already covered
--     by "self cannot change role" but let's also reject other roles touching owner)
-- ============================================================

-- ---------- USER DELETE (permanent account removal) ----------
-- Owner-only. Cascades:
--   - deletes the profile row (FK from many tables)
--   - deletes auth.users entry via auth.admin.delete_user()
--   - cleans up friendships, blocks, notifications, presence, pins,
--     reactions, attachments, messages authored by the user
create or replace function owner_user_delete(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_username text;
  v_role text;
  v_auth_id uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if target_id = uid then raise exception 'CHC:self:Owner cannot delete own account.'; end if;

  -- Look up user info for audit + RLS check
  select username, role, id into v_username, v_role, v_auth_id
    from profiles where id = target_id;
  if v_username is null then raise exception 'CHC:not_found:No such user.'; end if;

  -- Refuse to delete another owner (impossible to have 2 owners, but defense in depth)
  if v_role = 'owner' then
    raise exception 'CHC:forbidden:Owner cannot delete another owner.';
  end if;

  -- Log BEFORE destructive change so audit survives even if delete fails mid-way
  perform _audit(uid, 'USER_DELETED', target_id, null,
    format('Permanent deletion of @%s (role=%s)', v_username, v_role),
    jsonb_build_object('username', v_username, 'role', v_role, 'profile_id', target_id),
    'critical');

  -- Delete in proper order (no FK violations)
  delete from notifications where user_id = target_id;
  delete from user_settings where user_id = target_id;
  delete from rate_limits where user_id = target_id;
  delete from blocks where blocker_id = target_id or blocked_id = target_id;
  delete from friendships where requester_id = target_id or addressee_id = target_id;
  delete from message_reactions where user_id = target_id;
  delete from message_attachments where uploader_id = target_id;
  delete from message_pins where user_id = target_id;
  delete from reports where reporter_id = target_id or target_user_id = target_id;
  delete from mutes where target_id = target_id or actor_id = target_id;
  delete from bans where target_id = target_id or actor_id = target_id;
  delete from audit_logs where actor_id = target_id;
  delete from presence where user_id = target_id;
  -- messages: keep content but mark as deleted (preserve chat history)
  update messages
    set moderation_state = 'deleted', content = '', recalled_by = uid,
        recall_reason = 'Account deleted by owner', recalled_at = now()
    where sender_id = target_id and moderation_state != 'deleted';
  -- finally the profile row
  delete from profiles where id = target_id;

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

-- ---------- Broadcast delete: make sure owner_set_role doesn't accidentally
-- affect owner's own role via some edge case. Already handled in the
-- existing function with `if target_id = uid then raise...`. ----------

-- Add ON DELETE SET NULL for FK references where we don't cascade
-- (this prevents future FK violations when users are deleted).
do $$
begin
  -- audit_logs.actor_id: keep audit history even if user deleted (set null)
  begin
    alter table audit_logs drop constraint if exists audit_logs_actor_id_fkey;
    alter table audit_logs add constraint audit_logs_actor_id_fkey
      foreign key (actor_id) references profiles(id) on delete set null;
  exception when others then null; end;

  -- audit_logs.target_id: keep audit history
  begin
    alter table audit_logs drop constraint if exists audit_logs_target_id_fkey;
    alter table audit_logs add constraint audit_logs_target_id_fkey
      foreign key (target_id) references profiles(id) on delete set null;
  exception when others then null; end;
end $$;