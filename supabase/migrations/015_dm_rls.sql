-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 015: DM RLS POLICIES
-- Convention: NO anon read of DM tables (privacy-critical).
-- Only members can SELECT their own conversations.
-- All writes go through SECURITY DEFINER RPCs (migration 014) — no
-- direct INSERT/UPDATE/DELETE policies for anon/authenticated.
-- ============================================================

-- conversations: only members can SELECT
drop policy if exists "conv_member_read" on conversations;
create policy "conv_member_read" on conversations for select to authenticated
  using (
    exists (
      select 1 from conversation_members cm
      where cm.conversation_id = conversations.id
        and cm.user_id = auth.uid()
        and cm.left_at is null
    )
  );

-- conversation_members: only self rows visible (no peeking at other member flags)
drop policy if exists "cm_self_read" on conversation_members;
create policy "cm_self_read" on conversation_members for select to authenticated
  using (user_id = auth.uid());

-- direct_messages: only members of the conversation can SELECT
drop policy if exists "dm_member_read" on direct_messages;
create policy "dm_member_read" on direct_messages for select to authenticated
  using (
    exists (
      select 1 from conversation_members cm
      where cm.conversation_id = direct_messages.conversation_id
        and cm.user_id = auth.uid()
        and cm.left_at is null
    )
  );

-- message_reads: only own rows
drop policy if exists "reads_self_read" on message_reads;
create policy "reads_self_read" on message_reads for select to authenticated
  using (user_id = auth.uid());

-- message_reactions_dm: members of the conversation can SELECT
drop policy if exists "reactions_dm_member_read" on message_reactions_dm;
create policy "reactions_dm_member_read" on message_reactions_dm for select to authenticated
  using (
    exists (
      select 1 from direct_messages dm
      join conversation_members cm on cm.conversation_id = dm.conversation_id
      where dm.id = message_reactions_dm.message_id
        and cm.user_id = auth.uid()
        and cm.left_at is null
    )
  );

-- conversation_pins: members can SELECT
drop policy if exists "pins_dm_member_read" on conversation_pins;
create policy "pins_dm_member_read" on conversation_pins for select to authenticated
  using (
    exists (
      select 1 from conversation_members cm
      where cm.conversation_id = conversation_pins.conversation_id
        and cm.user_id = auth.uid()
        and cm.left_at is null
    )
  );

-- conversation_drafts: ONLY own rows (drafts are private even within a conv)
drop policy if exists "drafts_self_read" on conversation_drafts;
create policy "drafts_self_read" on conversation_drafts for select to authenticated
  using (user_id = auth.uid());

-- message_bookmarks: ONLY own rows (private by design)
drop policy if exists "bookmarks_self_read" on message_bookmarks;
create policy "bookmarks_self_read" on message_bookmarks for select to authenticated
  using (user_id = auth.uid());

-- ============================================================
-- NO INSERT/UPDATE/DELETE policies anywhere.
-- All mutations flow through SECURITY DEFINER RPCs in migration 014.
-- ============================================================