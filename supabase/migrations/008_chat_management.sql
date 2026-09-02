-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 008: CHAT MANAGEMENT (owner only)
-- Fixes: Bug C (purge history not work)
-- RPCs: chat_purge_older_than, chat_purge_all, chat_archive_older_than
-- ============================================================

-- ---------- archive flag on messages ----------
alter table messages add column if not exists archived_at timestamptz;
create index if not exists idx_messages_archived on messages (archived_at) where archived_at is not null;

-- ---------- PURGE BY AGE ----------
create or replace function chat_purge_older_than(days_input numeric)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cutoff timestamptz;
  purged int;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if days_input is null or days_input <= 0 then
    raise exception 'CHC:bad_input:days_input must be > 0.'; end if;

  cutoff := now() - (days_input || ' days')::interval;
  with deleted as (
    delete from messages
    where created_at < cutoff and archived_at is null
    returning 1
  )
  select count(*) into purged from deleted;

  perform _audit(uid, 'CHAT_PURGED_BY_AGE', null, null,
    format('Purged %s messages older than %s days', purged, days_input),
    jsonb_build_object('count', purged, 'cutoff', cutoff),
    'warning');
  return jsonb_build_object('purged', purged, 'cutoff', cutoff);
end;
$$;

-- ---------- PURGE ALL ----------
create or replace function chat_purge_all()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  purged int;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;

  with deleted as (
    delete from messages
    where archived_at is null
    returning 1
  )
  select count(*) into purged from deleted;

  perform _audit(uid, 'CHAT_PURGED_ALL', null, null,
    format('Purged ALL %s messages', purged),
    jsonb_build_object('count', purged),
    'critical');
  return jsonb_build_object('purged', purged);
end;
$$;

-- ---------- ARCHIVE (soft-delete) ----------
-- Sets archived_at; row stays in DB but is hidden from message_list (which excludes archived).
create or replace function chat_archive_older_than(days_input int)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  cutoff timestamptz;
  archived int;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;
  if days_input is null or days_input <= 0 then
    raise exception 'CHC:bad_input:days_input must be > 0.'; end if;

  cutoff := now() - (days_input || ' days')::interval;
  with updated as (
    update messages
    set archived_at = now()
    where created_at < cutoff and archived_at is null
    returning 1
  )
  select count(*) into archived from updated;

  perform _audit(uid, 'CHAT_ARCHIVED_BY_AGE', null, null,
    format('Archived %s messages older than %s days', archived, days_input),
    jsonb_build_object('count', archived, 'cutoff', cutoff),
    'warning');
  return jsonb_build_object('archived', archived, 'cutoff', cutoff);
end;
$$;

-- ---------- RESTORE FROM ARCHIVE ----------
create or replace function chat_archive_restore_all()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  uid uuid := auth.uid();
  restored int;
begin
  if uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if _role_level(uid) < 50 then raise exception 'CHC:forbidden:Owner only.'; end if;

  with updated as (
    update messages
    set archived_at = null
    where archived_at is not null
    returning 1
  )
  select count(*) into restored from updated;

  perform _audit(uid, 'CHAT_ARCHIVE_RESTORED', null, null,
    format('Restored %s archived messages', restored),
    jsonb_build_object('count', restored),
    'info');
  return jsonb_build_object('restored', restored);
end;
$$;

-- ---------- UPDATE message_list to exclude archived ----------
-- Owner can still see archived via separate RPC; this keeps the live chat clean.
create or replace function message_list(room_id uuid, before_ts timestamptz default null, limit_n int default 40)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  out jsonb;
begin
  if before_ts is null then
    select jsonb_build_object('messages', coalesce(jsonb_agg(row_to_json(m)::jsonb), '[]'::jsonb))
    into out
    from (
      select id, room_id, sender_id, content, reply_to, client_msg_id,
             moderation_state, recalled_by, recall_reason, recalled_at,
             created_at, edited_at, archived_at
      from messages
      where messages.room_id = message_list.room_id
        and archived_at is null
        and moderation_state in ('visible', 'recalled')
      order by created_at desc
      limit least(greatest(coalesce(limit_n, 40), 1), 200)
    ) m;
  else
    select jsonb_build_object('messages', coalesce(jsonb_agg(row_to_json(m)::jsonb), '[]'::jsonb))
    into out
    from (
      select id, room_id, sender_id, content, reply_to, client_msg_id,
             moderation_state, recalled_by, recall_reason, recalled_at,
             created_at, edited_at, archived_at
      from messages
      where messages.room_id = message_list.room_id
        and archived_at is null
        and moderation_state in ('visible', 'recalled')
        and created_at < before_ts
      order by created_at desc
      limit least(greatest(coalesce(limit_n, 40), 1), 200)
    ) m;
  end if;
  return out;
end;
$$;

-- Grant execute to authenticated (RLS still enforces via security definer check above)
grant execute on function chat_purge_older_than(numeric) to authenticated;
grant execute on function chat_purge_all() to authenticated;
grant execute on function chat_archive_older_than(int) to authenticated;
grant execute on function chat_archive_restore_all() to authenticated;