-- Migration 022 — user_public returns friend_status with viewer
-- Bug: profile panel always shows "Add friend" button and never "Unfriend" or "Message"
--      because user_public doesn't return the friendship status between viewer and target.
--
-- Fix: extend user_public to include:
--   - friend_status: 'none' | 'pending_out' | 'pending_in' | 'accepted' | 'blocked_by_me' | 'blocks_me'
--   - friendship_id: uuid if any friendship row exists (for respond/cancel/remove)
--
-- Strategy: do the friend_status computation in SQL using the friendship row directly.
-- This is read-only and respects RLS on friendships (caller must be a party to the row).

CREATE OR REPLACE FUNCTION public.user_public(target_id uuid)
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_uid uuid := auth.uid();
  v_friend_status text := 'none';
  v_friendship_id uuid := null;
  v_blocked_by_me boolean := false;
  v_blocks_me boolean := false;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if target_id is null then raise exception 'CHC:bad_request:target_id required.'; end if;

  -- Check block state first (a blocked relationship supersedes friendship)
  select
    exists(select 1 from blocks where blocker_id = v_uid and blocked_id = target_id),
    exists(select 1 from blocks where blocker_id = target_id and blocked_id = v_uid)
  into v_blocked_by_me, v_blocks_me;

  -- Friendship status (only if not blocked either way; block trumps friend)
  -- Use a subquery so we keep the defaults ('none'/null) when no row is found.
  if not v_blocked_by_me and not v_blocks_me then
    select f.id,
           case
             when f.status = 'accepted' then 'accepted'
             when f.status = 'pending' and f.requester_id = v_uid then 'pending_out'
             when f.status = 'pending' and f.requester_id = target_id then 'pending_in'
             else f.status::text
           end
      into v_friendship_id, v_friend_status
    from friendships f
    where (f.requester_id = v_uid and f.addressee_id = target_id)
       or (f.requester_id = target_id and f.addressee_id = v_uid)
    limit 1;
    -- Defensive: if status ended up NULL (no row), restore the 'none' default
    v_friend_status := coalesce(v_friend_status, 'none');
  end if;

  return (select jsonb_build_object(
    'id', p.id,
    'username', p.username,
    'display_name', p.display_name,
    'role', p.role,
    'bio', p.bio,
    'avatar_path', p.avatar_path,
    'avatar_color', p.avatar_color,
    'created_at', p.created_at,
    'is_guest', p.is_guest,
    'friend_status', v_friend_status,
    'friendship_id', v_friendship_id,
    'blocked_by_me', v_blocked_by_me,
    'blocks_me', v_blocks_me
  )
  from profiles p where p.id = target_id);
end;
$function$;

-- Post-flight verification (run after applying):
-- 1. As user A, call user_public(B):
--    expect friend_status='none' when no friendship, 'accepted'/'pending_in'/'pending_out' otherwise
-- 2. As user A, call user_public(A): expect friend_status='none' (self)
-- 3. Verify SECURITY DEFINER + search_path set (already on the function)