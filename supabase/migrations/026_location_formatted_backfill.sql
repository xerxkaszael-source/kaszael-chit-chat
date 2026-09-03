-- ============================================================
-- Migration 026 — auto-compute location_formatted from admin fields
--
-- Bug 6 (post-deploy):
--   User @kaszael set granularity=city with location_city=Jakarta and
--   location_country=Indonesia, but the profile panel never showed a
--   📍 Jakarta, Indonesia line. Root cause: location_formatted is set
--   exclusively by the Nominatim reverse-geocode response in
--   location_update. When a profile's location fields are populated by
--   any other path (admin tooling, manual DB update, older client that
--   didn't capture display_name), location_formatted stays empty and the
--   UI never shows the marker — even though city + country are set.
--
-- Fix:
--   1. Backfill existing rows: build location_formatted from
--      [city, province, country] joined with ', ', skipping empties.
--   2. Replace location_update so it ALWAYS recomputes formatted from
--      the admin fields after the update, so future writes never have
--      this drift. Client-supplied v_formatted is ignored.
--   3. Same for location_clear (already wipes to '').
--
-- Permission: same as existing location_update (auth.uid() required).

-- ---- 1. backfill ----
update profiles
set location_formatted = trim(both ', ' from
       concat_ws(', ',
         nullif(location_city, ''),
         nullif(location_province, ''),
         nullif(location_country, '')
       ))
where coalesce(location_formatted, '') = ''
  and (coalesce(location_city, '') <> ''
    or coalesce(location_province, '') <> ''
    or coalesce(location_country, '') <> '');

-- ---- 2. recompute-on-update ----
create or replace function location_update(
  v_lat double precision,
  v_lng double precision,
  v_accuracy double precision default null,
  v_country text default '',
  v_province text default '',
  v_city text default '',
  v_district text default '',
  v_village text default '',
  v_formatted text default ''   -- kept for backward-compat with old callers; ignored
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_formatted_computed text;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if v_lat is null or v_lng is null or v_lat < -90 or v_lat > 90
     or v_lng < -180 or v_lng > 180 then
    raise exception 'CHC:invalid_coords:lat/lng out of range';
  end if;

  -- Always recompute formatted from the admin fields (city, province, country)
  -- so the UI marker always renders even if the Nominatim reverse-geocode
  -- response was missing display_name (which is common for big-city requests).
  v_formatted_computed := trim(both ', ' from
    concat_ws(', ',
      nullif(v_city, ''),
      nullif(v_province, ''),
      nullif(v_country, '')
    ));

  update profiles
    set location_coords = jsonb_build_object(
          'lat', v_lat, 'lng', v_lng, 'accuracy', v_accuracy
        ),
        location_country = v_country,
        location_province = v_province,
        location_city = v_city,
        location_district = v_district,
        location_village = v_village,
        location_formatted = v_formatted_computed,
        location_updated_at = now()
    where id = v_uid;
  if not found then
    raise exception 'CHC:no_profile:Call profile_init first.';
  end if;
  return jsonb_build_object(
    'ok', true,
    'formatted', v_formatted_computed,
    'updated_at', now()
  );
end;
$$;

-- Post-flight verification:
-- SELECT id, username, location_city, location_country, location_formatted
-- FROM profiles WHERE location_formatted <> '';
-- Expected: every non-empty city/province/country combo yields a non-empty formatted.
-- SELECT location_update(-6.2088, 106.8456, 50, 'Indonesia', 'DKI Jakarta',
--                        'Jakarta', '', '', 'Jakarta, DKI Jakarta, Indonesia')
--   FROM auth.users LIMIT 1;  -- (run as service role)
-- Expected: returned formatted matches the computed value (caller's v_formatted ignored).
