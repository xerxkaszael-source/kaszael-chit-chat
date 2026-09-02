-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 004: PUBLIC RPC SUITE
-- Every mutation is a SECURITY DEFINER RPC; tables have no write RLS.
-- Identity is ALWAYS derived from auth.uid() / stored guest bearer id.
-- All return jsonb. Errors raise exception with message 'CHC: <code>: <text>'.
-- ============================================================

-- ---------- GUEST ----------

-- Guests authenticate via Supabase Anonymous Sign-In, so auth.uid() exists.
-- The anon user's server-issued uuid IS the bearer identity — unforgeable.
create or replace function guest_enter(display_name_input text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  uname text;
  dname text;
  color text;
  palette text[] := array['#6c8cff','#8f6cff','#ff6c9d','#ff9d6c','#ffc46c','#6cdf8f','#6cd9df','#c06cff'];
begin
  if uid is null then raise exception 'CHC:unauthorized:Anonymous session not established.'; end if;
  if exists(select 1 from profiles where id = uid) then
    return (select row_to_json(p)::jsonb from profiles p where p.id = uid);
  end if;
  if _setting('guests_enabled', 'true'::jsonb)::boolean is distinct from true then
    raise exception 'CHC:guests_disabled:Guest access is currently disabled.';
  end if;
  dname := _sanitize_display_name(display_name_input);
  if char_length(dname) < 3 then
    raise exception 'CHC:bad_name:Display name must be 3–40 characters.';
  end if;
  if _reserved_name(dname) then
    raise exception 'CHC:reserved_name:That name is reserved.';
  end if;
  uname := 'guest_' || substr(replace(uid::text, '-', ''), 1, 10);
  color := palette[1 + floor(random() * array_length(palette,1))::int];
  insert into profiles (id, username, display_name, role, is_guest, avatar_color)
  values (uid, uname, dname, 'guest', true, color);
  insert into presence (user_id, state, session_id) values (uid, 'online', uid::text);
  return jsonb_build_object('id', uid, 'username', uname, 'display_name', dname,
    'role', 'guest', 'is_guest', true, 'avatar_color', color);
end;
$$;

create or replace function guest_leave()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', true); end if;
  if not _is_guest_row(uid) then
    raise exception 'CHC:not_guest:Unknown guest session.';
  end if;
  delete from notifications where user_id = uid;
  delete from user_settings where user_id = uid;
  delete from friendships where requester_id = uid or addressee_id = uid;
  delete from blocks where blocker_id = uid or blocked_id = uid;
  delete from presence where user_id = uid;
  delete from messages where sender_id = uid;
  delete from message_reactions where user_id = uid;
  delete from profiles where id = uid;
  perform _audit(uid, 'GUEST_LEFT', uid);
  return jsonb_build_object('ok', true);
end;
$$;

-- periodic ephemeral cleanup (owner danger zone)
create or replace function guest_purge_stale()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
  n int;
  ids uuid[];
begin
  if _role_level(caller) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  select array_agg(id) into ids from profiles
    where is_guest = true and created_at < now() - interval '24 hours';
  if ids is null then return jsonb_build_object('purged', 0); end if;
  delete from notifications where user_id = any(ids);
  delete from friendships where requester_id = any(ids) or addressee_id = any(ids);
  delete from blocks where blocker_id = any(ids) or blocked_id = any(ids);
  delete from presence where user_id = any(ids);
  delete from messages where sender_id = any(ids);
  delete from message_reactions where user_id = any(ids);
  delete from profiles where id = any(ids);
  get diagnostics n = row_count;
  perform _audit(caller, 'GUEST_PURGE_STALE', null, null, '', jsonb_build_object('count', n), 'warning');
  return jsonb_build_object('purged', n);
end;
$$;

create or replace function guest_purge_one(guest_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  caller uuid := auth.uid();
begin
  if _role_level(caller) < 40 then raise exception 'CHC:forbidden:Admin or owner only.'; end if;
  if not _is_guest_row(guest_id) then raise exception 'CHC:not_guest:Unknown guest.'; end if;
  delete from notifications where user_id = guest_id;
  delete from presence where user_id = guest_id;
  delete from messages where sender_id = guest_id;
  delete from message_reactions where user_id = guest_id;
  delete from profiles where id = guest_id;
  perform _audit(caller, 'GUEST_PURGED', guest_id, null, '', '{}'::jsonb, 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- PROFILE ----------

create or replace function profile_init(uid uuid, uname_input text, dname_input text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uname text := lower(trim(uname_input));
  dname text;
  palette text[] := array['#6c8cff','#8f6cff','#ff6c9d','#ff9d6c','#ffc46c','#6cdf8f','#6cd9df','#c06cff'];
begin
  if auth.uid() is null or auth.uid() <> uid then
    raise exception 'CHC:forbidden:Cannot init another identity.';
  end if;
  if exists(select 1 from profiles where id = uid) then
    return (select row_to_json(p)::jsonb from profiles p where p.id = uid);
  end if;
  if uname !~ '^[a-z0-9_]{3,20}$' then
    raise exception 'CHC:bad_username:Username must be 3–20 chars: a-z, 0-9, underscore.';
  end if;
  if _reserved_name(uname) then
    raise exception 'CHC:reserved_name:That username is reserved.';
  end if;
  if exists(select 1 from profiles where username = uname) then
    raise exception 'CHC:username_taken:Username already taken.';
  end if;
  dname := _sanitize_display_name(dname_input);
  if char_length(dname) < 1 then dname := uname; end if;
  insert into profiles (id, username, display_name, role, is_guest, avatar_color)
  values (uid, uname, dname, 'member', false,
          palette[1 + floor(random() * array_length(palette,1))::int]);
  insert into user_settings (user_id) values (uid) on conflict do nothing;
  insert into presence (user_id, state, session_id) values (uid, 'online', uid::text)
    on conflict (user_id) do update set state='online', last_seen=now();
  perform _audit(uid, 'USER_REGISTERED', uid);
  return (select row_to_json(p)::jsonb from profiles p where p.id = uid);
end;
$$;

create or replace function profile_own()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  return jsonb_build_object(
    'profile', (select row_to_json(p)::jsonb from profiles p where p.id = uid),
    'muted', exists(select 1 from mutes where target_id = uid and active
                     and (expires_at is null or expires_at > now())),
    'banned', exists(select 1 from bans where target_id = uid and active
                     and (expires_at is null or expires_at > now())),
    'kicked', _kicked(uid)
  );
end;
$$;

create or replace function profile_update(display_name_input text default null, bio_input text default null, avatar_path_input text default null, avatar_color_input text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot edit profiles.'; end if;
  if display_name_input is not null then
    declare dname text := _sanitize_display_name(display_name_input);
    begin
      if char_length(dname) < 1 then raise exception 'CHC:bad_name:Display name too short.'; end if;
      update profiles set display_name = dname, updated_at = now() where id = uid;
    end;
  end if;
  if bio_input is not null then
    update profiles set bio = left(bio_input, 300), updated_at = now() where id = uid;
  end if;
  if avatar_path_input is not null then
    -- path must be inside caller's own folder
    if avatar_path_input not like uid::text || '/%' then
      raise exception 'CHC:forbidden:Invalid avatar path.';
    end if;
    update profiles set avatar_path = avatar_path_input, updated_at = now() where id = uid;
  end if;
  if avatar_color_input is not null and avatar_color_input ~ '^#[0-9a-fA-F]{6}$' then
    update profiles set avatar_color = avatar_color_input, updated_at = now() where id = uid;
  end if;
  return (select row_to_json(p)::jsonb from profiles p where p.id = uid);
end;
$$;

create or replace function user_search(q text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pat text := '%' || lower(trim(coalesce(q,''))) || '%';
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if char_length(trim(coalesce(q,''))) < 2 then
    raise exception 'CHC:query_too_short:Type at least 2 characters.';
  end if;
  return jsonb_build_object('results', (
    select coalesce(jsonb_agg(row_to_json(p)::jsonb), '[]'::jsonb)
    from (select id, username, display_name, role, avatar_path, avatar_color
          from profiles
          where not is_guest and (username like pat or lower(display_name) like pat)
          order by username limit 20) p));
end;
$$;

create or replace function user_public(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  return (select coalesce(row_to_json(p)::jsonb, '{}'::jsonb)
          from (select id, username, display_name, role, bio, avatar_path, avatar_color, created_at, is_guest
                from profiles where id = target_id) p);
end;
$$;

-- ---------- SETTINGS ----------

create or replace function settings_update(appearance_input text default null, enter_to_send_input boolean default null, compact_input boolean default null, ts24_input boolean default null, notify_friend_input boolean default null, notify_mention_input boolean default null, notify_moderation_input boolean default null, sound_enabled_input boolean default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests have no settings.'; end if;
  insert into user_settings (user_id) values (uid) on conflict do nothing;
  update user_settings set
    appearance = coalesce(appearance_input, appearance),
    enter_to_send = coalesce(enter_to_send_input, enter_to_send),
    compact_mode = coalesce(compact_input, compact_mode),
    timestamps_24h = coalesce(ts24_input, timestamps_24h),
    notify_friend = coalesce(notify_friend_input, notify_friend),
    notify_mention = coalesce(notify_mention_input, notify_mention),
    notify_moderation = coalesce(notify_moderation_input, notify_moderation),
    sound_enabled = coalesce(sound_enabled_input, sound_enabled),
    updated_at = now()
  where user_id = uid;
  return (select row_to_json(s)::jsonb from user_settings s where s.user_id = uid);
end;
$$;

-- ---------- MESSAGES ----------

create or replace function message_send(room_id uuid, content text, client_msg_id text default null, reply_to uuid default null, attachment_ids uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_room uuid := room_id;
  v_content text := content;
  v_reply uuid := reply_to;
  v_cmid text := client_msg_id;
  v_atts uuid[] := attachment_ids;
  msg record;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if (_active_ban(uid)).id is not null then raise exception 'CHC:banned:You are banned.'; end if;
  if (_active_mute(uid)).id is not null then raise exception 'CHC:muted:You are muted.'; end if;
  if _kicked(uid) then raise exception 'CHC:kicked:You were removed from the chat.'; end if;
  if not exists(select 1 from chat_rooms where id = v_room) then
    raise exception 'CHC:no_room:Room not found.';
  end if;
  if not _rate_check(uid, 'message', 10, 8) then
    raise exception 'CHC:rate_limit:Slow down — too many messages.';
  end if;
  v_content := trim(coalesce(v_content, ''));
  if v_content = '' and (v_atts is null or array_length(v_atts,1) is null) then
    raise exception 'CHC:empty:Message cannot be empty.';
  end if;
  if char_length(v_content) > 4000 then raise exception 'CHC:too_long:Message too long.'; end if;

  insert into messages (room_id, sender_id, content, reply_to, client_msg_id)
  values (v_room, uid, v_content, v_reply, v_cmid)
  returning * into msg;

  -- attach uploaded files to this message
  if v_atts is not null then
    update message_attachments set message_id = msg.id
      where id = any(v_atts) and uploader_id = uid and message_id is null;
  end if;

  -- @mentions → notifications
  perform _notify(p.id, 'mention', uid, jsonb_build_object('message_id', msg.id, 'preview', left(v_content, 120)))
  from profiles p
  where p.username in (select distinct lower(m[1]) from regexp_matches(v_content, '@([a-z0-9_]{3,20})', 'g') m)
    and p.id <> uid and not p.is_guest
    and coalesce((select notify_mention from user_settings where user_id = p.id), true)
    and not exists(select 1 from blocks b where b.blocker_id = p.id and b.blocked_id = uid);

  return row_to_json(msg)::jsonb;
end;
$$;

create or replace function message_edit(message_id uuid, new_content text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sender uuid;
  v_msg uuid := message_id;
  v_new text := new_content;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select sender_id into sender from messages mm where mm.id = v_msg;
  if sender is null then raise exception 'CHC:not_found:Message not found.'; end if;
  if sender <> uid then raise exception 'CHC:forbidden:You can only edit your own messages.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot edit.'; end if;
  v_new := trim(coalesce(v_new, ''));
  if char_length(v_new) < 1 then raise exception 'CHC:empty:Message cannot be empty.'; end if;
  if char_length(v_new) > 4000 then raise exception 'CHC:too_long:Message too long.'; end if;
  update messages set content = v_new, edited_at = now() where id = v_msg;
  return (select row_to_json(m)::jsonb from messages m where m.id = v_msg);
end;
$$;

create or replace function message_delete_own(message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sender uuid;
  v_msg uuid := message_id;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select sender_id into sender from messages mm where mm.id = v_msg;
  if sender is null then raise exception 'CHC:not_found:Message not found.'; end if;
  if sender <> uid then raise exception 'CHC:forbidden:Own messages only.'; end if;
  update messages set moderation_state = 'deleted', content = '' where id = v_msg;
  perform _audit(uid, 'MESSAGE_DELETED', uid, v_msg);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function message_list(room_id uuid, before_ts timestamptz default null, limit_n int default 40)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  lim int := least(coalesce(limit_n, 40), 60);
  v_room uuid := room_id;
  v_before timestamptz := before_ts;
begin
  return jsonb_build_object('messages', (
    select coalesce(jsonb_agg(row_to_json(m)::jsonb), '[]'::jsonb)
    from (select m.* from messages m
          where m.room_id = v_room and (v_before is null or m.created_at < v_before)
          order by m.created_at desc limit lim) m));
end;
$$;

create or replace function message_recall(message_id uuid, reason text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  sender uuid;
  v_msg uuid := message_id;
  v_reason text := reason;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  select sender_id into sender from messages mm where mm.id = v_msg;
  if sender is null then raise exception 'CHC:not_found:Message not found.'; end if;
  update messages set moderation_state = 'recalled', content = '',
    recalled_by = uid, recall_reason = left(coalesce(v_reason,''), 300), recalled_at = now()
  where id = v_msg;
  delete from message_pins mp where mp.message_id = v_msg;
  perform _audit(uid, 'MESSAGE_RECALLED', sender, v_msg, coalesce(v_reason,''), '{}'::jsonb, 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function message_pin(message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_msg uuid := message_id;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Admin or owner required.'; end if;
  if not exists(select 1 from messages mm where mm.id = v_msg) then
    raise exception 'CHC:not_found:Message not found.'; end if;
  if not exists(select 1 from message_pins mp where mp.message_id = v_msg) then
    insert into message_pins (message_id, pinned_by) values (v_msg, uid);
  end if;
  perform _audit(uid, 'MESSAGE_PINNED', null, v_msg);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function message_unpin(message_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_msg uuid := message_id;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Admin or owner required.'; end if;
  delete from message_pins mp where mp.message_id = v_msg;
  perform _audit(uid, 'MESSAGE_UNPINNED', null, v_msg);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function pins_list(room_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_room uuid := room_id;
begin
  return jsonb_build_object('pins', (
    select coalesce(jsonb_agg(jsonb_build_object(
      'message', row_to_json(m)::jsonb,
      'pinned_at', p.created_at,
      'pinned_by', p.pinned_by) order by p.created_at desc), '[]'::jsonb)
    from message_pins p join messages m on m.id = p.message_id
    where m.room_id = v_room and m.moderation_state = 'visible'));
end;
$$;

-- ---------- REACTIONS ----------

create or replace function reaction_toggle(message_id uuid, emoji text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_msg uuid := message_id;
  v_emoji text := emoji;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if (_active_ban(uid)).id is not null then raise exception 'CHC:banned:You are banned.'; end if;
  if not _rate_check(uid, 'reaction', 10, 20) then
    raise exception 'CHC:rate_limit:Too many reactions.'; end if;
  if not exists(select 1 from messages where id = v_msg and moderation_state = 'visible') then
    raise exception 'CHC:not_found:Message not found.'; end if;
  delete from message_reactions mr where mr.message_id = v_msg and mr.user_id = uid and mr.emoji = v_emoji;
  if not found then
    insert into message_reactions (message_id, user_id, emoji) values (v_msg, uid, v_emoji);
  end if;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function reactions_for(message_ids uuid[])
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('reactions', (
    select coalesce(jsonb_agg(row_to_json(r)::jsonb), '[]'::jsonb)
    from message_reactions r where r.message_id = any(message_ids)));
end;
$$;
