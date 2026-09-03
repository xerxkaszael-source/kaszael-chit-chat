-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 017: NOTIFICATION KINDS EXTEND
-- Add 'dm' and 'call' to allowed notification.kind values.
-- Future-proofs the next-gen feature set without breaking existing rows.
-- ============================================================

alter table notifications drop constraint if exists notifications_kind_check;
alter table notifications add constraint notifications_kind_check
  check (kind in ('friend_request','friend_accepted','mention','moderation','broadcast','system','dm','call'));