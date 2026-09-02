-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 009: PROTECT OWNER + ADMIN FROM USER ACTIONS
-- Fixes: Bug F — owner/admin cannot be reported, blocked, or friend-requested
-- Server-side enforcement (UI also hides buttons but defense in depth)
-- ============================================================

-- ---------- friend_request: forbid targeting owner OR admin ----------
create or replace function friend_request(target_username text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  target uuid;
  target_role text;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot add friends.'; end if;
  if not _rate_check(uid, 'friend_request', 3600, 20) then
    raise exception 'CHC:rate_limit:Too many friend requests. Try later.'; end if;
  select id, role into target, target_role from profiles
    where username = lower(trim(target_username)) and not is_guest;
  if target is null then raise exception 'CHC:not_found:No such user.'; end if;
  if target = uid then raise exception 'CHC:self:You cannot friend yourself.'; end if;
  if target_role in ('owner','admin') then
    raise exception 'CHC:forbidden:Cannot send friend requests to staff.';
  end if;
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

-- ---------- friend_block: forbid blocking owner OR admin ----------
create or replace function friend_block(other_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  other_role text;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if other_id = uid then raise exception 'CHC:self:Cannot block yourself.'; end if;
  select role into other_role from profiles where id = other_id;
  if other_role is null then raise exception 'CHC:not_found:No such user.'; end if;
  if other_role in ('owner','admin') then
    raise exception 'CHC:forbidden:Cannot block staff members.';
  end if;
  insert into blocks (blocker_id, blocked_id) values (uid, other_id) on conflict do nothing;
  delete from friendships
    where ((requester_id = uid and addressee_id = other_id)
        or (requester_id = other_id and addressee_id = uid));
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- report_submit: forbid targeting owner OR admin ----------
create or replace function report_submit(target_user_id uuid default null, message_id uuid default null, category_input text default 'other', reason_input text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  v_target uuid := target_user_id;
  v_msg uuid := message_id;
  target_role text;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not _rate_check(uid, 'report', 3600, 10) then
    raise exception 'CHC:rate_limit:Too many reports. Try later.'; end if;
  if v_target is null and v_msg is null then
    raise exception 'CHC:empty:Nothing to report.'; end if;
  if v_target is not null then
    select role into target_role from profiles where id = v_target;
    if target_role in ('owner','admin') then
      raise exception 'CHC:forbidden:Cannot report staff members.';
    end if;
  end if;
  insert into reports (reporter_id, target_user_id, message_id, category, reason)
  values (uid, v_target, v_msg, category_input, left(coalesce(reason_input,''), 1000));
  return jsonb_build_object('ok', true);
end;
$$;