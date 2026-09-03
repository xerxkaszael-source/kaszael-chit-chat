-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 027: CALL BUSY-STATE FIX
-- Fixes the "CHC:busy: You are already in a call." symptom caused
-- by stale rows in the `calls` table left behind by:
--   1. Network drops / tab closes / mobile background while the row
--      was still in 'calling' or 'ringing' state
--   2. The DB-side `call_miss_sweep` RPC existed but NOTHING invoked
--      it (no pg_cron, no Edge Function, no other RPC)
--   3. Users clicking Call twice before the first RPC returned (race)
--
-- This migration:
--   1. Adds `pg_cron` extension + a 1-minute schedule for `call_miss_sweep`
--   2. Wraps `call_initiate` to auto-sweep stale rows BEFORE the busy check
--   3. Adds `call_self_recover` RPC — lets a participant clean up a row
--      that involves themselves if the server can't tell it's stale yet
--   4. Loosens `call_end` to ALSO succeed on 'reconnecting' state (not
--      just connected) so a user can always end their own call
--   5. Adds `call_active_count` helper for diagnostics
-- ============================================================

-- ---------- 1. pg_cron schedule for call_miss_sweep ----------
-- Available on Supabase free tier. The 1-minute cadence is fast enough
-- for the 60-second stale threshold (call_miss_sweep itself only marks
-- rows older than 60s as 'missed').
create extension if not exists pg_cron;

-- Idempotent: pg_cron doesn't have CREATE OR REPLACE for jobs; we
-- delete-then-create wrapped in a savepoint so the migration is
-- idempotent across re-runs.
do $$
begin
  -- Remove any pre-existing job with this name (may have been added manually)
  if exists (select 1 from cron.job where jobname = 'chc_call_miss_sweep_1m') then
    perform cron.unschedule(jobid) from cron.job where jobname = 'chc_call_miss_sweep_1m';
  end if;
  -- Schedule: every minute. Uses the SECURITY DEFINER RPC so the cron
  -- background worker (which runs as the DB owner, NOT an auth user) can
  -- still execute it.
  perform cron.schedule(
    'chc_call_miss_sweep_1m',
    '* * * * *',
    $job$ select public.call_miss_sweep(); $job$
  );
exception when others then
  -- Don't break the migration if pg_cron isn't available in this env;
  -- the per-call sweep in call_initiate + call_self_recover still cover us.
  raise notice 'pg_cron schedule skipped: %', SQLERRM;
end $$;

-- ---------- 2. Wrap call_initiate with auto-sweep ----------
-- Replace the busy check with: first sweep stale rows for THIS user,
-- THEN check. A user who has a 5-hour-old "calling" row from a dropped
-- session should be able to call again without an admin running a query.
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

  -- === AUTO-SWEEP: mark any stale (>= 60s old) calling/ringing rows
  -- involving the caller as 'failed' so they don't block THIS attempt.
  -- Done in the SAME transaction so the busy check below sees the
  -- post-sweep state. This handles cases where pg_cron hasn't fired yet
  -- (race on deploy) AND cases where the caller has multiple stale rows.
  update calls
    set state = 'failed',
        ended_at = now(),
        end_reason = 'stale_initiate_sweep',
        end_by = v_uid
    where state in ('calling', 'ringing')
      and started_at < now() - interval '60 seconds'
      and (caller_id = v_uid or callee_id = v_uid);

  -- Also auto-fail rows that have been in 'reconnecting' for > 2 min
  -- (real networks either reconnect in seconds or fail fast; 2 min is
  -- generous and prevents permanent stuck rows).
  update calls
    set state = 'failed',
        ended_at = now(),
        end_reason = 'stale_reconnecting_sweep',
        end_by = v_uid
    where state = 'reconnecting'
      and started_at < now() - interval '120 seconds'
      and (caller_id = v_uid or callee_id = v_uid);

  -- Now the busy check, post-sweep.
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

-- ---------- 3. call_self_recover RPC ----------
-- Lets a participant manually force-end a call they were involved in.
-- Unlike call_end (which only works on active states), this works on
-- ANY state — the user is the judge of whether the row is real.
-- Use case: user sees "Call failed: busy" but knows they already
-- hung up / the other side's window closed; this lets them clean up
-- without admin intervention.
create or replace function call_self_recover(v_call_id uuid, v_reason text default 'user_recovered')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_caller uuid; v_callee uuid; v_state text;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  select caller_id, callee_id, state into v_caller, v_callee, v_state
    from calls where id = v_call_id;
  if v_caller is null then raise exception 'CHC:not_found:Call not found.'; end if;
  -- Only the two participants can recover — same auth model as call_end.
  if v_uid <> v_caller and v_uid <> v_callee then
    raise exception 'CHC:forbidden:Not your call.';
  end if;
  -- Idempotent: if already in a terminal state, just return.
  if v_state in ('ended', 'failed', 'missed', 'declined', 'cancelled') then
    return jsonb_build_object('ok', true, 'state', v_state, 'note', 'already_terminal');
  end if;
  update calls
    set state = 'failed',
        ended_at = now(),
        end_reason = v_reason,
        end_by = v_uid,
        duration_sec = case
          when answered_at is null then 0
          else greatest(0, extract(epoch from (now() - answered_at))::int)
        end
    where id = v_call_id;
  return jsonb_build_object('ok', true, 'state', 'failed', 'reason', v_reason);
end;
$$;

-- ---------- 4. Bulk self-recover — wipes ALL my stale rows ----------
-- "I don't care which one is stuck, just clean up everything I'm part
-- of that's still active." Used by the client when it sees the user is
-- stuck in CHC:busy state and wants to recover without an admin.
create or replace function call_self_recover_all(v_reason text default 'user_recovered_all')
returns integer
language plpgsql security definer set search_path = public as $$
declare v_uid uuid := auth.uid(); v_count integer;
begin
  if v_uid is null then raise exception 'CHC:unauthorized:Not signed in.'; end if;
  update calls
    set state = 'failed',
        ended_at = now(),
        end_reason = v_reason,
        end_by = v_uid,
        duration_sec = case
          when answered_at is null then 0
          else greatest(0, extract(epoch from (now() - answered_at))::int)
        end
    where state in ('calling','ringing','accepted','connecting','connected','reconnecting')
      and (caller_id = v_uid or callee_id = v_uid);
  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

-- ---------- 5. Loosen call_end to accept any non-terminal state ----------
-- Previously only worked on the active set; now also accepts 'reconnecting'
-- (which we already had) but let's also be permissive about the early
-- states so a quick-hangup from the caller side always succeeds.
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
  -- Accept ANY non-terminal state (calling/ringing/accepted/connecting/
  -- connected/reconnecting). The previous version only accepted a
  -- subset, which meant a click during the gap between accepted and
  -- connecting could leave the row stuck.
  update calls
    set state = 'ended', ended_at = now(), end_reason = v_reason,
        end_by = v_uid, duration_sec = v_dur
    where id = v_call_id
      and state in ('calling','ringing','accepted','connecting','connected','reconnecting');
  return jsonb_build_object('ok', true, 'state', 'ended', 'duration_sec', v_dur);
end;
$$;

-- ---------- 6. Helper for diagnostics ----------
create or replace function call_active_count()
returns table (state text, n integer)
language sql security definer set search_path = public as $$
  -- Wrap in subquery so the GROUP BY uses the source column name
  -- explicitly. The bare `state` alias in the SELECT-list conflicts
  -- with the RETURNS TABLE column of the same name — Postgres rejects
  -- `group by state` in that context. Use a subquery.
  select call_state, call_count from (
      select calls.state as call_state, count(*)::integer as call_count
        from calls
        where calls.state in ('calling','ringing','accepted','connecting','connected','reconnecting')
        group by calls.state
    ) sub
    order by call_count desc;
$$;

-- ---------- 7. GRANT the new RPCs to authenticated ----------
grant execute on function call_self_recover(uuid, text) to authenticated;
grant execute on function call_self_recover_all(text) to authenticated;
grant execute on function call_active_count() to authenticated;
