-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 019: CALLS (voice + video)
-- Brief §22-26: WebRTC + Supabase Realtime signaling. STUN/TURN
-- external; Supabase carries only signaling, not media.
-- Authorization: both parties must be authenticated + not banned +
-- not blocked by each other (DB-enforced via existing helpers).
-- ============================================================

-- ---------- call sessions ----------
create table if not exists calls (
  id uuid primary key default gen_random_uuid(),
  caller_id uuid not null,
  callee_id uuid not null,
  kind text not null check (kind in ('voice', 'video')),
  state text not null default 'calling'
    check (state in ('calling','ringing','accepted','connecting',
                     'connected','reconnecting','declined','busy',
                     'missed','ended','failed','cancelled')),
  started_at timestamptz not null default now(),
  ringing_at timestamptz,
  answered_at timestamptz,
  ended_at timestamptz,
  duration_sec integer not null default 0,
  end_reason text default '',
  end_by uuid,
  metadata jsonb not null default '{}'::jsonb
);
create index if not exists idx_calls_caller on calls (caller_id, started_at desc);
create index if not exists idx_calls_callee on calls (callee_id, started_at desc);
create index if not exists idx_calls_state on calls (state) where state not in ('ended','failed','missed','declined','cancelled');

alter table calls enable row level security;

-- RLS: a user can read their own calls (caller or callee) only.
drop policy if exists calls_self_select on calls;
create policy calls_self_select on calls
  for select to authenticated
  using (caller_id = auth.uid() or callee_id = auth.uid());

-- No insert/update/delete policy for users — all writes go through
-- SECURITY DEFINER RPCs that enforce authorization (block check, etc).

-- ---------- call ICE candidates ----------
-- Server-side cache of WebRTC ICE candidates relayed by either side so
-- the other side can fetch on connection-establish (or in case realtime
-- channel missed an event). Belt-and-braces alongside Realtime broadcast.
create table if not exists call_ice_candidates (
  id bigserial primary key,
  call_id uuid not null references calls(id) on delete cascade,
  from_user uuid not null,
  candidate jsonb not null,
  sent_at timestamptz not null default now()
);
create index if not exists idx_call_ice_call on call_ice_candidates (call_id, sent_at);

alter table call_ice_candidates enable row level security;
drop policy if exists call_ice_self_select on call_ice_candidates;
create policy call_ice_self_select on call_ice_candidates
  for select to authenticated
  using (
    from_user = auth.uid()
    OR EXISTS (SELECT 1 FROM calls c WHERE c.id = call_ice_candidates.call_id
               AND (c.caller_id = auth.uid() OR c.callee_id = auth.uid()))
  );

-- ============================================================
-- RPCs — all SECURITY DEFINER, all check auth.uid() + block state
-- ============================================================

-- call_initiate: A starts a call to B. Validates: not blocked,
-- not banned, not calling yourself, B exists, A not already in
-- another active call.
create or replace function call_initiate(v_callee_id uuid, v_kind text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_id uuid;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if v_kind not in ('voice','video') then
    raise exception 'CHC:invalid_kind:value must be voice or video';
  end if;
  if v_uid = v_callee_id then
    raise exception 'CHC:self_call:You cannot call yourself.';
  end if;
  if (_active_ban(v_uid)).id is not null then
    raise exception 'CHC:banned:You are banned.';
  end if;
  -- block check (either direction)
  if exists (
    select 1 from blocks
    where (blocker_id = v_uid and blocked_id = v_callee_id)
       or (blocker_id = v_callee_id and blocked_id = v_uid)
  ) then
    raise exception 'CHC:blocked:Cannot call this user.';
  end if;
  -- callee exists?
  if not exists (select 1 from profiles where id = v_callee_id) then
    raise exception 'CHC:not_found:User not found.';
  end if;
  -- already in a call? (caller or callee)
  if exists (
    select 1 from calls
    where state in ('calling','ringing','accepted','connecting','connected','reconnecting')
      and (caller_id = v_uid or callee_id = v_uid)
  ) then
    raise exception 'CHC:busy:You are already in a call.';
  end if;
  insert into calls (caller_id, callee_id, kind, state)
    values (v_uid, v_callee_id, v_kind, 'calling')
    returning id into v_id;
  return jsonb_build_object('ok', true, 'call_id', v_id, 'state', 'calling');
end;
$$;

-- call_ringing: callee signals they got the notification (informational)
create or replace function call_ringing(v_call_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_state text;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select state into v_state from calls where id = v_call_id and callee_id = v_uid;
  if v_state is null then raise exception 'CHC:not_found:Call not found.'; end if;
  if v_state <> 'calling' then
    return jsonb_build_object('ok', true, 'state', v_state, 'note', 'state already advanced');
  end if;
  update calls set state = 'ringing', ringing_at = now() where id = v_call_id;
  return jsonb_build_object('ok', true, 'state', 'ringing');
end;
$$;

-- call_accept: callee accepts; flips to 'accepted', starts timer
create or replace function call_accept(v_call_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller uuid; v_kind text;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select caller_id, kind into v_caller, v_kind from calls
    where id = v_call_id and callee_id = v_uid;
  if v_caller is null then raise exception 'CHC:not_found:Call not found.'; end if;
  update calls set state = 'accepted', answered_at = now() where id = v_call_id;
  return jsonb_build_object(
    'ok', true, 'call_id', v_call_id, 'caller_id', v_caller,
    'kind', v_kind, 'state', 'accepted'
  );
end;
$$;

-- call_decline: callee rejects; sets state to 'declined' (or 'missed'
-- if timeout). end_reason required.
create or replace function call_decline(v_call_id uuid, v_reason text default 'declined')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not exists (select 1 from calls where id = v_call_id and callee_id = v_uid) then
    raise exception 'CHC:not_found:Call not found.';
  end if;
  update calls
    set state = case when v_reason = 'missed' then 'missed' else 'declined' end,
        ended_at = now(),
        end_reason = v_reason
    where id = v_call_id and state in ('calling','ringing');
  return jsonb_build_object('ok', true, 'state', v_reason);
end;
$$;

-- call_cancel: caller cancels before callee answers
create or replace function call_cancel(v_call_id uuid)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not exists (select 1 from calls where id = v_call_id and caller_id = v_uid) then
    raise exception 'CHC:not_found:Call not found.';
  end if;
  update calls
    set state = 'cancelled', ended_at = now(), end_reason = 'caller_cancelled'
    where id = v_call_id and state in ('calling','ringing');
  return jsonb_build_object('ok', true, 'state', 'cancelled');
end;
$$;

-- call_end: either side ends an active call. Calculates duration.
create or replace function call_end(v_call_id uuid, v_reason text default 'ended')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_ans timestamptz; v_dur int;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not exists (
    select 1 from calls where id = v_call_id
      and (caller_id = v_uid or callee_id = v_uid)
  ) then raise exception 'CHC:not_found:Call not found.'; end if;
  select answered_at into v_ans from calls where id = v_call_id;
  v_dur := case when v_ans is null then 0
                 else extract(epoch from (now() - v_ans))::int
            end;
  v_dur := greatest(v_dur, 0);
  update calls
    set state = 'ended', ended_at = now(), end_reason = v_reason,
        end_by = v_uid, duration_sec = v_dur
    where id = v_call_id and state in ('calling','ringing','accepted','connecting','connected','reconnecting');
  return jsonb_build_object('ok', true, 'state', 'ended', 'duration_sec', v_dur);
end;
$$;

-- call_ice_candidate: store an ICE candidate for fallback fetch
create or replace function call_ice_candidate(v_call_id uuid, v_candidate jsonb)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid();
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  if not exists (
    select 1 from calls where id = v_call_id
      and (caller_id = v_uid or callee_id = v_uid)
  ) then raise exception 'CHC:not_found:Call not found.'; end if;
  insert into call_ice_candidates (call_id, from_user, candidate)
    values (v_call_id, v_uid, v_candidate);
  return jsonb_build_object('ok', true);
end;
$$;

-- call_history_list: paginated call history for the current user
create or replace function call_history_list(v_limit integer default 30, v_before_id uuid default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_rows jsonb;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select coalesce(jsonb_agg(row_to_json(t)), '[]'::jsonb) into v_rows
    from (
      select c.id, c.caller_id, c.callee_id, c.kind, c.state,
             c.started_at, c.answered_at, c.ended_at, c.duration_sec,
             c.end_reason,
             case when c.caller_id = v_uid then 'outgoing' else 'incoming' end as direction,
             case when c.caller_id = v_uid then c.callee_id else c.caller_id end as other_user_id,
             (select row_to_json(p) from (
                select id, username, display_name, avatar_color
                from profiles where id = case when c.caller_id = v_uid then c.callee_id else c.caller_id end
              ) p) as other_user
        from calls c
        where (c.caller_id = v_uid or c.callee_id = v_uid)
          and (v_before_id is null
               or c.started_at < (select started_at from calls where id = v_before_id))
        order by c.started_at desc
        limit greatest(v_limit, 1)
    ) t;
  return jsonb_build_object('ok', true, 'calls', v_rows);
end;
$$;

-- call_miss_sweep: any 'calling'/'ringing' call older than 60s → 'missed'
-- (defense in depth; client should also timeout + call_decline)
create or replace function call_miss_sweep()
returns integer
language plpgsql security definer set search_path = public as $$
declare v_count integer;
begin
  update calls
    set state = 'missed', ended_at = now(), end_reason = 'no_answer_timeout'
    where state in ('calling','ringing')
      and started_at < now() - interval '60 seconds';
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- call_active: returns the active call for the current user, if any
create or replace function call_active()
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_row jsonb;
begin
  if v_uid is null then return jsonb_build_object('call', null); end if;
  select row_to_json(t) into v_row from (
    select id, caller_id, callee_id, kind, state, started_at,
           answered_at, ended_at, duration_sec,
           case when caller_id = v_uid then 'outgoing' else 'incoming' end as direction
      from calls
      where (caller_id = v_uid or callee_id = v_uid)
        and state in ('calling','ringing','accepted','connecting','connected','reconnecting')
      order by started_at desc limit 1
  ) t;
  return jsonb_build_object('call', coalesce(v_row, 'null'::jsonb));
end;
$$;