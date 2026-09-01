-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 007: STORAGE / REALTIME / SEED / GRANTS
-- ============================================================

-- ---------- STORAGE BUCKETS ----------
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values
  ('avatars', 'avatars', true, 5242880, array['image/png','image/jpeg','image/webp']),
  ('chat-images', 'chat-images', true, 8388608, array['image/png','image/jpeg','image/webp','image/gif']),
  ('chat-files', 'chat-files', true, 8388608, array['application/pdf','text/plain','application/zip'])
on conflict (id) do nothing;

-- uploads only into own folder; guests excluded (is_guest check via profiles)
drop policy if exists "avatars_own_insert" on storage.objects;
create policy "avatars_own_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'avatars'
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists(select 1 from public.profiles p where p.id = auth.uid() and p.is_guest));

drop policy if exists "avatars_public_read" on storage.objects;
create policy "avatars_public_read" on storage.objects for select to anon, authenticated
  using (bucket_id in ('avatars','chat-images','chat-files'));

drop policy if exists "avatars_own_update" on storage.objects;
create policy "avatars_own_update" on storage.objects for update to authenticated
  using (bucket_id = 'avatars' and (storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "avatars_own_delete" on storage.objects;
create policy "avatars_own_delete" on storage.objects for delete to authenticated
  using ((storage.foldername(name))[1] = auth.uid()::text);

drop policy if exists "chatimg_own_insert" on storage.objects;
create policy "chatimg_own_insert" on storage.objects for insert to authenticated
  with check (bucket_id in ('chat-images','chat-files')
    and (storage.foldername(name))[1] = auth.uid()::text
    and not exists(select 1 from public.profiles p where p.id = auth.uid() and p.is_guest));

-- ---------- REALTIME ----------
do $$
begin
  if not exists(select 1 from pg_publication where pubname = 'supabase_realtime') then
    create publication supabase_realtime;
  end if;
end $$;
alter publication supabase_realtime add table messages;
alter publication supabase_realtime add table message_reactions;
alter publication supabase_realtime add table message_pins;
alter publication supabase_realtime add table broadcasts;
alter publication supabase_realtime add table notifications;
alter publication supabase_realtime add table presence;

-- ---------- SEED ----------
insert into chat_rooms (id, slug, name, description)
values ('00000000-0000-0000-0000-000000000001', 'general', 'General', 'Everyone gathers here.')
on conflict (slug) do nothing;

insert into system_settings (key, value) values
  ('guests_enabled', 'true'::jsonb),
  ('registration_enabled', 'true'::jsonb),
  ('maintenance_mode', 'false'::jsonb),
  ('message_rate_limit', '8'::jsonb),
  ('max_upload_mb', '8'::jsonb)
on conflict (key) do nothing;

-- ---------- GRANTS ----------
-- tables: no write grants for anon/authenticated (SELECT policies handle reads)
grant usage on schema public to anon, authenticated;
grant select on all tables in schema public to anon, authenticated;
