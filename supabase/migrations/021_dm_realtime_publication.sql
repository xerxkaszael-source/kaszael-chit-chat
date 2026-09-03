-- Migration 021 — Add DM tables to supabase_realtime publication
-- Required for Phase 3 (DM UI) realtime delivery. Without this,
-- direct_messages INSERT/UPDATE/DELETE does not broadcast to subscribers.
--
-- Pre-flight verification (run before applying):
--   SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime';
--   should show: broadcasts, calls, message_pins, message_reactions,
--                messages, notifications, presence  (7 tables — NO DM tables)
--
-- After applying, verify:
--   SELECT * FROM pg_publication_tables WHERE pubname='supabase_realtime';
--   should show 10 tables (the 7 above + direct_messages + conversation_members + message_bookmarks)

-- Add DM tables to realtime broadcast.
-- REPLICA IDENTITY FULL is needed on direct_messages so UPDATE/DELETE
-- payloads include the full row (Supabase Realtime requires it).
ALTER TABLE public.direct_messages REPLICA IDENTITY FULL;

-- Add to publication. DROP first in case it was somehow already added.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'direct_messages'
  ) THEN
    RAISE NOTICE 'direct_messages already in publication, skipping';
  ELSE
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.direct_messages';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'conversation_members'
  ) THEN
    RAISE NOTICE 'conversation_members already in publication, skipping';
  ELSE
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.conversation_members';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'message_bookmarks'
  ) THEN
    RAISE NOTICE 'message_bookmarks already in publication, skipping';
  ELSE
    EXECUTE 'ALTER PUBLICATION supabase_realtime ADD TABLE public.message_bookmarks';
  END IF;
END $$;

-- Post-flight verification (for the migration log):
-- SELECT schemaname, tablename FROM pg_publication_tables WHERE pubname='supabase_realtime' ORDER BY tablename;