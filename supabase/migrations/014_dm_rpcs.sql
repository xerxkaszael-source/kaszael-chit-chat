-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 014: DM RPCs
-- All DM mutations go through SECURITY DEFINER functions.
-- Friends-only default for DM creation (matches brief §10).
-- Pattern: caller is auth.uid(), permissions check inside function.
-- ============================================================

-- Helper: check if user A and user B can DM each other.
-- Returns: 'ok' | 'self' | 'blocked' | 'not_friends' | 'banned' | 'muted'
create or replace function _dm_allowed(uid_a uuid, uid_b uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_a_active boolean;
  v_b_blocked boolean;
  v_role_a text;
begin
  if uid_a = uid_b then return 'self'; end if;

  -- either side banned?
  if exists(select 1 from _active_ban(uid_a)) then return 'banned'; end if;
  if exists(select 1 from _active_ban(uid_b)) then return 'banned'; end if;

  -- either side muted (no new messages, but can still read)?
  if exists(select 1 from _active_mute(uid_a)) then return 'muted'; end if;

  -- block check (either direction)
  v_b_blocked := exists(
    select 1 from blocks where (blocker_id = uid_a and blocked_id = uid_b)
                           or (blocker_id = uid_b and blocked_id = uid_a)
  );
  if v_b_blocked then return 'blocked'; end if;

  -- staff (owner/admin/mod/helper) can DM anyone regardless of friend state
  select role into v_role_a from profiles where id = uid_a;
  if v_role_a in ('owner','admin','moderator','helper') then return 'ok'; end if;

  -- friends-only default: must be in accepted friendship
  if exists(
    select 1 from friendships
    where status = 'accepted'
      and ((requester_id = uid_a and addressee_id = uid_b)
           or (requester_id = uid_b and addressee_id = uid_a))
  ) then
    return 'ok';
  end if;

  return 'not_friends';
end;
$$;

-- ---------- 1. conversation_get_or_create ----------
-- Returns the canonical conversation between me (auth.uid()) and v_other_id.
-- Creates one if missing. Respects _dm_allowed (friends-only default).
create or replace function conversation_get_or_create(v_other_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_conv_id uuid;
  v_check text;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  -- rate limit: max 5 new conversations per hour per user
  if not _rate_check(v_me, 'dm_new_conv', 3600, 5) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  v_check := _dm_allowed(v_me, v_other_id);
  if v_check <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_check);
  end if;

  -- look for existing conversation we both (actively) belong to
  select cm1.conversation_id into v_conv_id
  from conversation_members cm1
  join conversation_members cm2 on cm2.conversation_id = cm1.conversation_id
                              and cm2.user_id = v_other_id
                              and cm2.left_at is null
  where cm1.user_id = v_me and cm1.left_at is null
  limit 1;

  if v_conv_id is null then
    -- create new conversation + add both members atomically
    insert into conversations (id, kind) values (gen_random_uuid(), 'dm') returning id into v_conv_id;
    insert into conversation_members (conversation_id, user_id) values (v_conv_id, v_me);
    -- the trigger may rewrite this if a stale row exists; refresh
    select conversation_id into v_conv_id from conversation_members
    where conversation_id = v_conv_id and user_id = v_me;
    -- second insert (after possible redirect by trigger)
    insert into conversation_members (conversation_id, user_id)
      select cm.conversation_id, v_other_id
      from conversation_members cm where cm.user_id = v_me limit 1
      on conflict do nothing;
    perform _audit(v_me, 'DM_CONV_CREATED', v_other_id, null, '', jsonb_build_object('conversation_id', v_conv_id));
  end if;

  return jsonb_build_object('ok', true, 'conversation_id', v_conv_id);
end;
$$;

-- ---------- 2. inbox_list ----------
-- Returns all conversations the user is an active member of, with last message
-- preview + unread count + per-row flags (pinned/muted/archived).
create or replace function inbox_list()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select coalesce(jsonb_agg(row order by row->>'sort_key'), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'conversation_id', c.id,
      'other_user_id', (
        select cm2.user_id from conversation_members cm2
        where cm2.conversation_id = c.id and cm2.user_id <> v_me and cm2.left_at is null
        limit 1
      ),
      'other_username', (
        select p.username from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me and cm2.left_at is null
        limit 1
      ),
      'other_display_name', (
        select p.display_name from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me and cm2.left_at is null
        limit 1
      ),
      'other_avatar_color', (
        select p.avatar_color from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me and cm2.left_at is null
        limit 1
      ),
      'last_message_preview', c.last_message_preview,
      'last_message_at', c.last_message_at,
      'last_message_sender', (
        select sender_id from direct_messages
        where conversation_id = c.id order by created_at desc limit 1
      ),
      'pinned', cm.pinned,
      'muted', cm.muted,
      'archived', cm.archived,
      'unread_count', (
        select count(*) from direct_messages dm
        where dm.conversation_id = c.id
          and dm.sender_id <> v_me
          and dm.moderation_state = 'visible'
          and not exists (
            select 1 from message_reads mr
            where mr.message_id = dm.id and mr.user_id = v_me
          )
      ),
      'sort_key', lpad(extract(epoch from coalesce(c.last_message_at, c.created_at))::text, 20, '0')
    ) as row
    from conversation_members cm
    join conversations c on c.id = cm.conversation_id
    where cm.user_id = v_me and cm.left_at is null
    order by cm.pinned desc, c.last_message_at desc nulls last, c.created_at desc
  ) t;

  return jsonb_build_object('ok', true, 'conversations', v_result);
end;
$$;

-- ---------- 3. dm_send ----------
-- Send a message in a conversation. Triggers last_message_at update.
create or replace function dm_send(v_conv_id uuid, v_content text, v_reply_to uuid default null, v_client_msg_id text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_msg_id uuid;
  v_other_id uuid;
  v_check text;
  v_draft_row conversation_drafts%rowtype;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  -- content validation
  if v_content is null or length(trim(v_content)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_content');
  end if;
  if length(v_content) > 4000 then
    return jsonb_build_object('ok', false, 'error', 'too_long');
  end if;

  -- must be an active member
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  -- get other user + check policy
  select user_id into v_other_id from conversation_members
  where conversation_id = v_conv_id and user_id <> v_me and left_at is null limit 1;
  if v_other_id is null then
    return jsonb_build_object('ok', false, 'error', 'invalid_conversation');
  end if;
  v_check := _dm_allowed(v_me, v_other_id);
  if v_check <> 'ok' then
    return jsonb_build_object('ok', false, 'error', v_check);
  end if;

  -- rate limit: max 30 dm per 5 min per user
  if not _rate_check(v_me, 'dm_send', 300, 30) then
    return jsonb_build_object('ok', false, 'error', 'rate_limited');
  end if;

  -- dedup: same client_msg_id within conversation
  if v_client_msg_id is not null then
    select id into v_msg_id from direct_messages
    where conversation_id = v_conv_id and client_msg_id = v_client_msg_id limit 1;
    if v_msg_id is not null then
      return jsonb_build_object('ok', true, 'message_id', v_msg_id, 'dedup', true);
    end if;
  end if;

  insert into direct_messages (conversation_id, sender_id, content, reply_to, client_msg_id)
  values (v_conv_id, v_me, v_content, v_reply_to, v_client_msg_id)
  returning id into v_msg_id;

  update conversations set
    last_message_at = now(),
    last_message_preview = case when length(v_content) > 80 then substr(v_content, 1, 80) || '…' else v_content end
  where id = v_conv_id;

  -- clear sender's draft (if any)
  delete from conversation_drafts where conversation_id = v_conv_id and user_id = v_me;

  perform _notify(v_other_id, 'dm', v_me, jsonb_build_object('conversation_id', v_conv_id, 'message_id', v_msg_id, 'preview', substr(v_content, 1, 80)));

  return jsonb_build_object('ok', true, 'message_id', v_msg_id);
end;
$$;

-- ---------- 4. dm_list ----------
-- Paginate messages in a conversation. before_ts = pagination cursor (older messages).
-- limit default 50, max 100.
create or replace function dm_list(v_conv_id uuid, v_before_ts timestamptz default null, v_limit int default 50)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_limit int := greatest(1, least(v_limit, 100));
  v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'id', dm.id,
      'conversation_id', dm.conversation_id,
      'sender_id', dm.sender_id,
      'sender_username', p.username,
      'sender_display_name', p.display_name,
      'sender_avatar_color', p.avatar_color,
      'content', dm.content,
      'reply_to', dm.reply_to,
      'moderation_state', dm.moderation_state,
      'created_at', dm.created_at,
      'edited_at', dm.edited_at,
      'recalled_at', dm.recalled_at
    ) as row
    from direct_messages dm
    join profiles p on p.id = dm.sender_id
    where dm.conversation_id = v_conv_id
      and (v_before_ts is null or dm.created_at < v_before_ts)
      and (dm.moderation_state <> 'recalled' or dm.sender_id = v_me)
    order by dm.created_at desc
    limit v_limit
  ) t;

  return jsonb_build_object('ok', true, 'messages', v_result);
end;
$$;

-- ---------- 5. dm_edit ----------
create or replace function dm_edit(v_msg_id uuid, v_new_content text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_conv_id uuid;
  v_sender uuid;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select conversation_id, sender_id into v_conv_id, v_sender
  from direct_messages where id = v_msg_id;
  if v_conv_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_sender <> v_me then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;

  if v_new_content is null or length(trim(v_new_content)) = 0 then
    return jsonb_build_object('ok', false, 'error', 'empty_content');
  end if;
  if length(v_new_content) > 4000 then
    return jsonb_build_object('ok', false, 'error', 'too_long');
  end if;

  update direct_messages set content = v_new_content, edited_at = now() where id = v_msg_id;
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 6. dm_delete_own ----------
create or replace function dm_delete_own(v_msg_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_sender uuid;
  v_conv_id uuid;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select sender_id, conversation_id into v_sender, v_conv_id from direct_messages where id = v_msg_id;
  if v_sender is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if v_sender <> v_me then return jsonb_build_object('ok', false, 'error', 'not_owner'); end if;

  -- soft: set to recalled, hard delete after audit. We do hard-delete for own msgs only.
  delete from direct_messages where id = v_msg_id;
  perform _audit(v_me, 'DM_DELETED', null, v_msg_id, '', jsonb_build_object('conversation_id', v_conv_id));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 7. dm_mark_read ----------
-- Marks all unread messages in a conversation as read by the caller, up to a given message.
create or replace function dm_mark_read(v_conv_id uuid, v_through_msg_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_count int;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  with msgs as (
    select dm.id from direct_messages dm
    where dm.conversation_id = v_conv_id
      and dm.sender_id <> v_me
      and dm.moderation_state = 'visible'
      and (v_through_msg_id is null or dm.created_at <= (select created_at from direct_messages where id = v_through_msg_id))
  ), inserted as (
    insert into message_reads (message_id, user_id)
    select id, v_me from msgs
    on conflict do nothing
    returning 1
  )
  select count(*) into v_count from inserted;

  update conversation_members set last_read_at = now(), last_read_message_id = coalesce(v_through_msg_id, last_read_message_id)
  where conversation_id = v_conv_id and user_id = v_me;

  return jsonb_build_object('ok', true, 'marked', v_count);
end;
$$;

-- ---------- 8. draft_get / draft_set ----------
create or replace function draft_get(v_conv_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_draft text;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select draft into v_draft from conversation_drafts where conversation_id = v_conv_id and user_id = v_me;
  return jsonb_build_object('ok', true, 'draft', coalesce(v_draft, ''));
end;
$$;

create or replace function draft_set(v_conv_id uuid, v_draft text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  if length(v_draft) > 4000 then return jsonb_build_object('ok', false, 'error', 'too_long'); end if;

  insert into conversation_drafts (conversation_id, user_id, draft, updated_at)
  values (v_conv_id, v_me, v_draft, now())
  on conflict (conversation_id, user_id) do update set draft = excluded.draft, updated_at = now();

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 9. dm_search ----------
-- Full-text search via the messages tsvector (built later). For now: simple ILIKE on content.
create or replace function dm_search(v_query text, v_limit int default 50)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_me uuid := auth.uid();
  v_limit int := greatest(1, least(v_limit, 100));
  v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if length(v_query) < 2 then return jsonb_build_object('ok', true, 'results', '[]'::jsonb); end if;

  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'message_id', dm.id,
      'conversation_id', dm.conversation_id,
      'sender_id', dm.sender_id,
      'sender_username', p.username,
      'content', dm.content,
      'created_at', dm.created_at
    ) as row
    from direct_messages dm
    join profiles p on p.id = dm.sender_id
    where dm.conversation_id in (
      select conversation_id from conversation_members where user_id = v_me and left_at is null
    )
      and dm.moderation_state = 'visible'
      and dm.content ilike '%' || v_query || '%'
    order by dm.created_at desc
    limit v_limit
  ) t;

  return jsonb_build_object('ok', true, 'results', v_result);
end;
$$;

-- ---------- 10. dm_reaction_toggle ----------
create or replace function dm_reaction_toggle(v_msg_id uuid, v_emoji text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_existing uuid;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not exists(select 1 from message_reads where message_id = v_msg_id and user_id = v_me) and
     not exists(select 1 from direct_messages dm
                join conversation_members cm on cm.conversation_id = dm.conversation_id
                where dm.id = v_msg_id and cm.user_id = v_me and cm.left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  select id into v_existing from message_reactions_dm
  where message_id = v_msg_id and user_id = v_me and emoji = v_emoji limit 1;

  if v_existing is not null then
    delete from message_reactions_dm where id = v_existing;
    return jsonb_build_object('ok', true, 'action', 'removed');
  else
    insert into message_reactions_dm (message_id, user_id, emoji) values (v_msg_id, v_me, v_emoji);
    return jsonb_build_object('ok', true, 'action', 'added');
  end if;
end;
$$;

-- ---------- 11. dm_reactions_for ----------
create or replace function dm_reactions_for(v_msg_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'message_id', mr.message_id,
      'emoji', mr.emoji,
      'count', (select count(*) from message_reactions_dm r2 where r2.message_id = mr.message_id and r2.emoji = mr.emoji),
      'by_me', exists(select 1 from message_reactions_dm r3 where r3.message_id = mr.message_id and r3.emoji = mr.emoji and r3.user_id = v_me)
    ) as row
    from message_reactions_dm mr
    where mr.message_id = any(v_msg_ids)
    group by mr.message_id, mr.emoji
  ) t;
  return jsonb_build_object('ok', true, 'reactions', v_result);
end;
$$;

-- ---------- 12. dm_pin / dm_unpin ----------
create or replace function dm_pin(v_msg_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_conv_id uuid;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select conversation_id into v_conv_id from direct_messages where id = v_msg_id;
  if v_conv_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  insert into conversation_pins (conversation_id, message_id, pinned_by)
  values (v_conv_id, v_msg_id, v_me)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function dm_unpin(v_msg_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_conv_id uuid;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select conversation_id into v_conv_id from direct_messages where id = v_msg_id;
  if v_conv_id is null then return jsonb_build_object('ok', false, 'error', 'not_found'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  delete from conversation_pins where message_id = v_msg_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function pins_list_dm(v_conv_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;
  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'message_id', cp.message_id,
      'conversation_id', cp.conversation_id,
      'pinned_by', cp.pinned_by,
      'created_at', cp.created_at,
      'content', dm.content,
      'sender_id', dm.sender_id
    ) as row
    from conversation_pins cp
    join direct_messages dm on dm.id = cp.message_id
    where cp.conversation_id = v_conv_id
    order by cp.created_at desc
  ) t;
  return jsonb_build_object('ok', true, 'pins', v_result);
end;
$$;

-- ---------- 13. conversation_set_flag (pin/mute/archive at conversation level) ----------
create or replace function conversation_set_flag(v_conv_id uuid, v_flag text, v_value boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  if v_flag not in ('pinned','muted','archived') then
    return jsonb_build_object('ok', false, 'error', 'invalid_flag');
  end if;
  if not exists(select 1 from conversation_members where conversation_id = v_conv_id and user_id = v_me and left_at is null) then
    return jsonb_build_object('ok', false, 'error', 'not_member');
  end if;

  execute format('update conversation_members set %I = $1 where conversation_id = $2 and user_id = $3', v_flag)
    using v_value, v_conv_id, v_me;

  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- 14. bookmarks_add / remove / list ----------
create or replace function bookmark_add(v_msg_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  insert into message_bookmarks (user_id, message_kind, message_id) values (v_me, 'dm', v_msg_id)
  on conflict do nothing;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function bookmark_remove(v_msg_id uuid) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid();
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  delete from message_bookmarks where user_id = v_me and message_kind = 'dm' and message_id = v_msg_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function bookmarks_list() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_me uuid := auth.uid(); v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;
  select coalesce(jsonb_agg(row), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'message_id', b.message_id,
      'bookmarked_at', b.created_at,
      'content', dm.content,
      'sender_id', dm.sender_id,
      'sender_username', p.username,
      'conversation_id', dm.conversation_id,
      'created_at', dm.created_at
    ) as row
    from message_bookmarks b
    join direct_messages dm on dm.id = b.message_id
    join profiles p on p.id = dm.sender_id
    where b.user_id = v_me and b.message_kind = 'dm'
    order by b.created_at desc
  ) t;
  return jsonb_build_object('ok', true, 'bookmarks', v_result);
end;
$$;