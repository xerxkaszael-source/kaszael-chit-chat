-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 006: MODERATION / OWNER / SEARCH / ATTACHMENTS
-- Hierarchy: actors may only act on STRICTLY LOWER role levels than their own.
-- Owner (50) is unreachable. Admins may temp-ban ≤7d; permanent ban admin+.
-- Moderators: recall, mute ≤24h, kick, temp-ban ≤24h.
-- ============================================================

create or replace function mod_mute(target_id uuid, duration_min int default 60, reason text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  dur int := coalesce(duration_min, 60);
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if _is_guest_row(target_id) then raise exception 'CHC:not_found:Guests cannot be muted (purge instead).'; end if;
  if _role_level(target_id) >= _role_level(uid) then
    raise exception 'CHC:hierarchy:Cannot mute equal or higher role.'; end if;
  -- moderator max 24h; admin max 30d; owner unlimited
  if _role_level(uid) = 30 and dur > 1440 then raise exception 'CHC:limits:Moderator mutes max 24h.'; end if;
  if _role_level(uid) = 40 and dur > 43200 then raise exception 'CHC:limits:Admin mutes max 30 days.'; end if;
  if dur < 1 then raise exception 'CHC:limits:Duration must be at least 1 minute.'; end if;
  insert into mutes (target_id, actor_id, reason, expires_at)
  values (target_id, uid, left(coalesce(reason,''), 500), now() + (dur || ' minutes')::interval);
  perform _notify(target_id, 'moderation', uid, jsonb_build_object('action','muted','duration_min', dur));
  perform _audit(uid, 'USER_MUTED', target_id, null, coalesce(reason,''), jsonb_build_object('minutes', dur), 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_unmute(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if _role_level(target_id) >= _role_level(uid) and _role_level(uid) < 50 then
    raise exception 'CHC:hierarchy:Cannot unmute equal or higher role.'; end if;
  update mutes set active = false where target_id = target_id and active;
  perform _audit(uid, 'USER_UNMUTED', target_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_ban(target_id uuid, duration_hours int default null, reason text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  expires timestamptz := null;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if _is_guest_row(target_id) then raise exception 'CHC:not_found:Guests cannot be banned (purge instead).'; end if;
  if _role_level(target_id) >= _role_level(uid) then
    raise exception 'CHC:hierarchy:Cannot ban equal or higher role.'; end if;
  if duration_hours is not null then
    if duration_hours < 1 then raise exception 'CHC:limits:Duration must be at least 1 hour.'; end if;
    if _role_level(uid) = 30 and duration_hours > 24 then
      raise exception 'CHC:limits:Moderator bans max 24h.'; end if;
    if _role_level(uid) = 40 and duration_hours > 168 then
      raise exception 'CHC:limits:Admin bans max 7 days (owner can ban permanently).'; end if;
    expires := now() + (duration_hours || ' hours')::interval;
  else
    if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Permanent bans require admin or owner.'; end if;
  end if;
  insert into bans (target_id, actor_id, reason, expires_at)
  values (target_id, uid, left(coalesce(reason,''), 500), expires);
  update presence set kicked = true, kicked_reason = 'banned' where user_id = target_id;
  perform _notify(target_id, 'moderation', uid, jsonb_build_object('action','banned'));
  perform _audit(uid, 'USER_BANNED', target_id, null, coalesce(reason,''),
    jsonb_build_object('permanent', expires is null), 'critical');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_unban(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Admin or owner required.'; end if;
  update bans set active = false where target_id = target_id and active;
  perform _audit(uid, 'USER_UNBANNED', target_id);
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_kick(target_id uuid, reason text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if _role_level(target_id) >= _role_level(uid) then
    raise exception 'CHC:hierarchy:Cannot kick equal or higher role.'; end if;
  update presence set kicked = true, kicked_reason = left(coalesce(reason,''), 200) where user_id = target_id;
  perform _notify(target_id, 'moderation', uid, jsonb_build_object('action','kicked'));
  perform _audit(uid, 'USER_KICKED', target_id, null, coalesce(reason,''), '{}'::jsonb, 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_warn(target_id uuid, reason text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if _role_level(target_id) >= _role_level(uid) then
    raise exception 'CHC:hierarchy:Cannot warn equal or higher role.'; end if;
  perform _notify(target_id, 'moderation', uid, jsonb_build_object('action','warned','reason', left(coalesce(reason,''), 300)));
  perform _audit(uid, 'USER_WARNED', target_id, null, coalesce(reason,''));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_reports_list(status_filter text default 'open')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  return jsonb_build_object('reports', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select r.*, rp.username as reporter_username,
                 tp.username as target_username, tp.display_name as target_display_name
          from reports r
          join profiles rp on rp.id = r.reporter_id
          left join profiles tp on tp.id = r.target_user_id
          where status_filter = 'all' or r.status = status_filter
          order by r.created_at desc limit 100) x));
end;
$$;

create or replace function mod_report_resolve(report_id uuid, new_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  if new_status not in ('open','reviewing','resolved','dismissed') then
    raise exception 'CHC:bad_status:Invalid status.'; end if;
  update reports set status = new_status, handled_by = uid, handled_at = now() where id = report_id;
  perform _audit(uid, 'REPORT_' || upper(new_status), null, null, '', jsonb_build_object('report_id', report_id));
  return jsonb_build_object('ok', true);
end;
$$;

create or replace function mod_moderation_state_list()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 30 then raise exception 'CHC:forbidden:Moderator or higher required.'; end if;
  return jsonb_build_object(
    'mutes', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
      from (select m.*, p.username, p.display_name from mutes m
            join profiles p on p.id = m.target_id where m.active order by m.created_at desc limit 100) x),
    'bans', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
      from (select b.*, p.username, p.display_name from bans b
            join profiles p on p.id = b.target_id where b.active order by b.created_at desc limit 100) x));
end;
$$;

-- ---------- OWNER: ROLES ----------

create or replace function owner_set_role(target_id uuid, new_role text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if target_id = uid then raise exception 'CHC:self:Owner cannot change own role here.'; end if;
  if new_role not in ('member','helper','moderator','admin') then
    raise exception 'CHC:bad_role:Assignable roles: member, helper, moderator, admin.'; end if;
  if _is_guest_row(target_id) then raise exception 'CHC:forbidden:Guests cannot hold roles.'; end if;
  update profiles set role = new_role, updated_at = now() where id = target_id;
  perform _audit(uid, 'ROLE_CHANGED', target_id, null, '', jsonb_build_object('new_role', new_role), 'critical');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- OWNER: USERS ----------

create or replace function owner_users_list(q text default '')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  pat text := '%' || lower(trim(coalesce(q,''))) || '%';
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 40 then raise exception 'CHC:forbidden:Admin or owner required.'; end if;
  return jsonb_build_object('users', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select p.id, p.username, p.display_name, p.role, p.is_guest, p.created_at, p.bio,
                 pr.state as presence_state, pr.last_seen,
                 exists(select 1 from mutes m where m.target_id = p.id and m.active
                        and (m.expires_at is null or m.expires_at > now())) as muted,
                 exists(select 1 from bans b where b.target_id = p.id and b.active
                        and (b.expires_at is null or b.expires_at > now())) as banned
          from profiles p left join presence pr on pr.user_id = p.id
          where q = '' or p.username like pat or lower(p.display_name) like pat
          order by p.created_at desc limit 200) x));
end;
$$;

create or replace function owner_stats()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  return jsonb_build_object(
    'users_total', (select count(*) from profiles where not is_guest),
    'guests_total', (select count(*) from profiles where is_guest),
    'online', (select count(*) from presence where state <> 'offline'),
    'messages_total', (select count(*) from messages),
    'messages_today', (select count(*) from messages where created_at > now() - interval '24 hours'),
    'muted_active', (select count(*) from mutes where active and (expires_at is null or expires_at > now())),
    'banned_active', (select count(*) from bans where active and (expires_at is null or expires_at > now())),
    'reports_open', (select count(*) from reports where status in ('open','reviewing')),
    'broadcasts_total', (select count(*) from broadcasts),
    'audit_total', (select count(*) from audit_logs),
    'db_health', 'ok');
end;
$$;

create or replace function owner_audit_list(action_filter text default '', limit_n int default 50, offset_n int default 0)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  return jsonb_build_object('logs', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select a.*, p.username as actor_username, p.display_name as actor_display_name,
                 t.username as target_username
          from audit_logs a
          left join profiles p on p.id = a.actor_id
          left join profiles t on t.id = a.target_id
          where action_filter = '' or a.action = action_filter
          order by a.created_at desc
          limit least(coalesce(limit_n,50), 200) offset coalesce(offset_n,0)) x));
end;
$$;

-- ---------- OWNER: SYSTEM SETTINGS ----------

create or replace function owner_settings_get()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  return jsonb_build_object('settings', (select coalesce(jsonb_object_agg(key, value), '{}'::jsonb) from system_settings));
end;
$$;

create or replace function owner_settings_set(k text, v jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if k not in ('guests_enabled','registration_enabled','maintenance_mode','message_rate_limit','max_upload_mb') then
    raise exception 'CHC:bad_key:Unknown setting.'; end if;
  insert into system_settings (key, value, updated_by, updated_at) values (k, v, uid, now())
  on conflict (key) do update set value = v, updated_by = uid, updated_at = now();
  perform _audit(uid, 'SETTINGS_CHANGED', null, null, '', jsonb_build_object('key', k, 'value', v), 'warning');
  return jsonb_build_object('ok', true);
end;
$$;

-- ---------- SEARCH ----------

create or replace function search_messages(q text, before_ts timestamptz default null, limit_n int default 20)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  lim int := least(coalesce(limit_n, 20), 50);
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if char_length(trim(coalesce(q,''))) < 2 then raise exception 'CHC:query_too_short:Type at least 2 characters.'; end if;
  return jsonb_build_object('messages', (select coalesce(jsonb_agg(row_to_json(x)::jsonb), '[]'::jsonb)
    from (select m.*, p.username as sender_username, p.display_name as sender_display_name
          from messages m join profiles p on p.id = m.sender_id
          where m.moderation_state = 'visible' and m.content ilike '%' || trim(q) || '%'
            and (before_ts is null or m.created_at < before_ts)
          order by m.created_at desc limit lim) x));
end;
$$;

-- ---------- ATTACHMENTS ----------

create or replace function attachment_register(message_id uuid, bucket_name text, storage_path text, filename_input text, mime_input text, size_bytes_input bigint, kind_input text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  fname text;
  aid uuid;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _is_guest_row(uid) then raise exception 'CHC:guest:Guests cannot upload files.'; end if;
  if (_active_ban(uid)).id is not null then raise exception 'CHC:banned:You are banned.'; end if;
  if not _rate_check(uid, 'upload', 60, 6) then raise exception 'CHC:rate_limit:Too many uploads.'; end if;
  if bucket_name not in ('chat-images','chat-files') then raise exception 'CHC:bad_bucket:Invalid bucket.'; end if;
  if storage_path not like uid::text || '/%' then raise exception 'CHC:forbidden:Invalid path.'; end if;
  if kind_input not in ('image','file') then raise exception 'CHC:bad_kind:Invalid attachment kind.'; end if;
  if size_bytes_input > (_setting('max_upload_mb', '8'::jsonb)::int * 1048576) then
    raise exception 'CHC:too_large:File exceeds size limit.'; end if;
  if mime_input not in ('image/png','image/jpeg','image/webp','image/gif',
                        'application/pdf','text/plain','application/zip') then
    raise exception 'CHC:bad_mime:File type not allowed.'; end if;
  fname := regexp_replace(coalesce(filename_input,'attachment'), '[^a-zA-Z0-9._-]', '_', 'g');
  fname := left(fname, 120);
  insert into message_attachments (message_id, uploader_id, bucket, storage_path, filename, mime, size_bytes, kind)
  values (message_id, uid, bucket_name, storage_path, fname, mime_input, size_bytes_input, kind_input)
  returning id into aid;
  return jsonb_build_object('id', aid);
end;
$$;
