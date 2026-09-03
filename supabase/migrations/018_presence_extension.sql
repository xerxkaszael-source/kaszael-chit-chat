-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 018: PRESENCE EXTENSION
-- Phase 4c — extend existing presence schema without breaking
-- already-deployed RPCs (notifications_list, notifications_mark_read,
-- notifications_unread_count, presence_heartbeat, presence_leave,
-- presence_list, presence_sweep).
--
-- Only ADDS: 6-state enum, last_activity_at column, helper RPCs.
-- Does NOT replace or alter existing RPC signatures.
-- ============================================================

-- 1. Extend presence.state to full 6-state enum per brief §27.
alter table presence drop constraint if exists presence_state_check;
alter table presence add constraint presence_state_check
  check (state in ('online', 'away', 'busy', 'dnd', 'invisible', 'offline'));

-- 2. Add last_activity_at column for activity detection (Phase 4c).
alter table presence add column if not exists last_activity_at timestamptz;
create index if not exists idx_presence_last_activity on presence (last_activity_at desc nulls last);

-- 3. Backfill last_activity_at for existing rows so the index is useful.
update presence set last_activity_at = last_seen where last_activity_at is null;

-- 4. server-side auto-away sweep. Runs from app on boot and from any
-- presence_heartbeat as an extra defense.
create or replace function presence_sweep_away()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update presence
    set state = 'away'
    where state = 'online'
      and last_activity_at is not null
      and last_activity_at < now() - interval '5 minutes';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- 5. presence_set_status — explicit status change from settings UI.
-- Does NOT change presence_heartbeat (which is called every 30s and
-- force-sets 'online'); this is the user-driven override.
create or replace function presence_set_status(v_status text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if v_status not in ('online','away','busy','dnd','invisible','offline') then
    raise exception 'CHC:invalid_status:value must be one of online/away/busy/dnd/invisible/offline';
  end if;
  insert into presence (user_id, state, session_id, last_seen, last_activity_at)
    values (v_uid, v_status, '', now(), now())
    on conflict (user_id) do update set
      state = excluded.state,
      last_seen = now(),
      last_activity_at = now();
  return jsonb_build_object('ok', true, 'state', v_status);
end;
$$;

-- 6. presence_get_for — read coarse presence for one user.
-- Returns only state + last_seen (no PII, no coordinates).
create or replace function presence_get_for(target_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_state text; v_last timestamptz; v_last_act timestamptz;
begin
  select state, last_seen, last_activity_at
    into v_state, v_last, v_last_act
    from presence where user_id = target_id;
  if not found then
    return jsonb_build_object('state', 'offline', 'last_seen', null, 'last_activity_at', null);
  end if;
  return jsonb_build_object(
    'state', v_state,
    'last_seen', v_last,
    'last_activity_at', v_last_act
  );
end;
$$;

-- 7. Extend notifications RLS so users can SELECT their own notifications.
-- The list RPC is SECURITY DEFINER so it works regardless, but RLS
-- coverage keeps direct PostgREST queries honest.
alter table notifications enable row level security;
drop policy if exists notif_self_select on notifications;
create policy notif_self_select on notifications
  for select to authenticated
  using (user_id = auth.uid());
drop policy if exists notif_self_update on notifications;
create policy notif_self_update on notifications
  for update to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());

-- 8. Extend notification_kinds check to include the 4 kinds the brief
-- §20 requires but the v0.4 set lacked. The previous migration 017
-- already added 'dm' and 'call'; this adds 'reply', 'reaction',
-- 'missed_call', 'security' (the remaining 4 from the 10-type spec).
alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in (
    'friend_request','friend_accepted','mention','moderation',
    'broadcast','system','dm','call',
    'reply','reaction','missed_call','security'
  ));

-- 9. Helpful index for unread-by-user fast lookups.
create index if not exists idx_notifications_unread_user
  on notifications (user_id, created_at desc)
  where read = false;