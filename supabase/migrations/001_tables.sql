-- ============================================================
-- KASZAEL CHIT&CHAT — Migration 001: TABLES + INDEXES
-- Fresh Supabase project. Rule: NO FK to profiles.id (workspace contract).
-- Owner canonical UUID: 11111111-1111-1111-1111-111111111111
-- ============================================================

create extension if not exists pgcrypto;

-- ---------- profiles ----------
-- Member/helper/mod/admin/owner rows: id = auth.uid()
-- Guest rows: id = random uuid, is_guest = true
create table if not exists profiles (
  id uuid primary key,
  username text not null unique check (username ~ '^[a-z0-9_]{3,20}$'),
  display_name text not null check (char_length(display_name) between 1 and 40),
  role text not null default 'member' check (role in ('guest','member','helper','moderator','admin','owner')),
  is_guest boolean not null default false,
  bio text default '' check (char_length(bio) <= 300),
  avatar_path text,               -- storage path; null = generated avatar
  avatar_color text not null default '#6c8cff',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists idx_profiles_username on profiles (username);
create index if not exists idx_profiles_role on profiles (role);

-- ---------- chat_rooms ----------
create table if not exists chat_rooms (
  id uuid primary key,
  slug text not null unique,
  name text not null,
  description text not null default '',
  created_at timestamptz not null default now()
);

-- ---------- messages ----------
create table if not exists messages (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null,
  sender_id uuid not null,
  content text not null default '' check (char_length(content) <= 4000),
  reply_to uuid,
  client_msg_id text,
  moderation_state text not null default 'visible' check (moderation_state in ('visible','recalled','deleted')),
  recalled_by uuid,
  recall_reason text,
  recalled_at timestamptz,
  created_at timestamptz not null default now(),
  edited_at timestamptz
);
create unique index if not exists idx_messages_dedup on messages (sender_id, client_msg_id) where client_msg_id is not null;
create index if not exists idx_messages_room_created on messages (room_id, created_at desc);
create index if not exists idx_messages_sender on messages (sender_id);
create index if not exists idx_messages_content_fts on messages using gin (to_tsvector('simple', content));

-- ---------- message_reactions ----------
create table if not exists message_reactions (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null,
  user_id uuid not null,
  emoji text not null check (emoji in ('👍','❤️','😂','😮','😢','🔥','👏','🎉')),
  created_at timestamptz not null default now(),
  unique (message_id, user_id, emoji)
);
create index if not exists idx_reactions_message on message_reactions (message_id);

-- ---------- message_attachments ----------
create table if not exists message_attachments (
  id uuid primary key default gen_random_uuid(),
  message_id uuid,               -- null until the message is sent
  uploader_id uuid not null,
  bucket text not null,
  storage_path text not null,
  filename text not null,         -- sanitized server-side
  mime text not null,
  size_bytes bigint not null check (size_bytes >= 0),
  kind text not null check (kind in ('image','file')),
  created_at timestamptz not null default now()
);
create index if not exists idx_attachments_message on message_attachments (message_id);

-- ---------- message_pins ----------
create table if not exists message_pins (
  id uuid primary key default gen_random_uuid(),
  message_id uuid not null unique,
  pinned_by uuid not null,
  created_at timestamptz not null default now()
);

-- ---------- friendships ----------
create table if not exists friendships (
  id uuid primary key default gen_random_uuid(),
  requester_id uuid not null,
  addressee_id uuid not null,
  status text not null default 'pending' check (status in ('pending','accepted','declined')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (requester_id, addressee_id)
);
create index if not exists idx_friendships_addressee on friendships (addressee_id, status);
create index if not exists idx_friendships_requester on friendships (requester_id, status);

-- ---------- blocks ----------
create table if not exists blocks (
  id uuid primary key default gen_random_uuid(),
  blocker_id uuid not null,
  blocked_id uuid not null,
  created_at timestamptz not null default now(),
  unique (blocker_id, blocked_id)
);

-- ---------- presence ----------
create table if not exists presence (
  user_id uuid primary key,
  state text not null default 'online' check (state in ('online','idle','offline')),
  session_id text not null default '',
  kicked boolean not null default false,
  kicked_reason text,
  last_seen timestamptz not null default now()
);
create index if not exists idx_presence_state on presence (state, last_seen);

-- ---------- reports ----------
create table if not exists reports (
  id uuid primary key default gen_random_uuid(),
  reporter_id uuid not null,
  target_user_id uuid,
  message_id uuid,
  category text not null check (category in ('spam','harassment','abuse','inappropriate','impersonation','malicious','other')),
  reason text not null default '' check (char_length(reason) <= 1000),
  status text not null default 'open' check (status in ('open','reviewing','resolved','dismissed')),
  handled_by uuid,
  handled_at timestamptz,
  created_at timestamptz not null default now()
);
create index if not exists idx_reports_status on reports (status, created_at desc);

-- ---------- mutes ----------
create table if not exists mutes (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null,
  actor_id uuid not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz,          -- null = permanent (policy: admin+)
  active boolean not null default true
);
create index if not exists idx_mutes_target on mutes (target_id, active);

-- ---------- bans ----------
create table if not exists bans (
  id uuid primary key default gen_random_uuid(),
  target_id uuid not null,
  actor_id uuid not null,
  reason text not null default '',
  created_at timestamptz not null default now(),
  expires_at timestamptz,          -- null = permanent
  active boolean not null default true
);
create index if not exists idx_bans_target on bans (target_id, active);

-- ---------- broadcasts ----------
create table if not exists broadcasts (
  id uuid primary key default gen_random_uuid(),
  author_id uuid not null,
  kind text not null check (kind in ('info','announcement','warning','maintenance','system')),
  title text not null check (char_length(title) between 1 and 120),
  body text not null check (char_length(body) between 1 and 2000),
  created_at timestamptz not null default now()
);

-- ---------- notifications ----------
create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null,
  kind text not null check (kind in ('friend_request','friend_accepted','mention','moderation','broadcast','system')),
  actor_id uuid,
  payload jsonb not null default '{}'::jsonb,
  read boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_user on notifications (user_id, read, created_at desc);

-- ---------- user_settings ----------
create table if not exists user_settings (
  user_id uuid primary key,
  appearance text not null default 'system' check (appearance in ('light','dark','system')),
  enter_to_send boolean not null default true,
  compact_mode boolean not null default false,
  timestamps_24h boolean not null default true,
  notify_friend boolean not null default true,
  notify_mention boolean not null default true,
  notify_moderation boolean not null default true,
  sound_enabled boolean not null default true,
  updated_at timestamptz not null default now()
);

-- ---------- audit_logs (also moderation audit trail) ----------
create table if not exists audit_logs (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid,
  action text not null,            -- USER_BANNED, MESSAGE_RECALLED, ROLE_CHANGED, ...
  target_id uuid,
  message_id uuid,
  reason text not null default '',
  meta jsonb not null default '{}'::jsonb,
  severity text not null default 'info' check (severity in ('info','warning','critical')),
  created_at timestamptz not null default now()
);
create index if not exists idx_audit_created on audit_logs (created_at desc);
create index if not exists idx_audit_action on audit_logs (action);

-- ---------- system_settings ----------
create table if not exists system_settings (
  key text primary key,
  value jsonb not null,
  updated_by uuid,
  updated_at timestamptz not null default now()
);

-- ---------- rate_limits (rolling counters) ----------
create table if not exists rate_limits (
  user_id uuid not null,
  action text not null,
  window_start timestamptz not null default now(),
  count int not null default 1,
  primary key (user_id, action)
);
