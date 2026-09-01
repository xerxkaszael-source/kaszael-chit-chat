-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 005: PRESENCE / FRIENDS / NOTIFS / BROADCASTS
-- ============================================================

-- ---------- PRESENCE ----------

create or replace function presence_heartbeat(session_id text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_sess text := coalesce(presence_heartbeat.session_id, '');
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if (_active_ban(uid)).id is not null then raise exception 'CHC:banned:You are banned.'; end if;
  if _kicked(uid) then raise exception 'CHC:kicked:You were removed from the chat.'; end if;
  insert into presence (user_id, state, session_id, last_seen)
  values (uid, 'online', v_sess, now())
  on conflict (user_id) do update set
    state = 'online',
    session_id = coalesce(presence_heartbeat.session_id, presence.session_id),
    kicked = false, kicked_reason = null,
    last_seen = now();
  -- sweep stale presence in the same heartbeat (cheap, no cron needed)
  update presence set state = 'offline'
    where state <> 'offline' and last_seen < now() - interval '90 seconds';
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function presence_leave()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('ok', true); end if;
  update presence set state = 'offline', last_seen = now() where user_id = uid;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function presence_list()
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('presence', (
    select coalesce(jsonb_agg(row_to_json(p)::jsonb), '[]'::jsonb)
    from presence p));
end;
$$;

create or replace function presence_sweep()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare n int;
begin
  update presence set state = 'offline'
    where state <> 'offline' and last_seen < now() - interval '90 seconds';
  get diagnostics n = row_count;
  return jsonb_build_object('swept', n);
end;
$$;

-- ---------- FRIENDS ----------

create or replace function friend_request(target_username text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  target uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot add friends.'; end if;
  if not _rate_check(uid, 'friend_request', 3600, 20) then
    raise exception 'CHC:rate_limit:Too many friend requests. Try later.'; end if;
  select id into target from profiles
    where username = lower(trim(target_username)) and not is_guest;
  if target is null then raise exception 'CHC:not_found:No such user.'; end if;
  if target = uid then raise exception 'CHC:self:You cannot friend yourself.'; end if;
  if exists(select 1 from blocks where blocker_id = target and blocked_id = uid) then
    raise exception 'CHC:blocked:Request failed.';
  end if;
  if exists(select 1 from friendships
            where ((requester_id = uid and addressee_id = target)
                or (requester_id = target and addressee_id = uid))
              and status in ('pending','accepted')) then
    raise exception 'CHC:duplicate:Already friends or request pending.';
  end if;
  insert into friendships (requester_id, addressee_id, status) values (uid, target, 'pending');
  perform _notify(target, 'friend_request', uid, jsonb_build_object('username',
    (select username from profiles where id = uid)));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function friend_respond(friendship_id uuid, accept boolean)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  req uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select requester_id into req from friendships where id = friendship_id;
  if req is null then raise exception 'CHC:not_found:Request not found.'; end if;
  if not exists(select 1 from friendships where id = friendship_id and addressee_id = uid and status = 'pending') then
    raise exception 'CHC:forbidden:Only the addressee can respond.'; end if;
  if accept then
    update friendships set status = 'accepted', updated_at = now() where id = friendship_id;
    perform _notify(req, 'friend_accepted', uid);
  else
    update friendships set status = 'declined', updated_at = now() where id = friendship_id;
  end if;
  return jsonb_build_object('ok', true, 'status', (select status from friendships where id = friendship_id));
end;
$$;

create or replace function friend_remove(other_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  delete from friendships
    where ((requester_id = uid and addressee_id = other_id)
        or (requester_id = other_id and addressee_id = uid));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function friends_list()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  return jsonb_build_object(
    'accepted', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) from (
      select f.id as friendship_id, f.updated_at, p.id, p.username, p.display_name, p.role,
             p.avatar_path, p.avatar_color, p.bio, p.created_at as joined_at
      from friendships f join profiles p
        on p.id = case when f.requester_id = uid then f.addressee_id else f.requester_id end
      where (f.requester_id = uid or f.addressee_id = uid) and f.status = 'accepted'
      order by p.username) x),
    'pending_in', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) from (
      select f.id as friendship_id, f.created_at, p.id, p.username, p.display_name, p.avatar_path, p.avatar_color
      from friendships f join profiles p on p.id = f.requester_id
      where f.addressee_id = uid and f.status = 'pending' order by f.created_at desc) x),
    'pending_out', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb) from (
      select f.id as friendship_id, f.created_at, p.id, p.username, p.display_name, p.avatar_path, p.avatar_color
      from friendships f join profiles p on p.id = f.addressee_id
      where f.requester_id = uid and f.status = 'pending' order by f.created_at desc) x));
end;
$$;

create or replace function friend_block(other_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if other_id = uid then raise exception 'CHC:self:Cannot block yourself.'; end if;
  if _role_level(other_id) >= 50 then raise exception 'CHC:forbidden:Cannot block the owner.'; end if;
  insert into blocks (blocker_id, blocked_id) values (uid, other_id) on conflict do nothing;
  delete from friendships
    where ((requester_id = uid and addressee_id = other_id)
        or (requester_id = other_id and addressee_id = uid));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function friend_unblock(other_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  delete from blocks where blocker_id = uid and blocked_id = other_id;
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function blocks_list()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  return jsonb_build_object('blocks', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select b.blocked_id, b.created_at, p.username, p.display_name
          from blocks b join profiles p on p.id = b.blocked_id
          where b.blocker_id = uid) x));
end;
$$;

-- ---------- NOTIFICATIONS ----------

create or replace function notifications_list(limit_n int default 30)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  return jsonb_build_object('notifications', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select * from notifications where user_id = uid
          order by created_at desc limit least(coalesce(limit_n,30), 50)) x));
end;
$$;

create or replace function notifications_mark_read(ids uuid[] default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  update notifications set read = true where user_id = uid
    and (ids is null or id = any(ids));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function notifications_unread_count()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then return jsonb_build_object('count', 0); end if;
  return jsonb_build_object('count',
    (select count(*) from notifications where user_id = uid and not read));
end;
$$;

-- ---------- BROADCASTS ----------

create or replace function broadcast_send(kind_input text, title_input text, body_input text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  b record;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Admin or owner required.'; end if;
  if kind_input not in ('info','announcement','warning','maintenance','system') then
    raise exception 'CHC:bad_kind:Invalid broadcast type.'; end if;
  if char_length(trim(title_input)) < 1 or char_length(trim(body_input)) < 1 then
    raise exception 'CHC:empty:Title and body required.'; end if;
  insert into broadcasts (author_id, kind, title, body)
  values (uid, kind_input, left(trim(title_input), 120), left(trim(body_input), 2000))
  returning * into b;
  perform _audit(uid, 'BROADCAST_SENT', null, null, title_input, jsonb_build_object('broadcast_id', b.id), 'info');
  return row_to_json(b)::jsonb;
end;
$$;

create or replace function broadcasts_list(limit_n int default 20)
returns jsonb
language plpgsql security definer set search_path = public as $$
begin
  return jsonb_build_object('broadcasts', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select b.*, p.username as author_username, p.display_name as author_display_name
          from broadcasts b join profiles p on p.id = b.author_id
          order by b.created_at desc limit least(coalesce(limit_n,20), 50)) x));
end;
$$;

create or replace function broadcast_delete(broadcast_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  author uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  select author_id into author from broadcasts where id = broadcast_id;
  if author is null then raise exception 'CHC:not_found:Broadcast not found.'; end if;
  delete from broadcasts where id = broadcast_id;
  perform _audit(uid, 'BROADCAST_DELETED', author, null, '', jsonb_build_object('broadcast_id', broadcast_id), 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- REPORTS ----------

create or replace function report_submit(target_user_id uuid default null, message_id uuid default null, category_input text default 'other', reason_input text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_target uuid := target_user_id;
  v_msg uuid := message_id;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not _rate_check(uid, 'report', 3600, 10) then
    raise exception 'CHC:rate_limit:Too many reports. Try later.'; end if;
  if v_target is null and v_msg is null then
    raise exception 'CHC:empty:Nothing to report.'; end if;
  insert into reports (reporter_id, target_user_id, message_id, category, reason)
  values (uid, v_target, v_msg, category_input, left(coalesce(reason_input,''), 1000));
  return jsonb_build_object('ok', true);
end;
$$;
