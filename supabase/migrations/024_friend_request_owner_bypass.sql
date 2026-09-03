-- Migration 024 — owner/admin/mod/helper can friend-request anyone
-- Reason: Staff often need to coordinate with users they're not friends with.
-- The friend_request RPC currently rejects 'staff' targets as 'forbidden':
--   if target_role in ('owner','admin') then
--     raise exception 'CHC:forbidden:Cannot send friend requests to staff.'
--   end if;
-- That rule still applies (staff shouldn't get friend-requested by random members),
-- but the inverse — staff sending to non-staff — should always succeed.
--
-- Also: friend_request should not check rate limit for staff — they need
-- to be able to onboard new users without hitting the 20/hr limit.

CREATE OR REPLACE FUNCTION public.friend_request(target_username text)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  uid uuid := auth.uid();
  v_role text;
  target uuid;
  target_role text;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot add friends.'; end if;

  -- Look up caller's role (used for staff bypass on rate limit + duplicate check)
  select role into v_role from profiles where id = uid;

  -- Rate limit only for non-staff (members). Staff can always send.
  if v_role not in ('owner','admin','moderator','helper') then
    if not _rate_check(uid, 'friend_request', 3600, 20) then
      raise exception 'CHC:rate_limit:Too many friend requests. Try later.';
    end if;
  end if;

  select id, role into target, target_role from profiles
    where username = lower(trim(target_username)) and not is_guest;
  if target is null then raise exception 'CHC:not_found:No such user.'; end if;
  if target = uid then raise exception 'CHC:self:You cannot friend yourself.'; end if;

  -- The "can't friend staff" rule only applies to NON-staff callers.
  -- Staff can friend anyone (including other staff — useful for owner/admin coordination).
  if v_role not in ('owner','admin','moderator','helper') and target_role in ('owner','admin') then
    raise exception 'CHC:forbidden:Cannot send friend requests to staff.';
  end if;

  if exists(select 1 from blocks where blocker_id = target and blocked_id = uid) then
    raise exception 'CHC:blocked:Request failed.';
  end if;

  -- Duplicate check: still reject if already friends or request pending.
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
$function$;

-- Post-flight verification (run after applying):
-- 1. As a member, friend_request to owner -> CHC:forbidden
-- 2. As owner, friend_request to any member -> 200 ok (new!)
-- 3. As member, two friend_requests in quick succession -> second one succeeds (rate limit only for members)
-- 4. As owner, 30 friend_requests in an hour -> all succeed (no rate limit for staff)