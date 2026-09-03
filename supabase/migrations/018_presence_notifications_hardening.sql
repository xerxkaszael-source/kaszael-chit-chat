-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 018: PRESENCE HARDENING
-- Extends presence.state to full 6-state enum per brief §27.
-- Adds presence_set_status RPC + integrates status into
-- presence_heartbeat. Indexes for fast status queries.
-- All changes are non-destructive (state defaults to 'online').
-- ============================================================

-- 1. Drop the old 3-state check and add the full 6-state check.
alter table presence drop constraint if exists presence_state_check;
alter table presence add constraint presence_state_check
  check (state in ('online', 'away', 'busy', 'dnd', 'invisible', 'offline'));

-- 2. Add a last_activity_at column for the auto-away detection.
-- The client may write here on user activity (mouse/keyboard/touch),
-- and the server sweep uses it to mark users as 'away' after 5min idle.
alter table presence add column if not exists last_activity_at timestamptz not null default now();

create index if not exists idx_presence_last_activity on presence (last_activity_at desc);

-- 3. Auto-away sweep: any user whose last_activity_at is older than 5 minutes
--    and whose current state is 'online' gets demoted to 'away'.
--    Runs every 60s via pg_cron (if available) or as a fallback, called from
--    the app on boot.
create or replace function presence_sweep_away()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update presence
    set state = 'away'
    where state = 'online'
      and last_activity_at < now() - interval '5 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 4. Replace presence_heartbeat to accept status + activity; backwards compat.
-- The new RPC keeps the old arg shape (session_id) AND adds optional status / activity.
create or replace function presence_heartbeat(
  session_id text,
  v_status text default 'online',
  v_activity timestamptz default null
)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_state text; v_activity_ts timestamptz;
begin
  if v_uid is null then
    raise exception 'CHC:unauthorized:not_signed_in' using errcode = '28000';
  end if;
  -- validate status (extra defence — also enforced by column constraint)
  if v_status not in ('online','away','busy','dnd','invisible','offline') then
    v_status := 'online';
  end if;
  v_activity_ts := coalesce(v_activity, now());
  insert into presence (user_id, state, session_id, last_seen, last_activity_at)
    values (v_uid, v_status, session_id, now(), v_activity_ts)
    on conflict (user_id) do update set
      state = excluded.state,
      session_id = excluded.session_id,
      last_seen = now(),
      last_activity_at = excluded.last_activity_at;
  select state into v_state from presence where user_id = v_uid;
  return jsonb_build_object('ok', true, 'state', v_state);
end;
$$;

-- 5. New RPC: presence_set_status — explicit status change (e.g. user clicks
--    'Set as Away' in settings). Independent from heartbeat.
create or replace function presence_set_status(v_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CHC:unauthorized:not_signed_in' using errcode = '28000';
  end if;
  if v_status not in ('online','away','busy','dnd','invisible','offline') then
    raise exception 'CHC:invalid_status:value must be one of online/away/busy/dnd/invisible/offline' using errcode = '22023';
  end if;
  update presence
    set state = v_status,
        last_seen = now(),
        last_activity_at = now()
    where user_id = v_uid;
  if not found then
    insert into presence (user_id, state, last_seen, last_activity_at)
      values (v_uid, v_status, now(), now());
  end if;
  return jsonb_build_object('ok', true, 'state', v_status);
end;
$$;

-- 6. New RPC: presence_get_for(target) — read someone else's presence safely.
-- Returns only the coarse state + last_seen (no exact coordinates, no PII).
create or replace function presence_get_for(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_state text; v_last timestamptz;
begin
  select state, last_seen into v_state, v_last
    from presence
    where user_id = target_id;
  if not found then
    return jsonb_build_object('state', 'offline', 'last_seen', null);
  end if;
  return jsonb_build_object('state', v_state, 'last_seen', v_last);
end;
$$;

-- 7. New RPC: notifications_list — paginated list for the Notification Center.
create or replace function notifications_list(v_limit integer default 50, v_before_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_rows jsonb;
begin
  if v_uid is null then
    raise exception 'CHC:unauthorized:not_signed_in' using errcode = '28000';
  end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows
    from (
      select n.id, n.kind, n.payload, n.created_at, n.read,
               case
                 when n.payload ? 'actor_id' then
                   (select row_to_json(p) from (select id, username, display_name, avatar_color from profiles where id = (n.payload->>'actor_id')::uuid) p)
                 else null
               end as actor
          from notifications n
          where n.user_id = v_uid
            and (v_before_id is null or n.created_at < (select created_at from notifications where id = v_before_id))
          order by n.created_at desc
          limit greatest(v_limit, 1)
    ) t;
  return jsonb_build_object('ok', true, 'notifications', v_rows);
end;
$$;

-- 8. New RPC: notifications_mark_all_read() — bulk clear for Notification Center.
create or replace function notifications_mark_all_read()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_count integer;
begin
  if v_uid is null then
    raise exception 'CHC:unauthorized:not_signed_in' using errcode = '28000';
  end if;
  update notifications
    set read = true
    where user_id = v_uid and read = false;
  get diagnostics v_count = row_count;
  return jsonb_build_object('ok', true, 'marked', v_count);
end;
$$;

-- 9. New RPC: notifications_mark_read(p_notification_id) — single mark.
create or replace function notifications_mark_read(p_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then
    raise exception 'CHC:unauthorized:not_signed_in' using errcode = '28000';
  end if;
  update notifications
    set read = true
    where id = p_id and user_id = v_uid and read = false;
  if not found then
    raise exception 'CHC:not_found:notification' using errcode = 'P0002';
  end if;
  return jsonb_build_object('ok', true);
end;
$$;