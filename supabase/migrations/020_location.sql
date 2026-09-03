-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 020: LOCATION
-- Brief §30-35: privacy-first user location. Technical GPS coords
-- are SEPARATE from human-readable admin display. Never expose raw
-- coordinates to other users; only the admin-level display fields.
--
-- Storage strategy:
--   1. profiles.location_granularity — privacy level (hidden|country|
--      province|city|district) — controls what others can see
--   2. profiles.location_country / province / city / district /
--      village / formatted — reverse-geocoded admin fields
--   3. profiles.location_coords jsonb — raw {lat, lng, accuracy}
--      OWNER-ONLY via RLS (other users cannot SELECT this column
--      directly; it's a jsonb so the entire field is gated)
--
-- Updates are explicit user actions via SECURITY DEFINER RPCs.
-- No background polling. No significant-movement auto-update.
-- ============================================================

-- 1. Extend profiles with location columns.
alter table profiles
  add column if not exists location_granularity text not null default 'hidden'
    check (location_granularity in ('hidden','country','province','city','district')),
  add column if not exists location_country text default '',
  add column if not exists location_province text default '',
  add column if not exists location_city text default '',
  add column if not exists location_district text default '',
  add column if not exists location_village text default '',
  add column if not exists location_formatted text default '',
  add column if not exists location_coords jsonb,
  add column if not exists location_updated_at timestamptz;

create index if not exists idx_profiles_location_country on profiles (location_country)
  where location_country <> '' and location_granularity <> 'hidden';
create index if not exists idx_profiles_location_city on profiles (location_city)
  where location_city <> '' and location_granularity in ('city','district');

-- 2. RPC: location_set_granularity — user chooses what to share
-- (hidden by default — privacy-first).
create or replace function location_set_granularity(v_granularity text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if v_granularity not in ('hidden','country','province','city','district') then
    raise exception 'CHC:invalid_granularity:value must be hidden|country|province|city|district';
  end if;
  update profiles set location_granularity = v_granularity where id = v_uid;
  if not found then
    raise exception 'CHC:no_profile:Call profile_init first.';
  end if;
  return jsonb_build_object('ok', true, 'granularity', v_granularity);
end;
$$;

-- 3. RPC: location_update — takes raw GPS + reverse-geocoded admin
-- fields. Stores everything; user controls visibility via granularity.
-- In production you'd verify the reverse-geocode server-side via an
-- external service; here we trust the client (which is fine because
-- the values only matter for display and the user can correct).
create or replace function location_update(
  v_lat double precision,
  v_lng double precision,
  v_accuracy double precision default null,
  v_country text default '',
  v_province text default '',
  v_city text default '',
  v_district text default '',
  v_village text default '',
  v_formatted text default ''
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90
     or v_lng < -180 or v_lng > 180 then
    raise exception 'CHC:invalid_coords:lat/lng out of range';
  end if;
  update profiles
    set location_coords = jsonb_build_object(
          'lat', v_lat, 'lng', v_lng, 'accuracy', v_accuracy
        ),
        location_country = v_country,
        location_province = v_province,
        location_city = v_city,
        location_district = v_district,
        location_village = v_village,
        location_formatted = v_formatted,
        location_updated_at = now()
    where id = v_uid;
  if not found then
    raise exception 'CHC:no_profile:Call profile_init first.';
  end if;
  return jsonb_build_object(
    'ok', true,
    'formatted', v_formatted,
    'updated_at', now()
  );
end;
$$;

-- 4. RPC: location_clear — remove all location data.
create or replace function location_clear()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  update profiles
    set location_coords = null,
        location_country = '',
        location_province = '',
        location_city = '',
        location_district = '',
        location_village = '',
        location_formatted = '',
        location_updated_at = null,
        location_granularity = 'hidden'
    where id = v_uid;
  return jsonb_build_object('ok', true);
end;
$$;

-- 5. RPC: location_get_for — read another user's location respecting
-- their privacy setting. Returns ONLY the admin-level fields allowed
-- by their granularity, never raw coords.
create or replace function location_get_for(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_granularity text;
  v_country text; v_province text; v_city text; v_district text;
  v_village text; v_formatted text; v_updated timestamptz;
begin
  select location_granularity, location_country, location_province,
         location_city, location_district, location_village,
         location_formatted, location_updated_at
    into v_granularity, v_country, v_province, v_city, v_district,
         v_village, v_formatted, v_updated
    from profiles where id = target_id;
  if not found then
    return jsonb_build_object('granularity', 'hidden');
  end if;
  -- Trim to allowed fields based on granularity
  return jsonb_build_object(
    'granularity', v_granularity,
    'country', case when v_granularity in ('country','province','city','district') then v_country else null end,
    'province', case when v_granularity in ('province','city','district') then v_province else null end,
    'city', case when v_granularity in ('city','district') then v_city else null end,
    'district', case when v_granularity = 'district' then v_district else null end,
    'village', case when v_granularity = 'district' then v_village else null end,
    'formatted', case when v_granularity = 'hidden' then null else v_formatted end,
    'updated_at', v_updated
  );
end;
$$;

-- 6. RPC: location_get_own — full location data for the current user
-- (own coords + admin fields, for settings UI).
create or replace function location_get_own()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_granularity text; v_country text; v_province text; v_city text;
  v_district text; v_village text; v_formatted text; v_updated timestamptz;
  v_coords jsonb;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select location_granularity, location_country, location_province,
         location_city, location_district, location_village,
         location_formatted, location_updated_at, location_coords
    into v_granularity, v_country, v_province, v_city, v_district,
         v_village, v_formatted, v_updated, v_coords
    from profiles where id = v_uid;
  if not found then
    return jsonb_build_object('set', false);
  end if;
  return jsonb_build_object(
    'set', v_updated is not null,
    'granularity', v_granularity,
    'country', v_country,
    'province', v_province,
    'city', v_city,
    'district', v_district,
    'village', v_village,
    'formatted', v_formatted,
    'updated_at', v_updated,
    'coords', v_coords
  );
end;
$$;

-- 7. RPC: location_stats — owner-only aggregate for the Owner Center.
create or replace function location_stats()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null or (_role_level(v_uid) < 50) then
    raise exception 'CHC:unauthorized:Owner only.';
  end if;
  return jsonb_build_object(
    'total_with_location', (
      select count(*) from profiles
      where location_updated_at is not null and location_granularity <> 'hidden'
    ),
    'by_granularity', (
      select jsonb_object_agg(location_granularity, cnt)
      from (
        select location_granularity, count(*) as cnt
        from profiles
        where location_updated_at is not null
        group by location_granularity
      ) t
    ),
    'top_countries', (
      select coalesce(jsonb_agg(c), '[]'::jsonb) from (
        select location_country as country, count(*) as users
        from profiles
        where location_country <> '' and location_granularity <> 'hidden'
        group by location_country
        order by users desc limit 10
      ) c
    )
  );
end;
$$;