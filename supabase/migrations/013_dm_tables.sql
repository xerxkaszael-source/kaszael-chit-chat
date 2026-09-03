-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 013: DM FOUNDATION TABLES
-- Private 1-on-1 messaging foundation.
-- Convention: NO FK to profiles.id (workspace contract).
-- All writes go through SECURITY DEFINER RPCs (migration 014).
-- ============================================================

-- ---------- conversations ----------
-- Exactly one canonical conversation between any two users (enforced by UNIQUE
-- pair trigger). Kind = 'dm' for now (future: 'group' if product expands).
create table if not exists conversations (
  id uuid primary key default gen_random_uuid(),
  kind text not null default 'dm' check (kind in ('dm')),
  created_at timestamptz not null default now(),
  last_message_at timestamptz,
  last_message_preview text default ''
);
create index if not exists idx_conversations_last_message_at on conversations (last_message_at desc nulls last);

-- ---------- conversation_members ----------
-- One row per participant. UNIQUE (conversation_id, user_id) prevents dup joins.
-- left_at != null = soft-leave (conversation preserved for other member).
create table if not exists conversation_members (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null,
  joined_at timestamptz not null default now(),
  left_at timestamptz,
  pinned boolean not null default false,
  muted boolean not null default false,
  archived boolean not null default false,
  last_read_message_id uuid,
  last_read_at timestamptz,
  primary key (conversation_id, user_id)
);
create index if not exists idx_cm_user on conversation_members (user_id);
create index if not exists idx_cm_user_active on conversation_members (user_id) where left_at is null;

-- ---------- direct_messages ----------
-- Messages in a conversation. reply_to self-references (no FK for workspace rule).
-- moderation_state: visible|pending|recalled (matches existing messages table convention).
create table if not exists direct_messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references conversations(id) on delete cascade,
  sender_id uuid not null,
  content text not null check (char_length(content) between 1 and 4000),
  reply_to uuid,
  client_msg_id text,
  moderation_state text not null default 'visible' check (moderation_state in ('visible','pending','recalled')),
  recalled_by uuid,
  recall_reason text default '',
  recalled_at timestamptz,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create index if not exists idx_dm_conv_created on direct_messages (conversation_id, created_at desc);
create index if not exists idx_dm_sender on direct_messages (sender_id);
create index if not exists idx_dm_client_msg_id on direct_messages (conversation_id, client_msg_id) where client_msg_id is not null;

-- ---------- message_reads ----------
-- One row per (message, user) at read-time. Enables reliable read receipts even
-- when messages are added/removed from view (virtualization).
create table if not exists message_reads (
  message_id uuid not null references direct_messages(id) on delete cascade,
  user_id uuid not null,
  read_at timestamptz not null default now(),
  primary key (message_id, user_id)
);
create index if not exists idx_reads_user on message_reads (user_id);

-- ---------- message_reactions_dm ----------
-- Same shape as public message_reactions but for DMs. Separate table because
-- privacy: DMs should never appear in public aggregations.
create table if not exists message_reactions_dm (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null references direct_messages(id) on delete cascade,
  user_id uuid not null,
  emoji text not null check (char_length(emoji) between 1 and 16),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);
create index if not exists idx_reactions_dm_message on message_reactions_dm (message_id);

-- ---------- conversation_pins ----------
-- Pinned messages per conversation (visible to both members).
create table if not exists conversation_pins (
  conversation_id uuid not null references conversations(id) on delete cascade,
  message_id uuid not null references direct_messages(id) on delete cascade,
  pinned_by uuid not null,
  created_at timestamptz not null default now(),
  primary key (conversation_id, message_id)
);
create index if not exists idx_pins_dm_message on conversation_pins (message_id);

-- ---------- conversation_drafts ----------
-- Per-user draft per conversation. Single row per (conv, user) — updated in place.
create table if not exists conversation_drafts (
  conversation_id uuid not null references conversations(id) on delete cascade,
  user_id uuid not null,
  draft text not null default '' check (char_length(draft) <= 4000),
  updated_at timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

-- ---------- message_bookmarks ----------
-- Private bookmarks. Only owner can see their own (enforced via user_id + RLS).
-- message_kind = 'dm' (forward compat with public bookmarks later).
create table if not exists message_bookmarks (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  message_kind text not null default 'dm' check (message_kind in ('dm')),
  message_id uuid not null,
  created_at timestamptz not null default now(),
  unique (user_id, message_kind, message_id)
);
create index if not exists idx_bookmarks_user on message_bookmarks (user_id, created_at desc);

-- ---------- enable RLS on all new tables ----------
alter table conversations enable row level security;
alter table conversation_members enable row level security;
alter table direct_messages enable row level security;
alter table message_reads enable row level security;
alter table message_reactions_dm enable row level security;
alter table conversation_pins enable row level security;
alter table conversation_drafts enable row level security;
alter table message_bookmarks enable row level security;

-- ============================================================
-- DM UNIQUENESS: at most ONE active dm conversation per (user_a, user_b).
-- Implemented as a BEFORE INSERT trigger on conversation_members that looks
-- up an existing conversation containing the other user (excluding self-DM
-- which is meaningless and disallowed).
-- ============================================================
create or replace function _ensure_unique_dm_conversation()
returns trigger
language plpgsql security definer set search_path = public as $$
declare v_existing uuid;
begin
  -- self-DM never allowed
  if exists (
    select 1 from conversation_members cm
    where cm.conversation_id = new.conversation_id
      and cm.user_id = new.user_id
  ) then
    raise exception 'self_dm_not_allowed' using errcode = '23514';
  end if;

  -- look for an existing active dm conversation that already has new.user_id
  -- as a member (left_at is null) AND has exactly one other active member.
  -- if found, redirect insert to that conversation instead of creating a new one.
  select cm.conversation_id into v_existing
  from conversation_members cm
  where cm.user_id = new.user_id
    and cm.left_at is null
    and cm.conversation_id in (
      select cm2.conversation_id from conversation_members cm2
      where cm2.user_id <> new.user_id and cm2.left_at is null
      group by cm2.conversation_id having count(*) = 1
    )
    and cm.conversation_id = new.conversation_id
  limit 1;

  if v_existing is not null and v_existing <> new.conversation_id then
    new.conversation_id := v_existing;
  end if;

  return new;
end;
$$;

drop trigger if exists trg_unique_dm_conv on conversation_members;
create trigger trg_unique_dm_conv
  before insert on conversation_members
  for each row execute function _ensure_unique_dm_conversation();

-- ============================================================
-- Self-DM guard at conversation_members insert: raise if trying to add
-- the conversation's only other member as the same user.
-- (Belt-and-braces — the function above already handles it.)
-- ============================================================