-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 002: RLS
-- Model: SELECT open where needed; NO direct writes for anon/authenticated.
-- Every mutation goes through SECURITY DEFINER RPCs (003/004).
-- ============================================================

alter table profiles enable row level security;
alter table chat_rooms enable row level security;
alter table messages enable row level security;
alter table message_reactions enable row level security;
alter table message_attachments enable row level security;
alter table message_pins enable row level security;
alter table friendships enable row level security;
alter table blocks enable row level security;
alter table presence enable row level security;
alter table reports enable row level security;
alter table mutes enable row level security;
alter table bans enable row level security;
alter table broadcasts enable row level security;
alter table notifications enable row level security;
alter table user_settings enable row level security;
alter table audit_logs enable row level security;
alter table system_settings enable row level security;
alter table rate_limits enable row level security;

-- ---------- public read (guests = anon need chat + profiles + presence) ----------
create policy "profiles_public_read" on profiles for select to anon, authenticated using (true);
create policy "rooms_public_read" on chat_rooms for select to anon, authenticated using (true);
create policy "messages_public_read" on messages for select to anon, authenticated using (true);
create policy "reactions_public_read" on message_reactions for select to anon, authenticated using (true);
create policy "attachments_public_read" on message_attachments for select to anon, authenticated using (true);
create policy "pins_public_read" on message_pins for select to anon, authenticated using (true);
create policy "presence_public_read" on presence for select to anon, authenticated using (true);
create policy "broadcasts_public_read" on broadcasts for select to anon, authenticated using (true);
create policy "system_settings_public_read" on system_settings for select to anon, authenticated using (true);

-- ---------- private read: own rows only ----------
create policy "friendships_own_read" on friendships for select to authenticated
  using (requester_id = auth.uid() or addressee_id = auth.uid());
create policy "blocks_own_read" on blocks for select to authenticated
  using (blocker_id = auth.uid());
create policy "notifications_own_read" on notifications for select to authenticated
  using (user_id = auth.uid());
create policy "settings_own_read" on user_settings for select to authenticated
  using (user_id = auth.uid());
create policy "reports_own_read" on reports for select to authenticated
  using (reporter_id = auth.uid());
-- mutes/bans/audit_logs/rate_limits: NO select policy — service role / RPCs only.

-- ---------- writes: NONE for anon/authenticated (RPCs are SECURITY DEFINER) ----------
-- deliberately no insert/update/delete policies anywhere.
