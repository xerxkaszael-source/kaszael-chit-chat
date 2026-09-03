-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 016: DM HELPER FIX
-- Fix _dm_allowed: _active_ban/_active_mute return single ROW, not SETOF.
-- Assign to record then check .id IS NOT NULL.
-- ============================================================

create or replace function _dm_allowed(uid_a uuid, uid_b uuid) returns text
language plpgsql stable security definer set search_path = public as $$
declare
  v_ban_a bans;
  v_ban_b bans;
  v_mute_a mutes;
  v_blocked boolean;
  v_role_a text;
begin
  if uid_a = uid_b then return 'self'; end if;

  v_ban_a := _active_ban(uid_a);
  if v_ban_a.id is not null then return 'banned'; end if;
  v_ban_b := _active_ban(uid_b);
  if v_ban_b.id is not null then return 'banned'; end if;

  v_mute_a := _active_mute(uid_a);
  if v_mute_a.id is not null then return 'muted'; end if;

  v_blocked := exists(
    select 1 from blocks where (blocker_id = uid_a and blocked_id = uid_b)
                           or (blocker_id = uid_b and blocked_id = uid_a)
  );
  if v_blocked then return 'blocked'; end if;

  select role into v_role_a from profiles where id = uid_a;
  if v_role_a in ('owner','admin','moderator','helper') then return 'ok'; end if;

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