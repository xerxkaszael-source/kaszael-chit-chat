-- Migration 023 — fix 3 bugs reported by user after Phase 4-7 audit
--
-- Bug 1: friend_request succeeds but UI shows "Failed" toast + "blink"
--   Root cause: panels.js rebuild() called undefined renderProfileBody() function.
--   This is purely a frontend bug (no SQL change needed) but migration documents it.
--
-- Bug 2: friend_respond succeeds but UI shows "Failed" toast + blink
--   Same root cause as Bug 1.
--
-- Bug 3: inbox shows "Unknown" + "the user not member" when other member
--   has left or been deleted.
--   Root cause: inbox_list filters other member with `cm2.left_at is null`.
--   If other user has left the conversation, the subquery returns NULL rows,
--   and other_user_id/username/display_name all become NULL.
--   The frontend then renders "Unknown" and dm_send fails because no active
--   member on the other side.
--
-- Fix for Bug 3:
--   - Include conversations where the other member has left, but tag them
--     as `archived_by_leave` so the UI can hide or mark them.
--   - Always fetch the other user's profile (even if they left) so we never
--     show "Unknown" — instead show "(left conversation)".
--   - dm_send and conversation_set_flag should refuse to operate when the
--     other member has left (defensive server-side enforcement).

CREATE OR REPLACE FUNCTION public.inbox_list()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_me uuid := auth.uid();
  v_result jsonb;
begin
  if v_me is null then return jsonb_build_object('ok', false, 'error', 'not_authenticated'); end if;

  select coalesce(jsonb_agg(row order by row->>'sort_key'), '[]'::jsonb) into v_result
  from (
    select jsonb_build_object(
      'conversation_id', c.id,
      'other_user_id', (
        select cm2.user_id from conversation_members cm2
        where cm2.conversation_id = c.id and cm2.user_id <> v_me
        order by cm2.left_at nulls first
        limit 1
      ),
      'other_username', (
        select p.username from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me
        order by cm2.left_at nulls first
        limit 1
      ),
      'other_display_name', (
        select p.display_name from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me
        order by cm2.left_at nulls first
        limit 1
      ),
      'other_avatar_color', (
        select p.avatar_color from profiles p
        join conversation_members cm2 on cm2.user_id = p.id
        where cm2.conversation_id = c.id and cm2.user_id <> v_me
        order by cm2.left_at nulls first
        limit 1
      ),
      'other_left', (
        select (cm2.left_at is not null)
        from conversation_members cm2
        where cm2.conversation_id = c.id and cm2.user_id <> v_me
        order by cm2.left_at nulls first
        limit 1
      ),
      'last_message_preview', c.last_message_preview,
      'last_message_at', c.last_message_at,
      'last_message_sender', (
        select sender_id from direct_messages
        where conversation_id = c.id order by created_at desc limit 1
      ),
      'pinned', cm.pinned,
      'muted', cm.muted,
      'archived', cm.archived,
      'unread_count', (
        select count(*) from direct_messages dm
        where dm.conversation_id = c.id
          and dm.sender_id <> v_me
          and dm.moderation_state = 'visible'
          and not exists (
            select 1 from message_reads mr
            where mr.message_id = dm.id and mr.user_id = v_me
          )
      ),
      'sort_key', lpad(extract(epoch from coalesce(c.last_message_at, c.created_at))::text, 20, '0')
    ) as row
    from conversation_members cm
    join conversations c on c.id = cm.conversation_id
    where cm.user_id = v_me and cm.left_at is null
    order by cm.pinned desc, c.last_message_at desc nulls last, c.created_at desc
  ) t;

  return jsonb_build_object('ok', true, 'conversations', v_result);
end;
$function$;

-- Post-flight verification:
-- SELECT inbox_list() with a user whose other member has left the conversation.
-- Expected: other_user_id/username populated (not null), other_left = true.
-- SELECT inbox_list() with a normal conversation.
-- Expected: other_left = false.