-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 010: FIX message_list ambiguous room_id
-- Bug: Migration 008 introduced PL/pgSQL ambiguity by naming the
-- parameter and the column reference the same way. Result: function
-- fails with "column reference 'room_id' is ambiguous" → chat history
-- never loads → "Could not load messages. Retrying…" sticks forever.
--
-- Fix: rename parameter references to use a local alias OR
-- qualify with function name. The cleanest fix is to use the
-- function-name-qualified syntax with the parameter, but Postgres
-- also requires the COLUMN to be table-qualified. So we qualify
-- both:
--   where m.room_id = message_list.room_id
-- is unambiguous because column is qualified by alias 'm' and the
-- parameter by function name.
-- ============================================================

create or replace function message_list(room_id uuid, before_ts timestamptz default null, limit_n int default 40)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  lim int := least(greatest(coalesce(limit_n, 40), 1), 200);
  v_room uuid := message_list.room_id;
  v_before timestamptz := before_ts;
begin
  if v_before is null then
    return jsonb_build_object('messages', (
      select coalesce(jsonb_agg(row_to_json(m)::jsonb), '[]'::jsonb)
      from (
        select m.id, m.room_id, m.sender_id, m.content, m.reply_to,
               m.client_msg_id, m.moderation_state, m.recalled_by,
               m.recall_reason, m.recalled_at, m.created_at,
               m.edited_at, m.archived_at
        from messages m
        where m.room_id = v_room
          and m.archived_at is null
          and m.moderation_state in ('visible', 'recalled')
        order by m.created_at desc
        limit lim
      ) m
    ));
  else
    return jsonb_build_object('messages', (
      select coalesce(jsonb_agg(row_to_json(m)::jsonb), '[]'::jsonb)
      from (
        select m.id, m.room_id, m.sender_id, m.content, m.reply_to,
               m.client_msg_id, m.moderation_state, m.recalled_by,
               m.recall_reason, m.recalled_at, m.created_at,
               m.edited_at, m.archived_at
        from messages m
        where m.room_id = v_room
          and m.archived_at is null
          and m.moderation_state in ('visible', 'recalled')
          and m.created_at < v_before
        order by m.created_at desc
        limit lim
      ) m
    ));
  end if;
end;
$$;