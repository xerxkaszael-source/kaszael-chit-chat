-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 003: INTERNAL HELPERS
-- SECURITY DEFINER helpers used by public RPCs. Not callable by clients.
-- ============================================================

create or replace function _role_level(uid uuid) returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select case role
    when 'owner' then 50 when 'admin' then 40 when 'moderator' then 30
    when 'helper' then 20 when 'member' then 10 else 0 end
    from profiles where id = uid), -1);
$$;

create or replace function _is_guest_row(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select exists(select 1 from profiles where id = uid and is_guest = true);
$$;

create or replace function _active_ban(uid uuid) returns bans
language sql stable security definer set search_path = public as $$
  select * from bans where target_id = uid and active = true
    and (expires_at is null or expires_at > now()) limit 1;
$$;

create or replace function _active_mute(uid uuid) returns mutes
language sql stable security definer set search_path = public as $$
  select * from mutes where target_id = uid and active = true
    and (expires_at is null or expires_at > now()) limit 1;
$$;

create or replace function _kicked(uid uuid) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select kicked from presence where user_id = uid), false);
$$;

create or replace function _setting(k text, fallback jsonb) returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce((select value from system_settings where key = k), fallback);
$$;

-- rolling rate limiter. returns true when ALLOWED.
create or replace function _rate_check(uid uuid, act text, window_sec int, max_count int)
returns boolean
language plpgsql security definer set search_path = public as $$
declare r record;
begin
  insert into rate_limits (user_id, action, window_start, count)
  values (uid, act, now(), 1)
  on conflict (user_id, action) do update set
    window_start = case when rate_limits.window_start < now() - (window_sec || ' seconds')::interval
                        then now() else rate_limits.window_start end,
    count = case when rate_limits.window_start < now() - (window_sec || ' seconds')::interval
                 then 1 else rate_limits.count + 1 end
  returning * into r;
  return r.count <= max_count;
end;
$$;

create or replace function _audit(a_actor uuid, a_action text, a_target uuid default null,
  a_msg uuid default null, a_reason text default '', a_meta jsonb default '{}'::jsonb,
  a_severity text default 'info')
returns void
language sql volatile security definer set search_path = public as $$
  insert into audit_logs (actor_id, action, target_id, message_id, reason, meta, severity)
  values (a_actor, a_action, a_target, a_msg, a_reason, a_meta, a_severity);
$$;

create or replace function _notify(n_uid uuid, n_kind text, n_actor uuid default null,
  n_payload jsonb default '{}'::jsonb)
returns void
language plpgsql security definer set search_path = public as $$
begin
  if n_uid is null then return; end if;
  insert into notifications (user_id, kind, actor_id, payload) values (n_uid, n_kind, n_actor, n_payload);
end;
$$;

-- reserved/impersonation names (lowercase)
create or replace function _reserved_name(n text) returns boolean
language sql immutable as $$
  select lower(n) in ('kaszael','owner','admin','administrator','moderator','mod',
    'helper','system','guest','root','support','staff','official')
  or lower(n) ~ '(kaszael|owner|admin|moderator|system)';
$$;

create or replace function _sanitize_display_name(n text) returns text
language sql immutable as $$
  select left(trim(regexp_replace(coalesce(n,''), '[\u0000-\u001f\u007f<>]', '', 'g')), 40);
$$;

-- ---------- lock helpers down: internal use only ----------
revoke execute on function _role_level(uuid) from public, anon, authenticated;
revoke execute on function _is_guest_row(uuid) from public, anon, authenticated;
revoke execute on function _active_ban(uuid) from public, anon, authenticated;
revoke execute on function _active_mute(uuid) from public, anon, authenticated;
revoke execute on function _kicked(uuid) from public, anon, authenticated;
revoke execute on function _setting(text, jsonb) from public, anon, authenticated;
revoke execute on function _rate_check(uuid, text, int, int) from public, anon, authenticated;
revoke execute on function _audit(uuid, text, uuid, uuid, text, jsonb, text) from public, anon, authenticated;
revoke execute on function _notify(uuid, text, uuid, jsonb) from public, anon, authenticated;
