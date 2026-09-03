-- Migration 025 — user_public returns location + extend profile panel
-- Reason: profile panel doesn't show user location because user_public RPC
-- doesn't return any location fields. The location data lives on profiles.location_*
-- columns (set by location_update RPC) and there's already a location_get_for RPC
-- that handles privacy filtering (returns fields based on the OWNER's granularity
-- setting — only country if granularity='country', etc.).
--
-- Fix: embed location_get_for's logic into user_public so the frontend gets
-- the location in one round trip. Same privacy semantics:
--   granularity='hidden'       → all location fields null
--   granularity='country'      → only country
--   granularity='province'     → country + province
--   granularity='city'         → country + province + city (+ district + village?)
--   granularity='district'     → country + province + city + district + village
--
-- Permission: same as existing user_public (auth.uid() required).
-- Cross-user location disclosure is governed by the OWNER's granularity setting,
-- not the viewer's.

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
  v_granularity text := 'hidden';
  v_country text := null;
  v_province text := null;
  v_city text := null;
  v_district text := null;
  v_village text := null;
  v_formatted text := null;
  v_updated timestamptz := null;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if target_id is null then raise exception 'CHC:bad_request:target_id required.'; end if;

  -- Block state
  select
    exists(select 1 from blocks where blocker_id = v_uid and blocked_id = target_id),
    exists(select 1 from blocks where blocker_id = target_id and blocked_id = v_uid)
  into v_blocked_by_me, v_blocks_me;

  -- Friendship status (block trumps friend)
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
    v_friend_status := coalesce(v_friend_status, 'none');
  end if;

  -- Location (privacy-respecting: only fields matching OWNER's granularity)
  select location_granularity, location_country, location_province,
         location_city, location_district, location_village,
         location_formatted, location_updated_at
    into v_granularity, v_country, v_province, v_city, v_district,
         v_village, v_formatted, v_updated
    from profiles where id = target_id;

  if v_granularity is null then v_granularity := 'hidden'; end if;

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
    'blocks_me', v_blocks_me,
    'location_granularity', v_granularity,
    'location_country', case when v_granularity in ('country','province','city','district') then v_country else null end,
    'location_province', case when v_granularity in ('province','city','district') then v_province else null end,
    'location_city', case when v_granularity in ('city','district') then v_city else null end,
    'location_district', case when v_granularity = 'district' then v_district else null end,
    'location_village', case when v_granularity = 'district' then v_village else null end,
    'location_formatted', case when v_granularity = 'hidden' then null else v_formatted end,
    'location_updated_at', v_updated
  )
  from profiles p where p.id = target_id);
end;
$function$;

-- Post-flight verification:
-- 1. As user A, set location_granularity='city' on user B (via SQL or admin)
-- 2. Call user_public(B) as A
--    expect location_country/province/city populated, location_district/village null
-- 3. As A, call user_public(B) when B's granularity='hidden'
--    expect all location fields null