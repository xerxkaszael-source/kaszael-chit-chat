# Kaszael Chit&Chat — Architecture

**Stack:** Vanilla ES modules (no build step) · Supabase (Auth/Postgres/Realtime/Storage) · Netlify static · GitHub source-of-truth.

## Security model (authoritative)

1. **All mutations via SECURITY DEFINER RPCs.** Tables have RLS enabled with SELECT-only policies. There are NO client-writable table policies — forgery of sender_id/role is structurally impossible.
2. **Identity is always server-derived.** RPCs use `auth.uid()` exclusively. Members authenticate with email+password (Supabase Auth); guests use Supabase **Anonymous Sign-In** — the anon user's server-issued UUID is the bearer identity.
3. **Role hierarchy enforced in SQL.** `_role_level()` maps roles to 0–50; every privileged RPC compares actor vs target level. Owner (50) cannot be acted upon. Clients can never modify `profiles.role` directly.
4. **Owner bootstrap:** created via Supabase Auth (password hashed by Supabase, bcrypt). Plaintext never touches git/frontend/docs/DB.
5. **Guests:** can chat + react, cannot upload/friend/edit/settings. `guest_leave()` purges the profile row, presence, messages, reactions. `guest_purge_stale()` (owner danger zone) removes guests older than 24h.
6. **Rate limiting** is DB-side (`_rate_check`, rolling windows): messages 8/10s, reactions 20/10s, uploads 6/60s, friend requests 20/h, reports 10/h.
7. **Storage:** uploads only under `{own_uid}/…` (RLS storage policies), MIME allowlist enforced twice (storage policy + `attachment_register` RPC).

## Realtime

- `messages`, `message_reactions`, `message_pins`, `broadcasts`, `notifications`, `presence` are on the `supabase_realtime` publication (postgres_changes).
- Typing indicators use **Realtime Broadcast** (zero DB writes), auto-expire after 5s.
- Presence: DB heartbeat every 30s (`presence_heartbeat` also sweeps stale rows >90s). No forever-online users.
- Dedupe: unique index `(sender_id, client_msg_id)` + client-side id check → no duplicate messages on reconnect.

## Tables (18)

profiles · chat_rooms · messages · message_reactions · message_attachments · message_pins · friendships · blocks · presence · reports · mutes · bans · broadcasts · notifications · user_settings · audit_logs · system_settings · rate_limits

**Workspace rule honored: NO foreign keys to `profiles.id`.** All references are plain `uuid` columns + indexes.

## RPC suite (~40 functions)

Guest: guest_enter, guest_leave, guest_purge_stale, guest_purge_one
Profile: profile_init, profile_own, profile_update, user_search, user_public, settings_update
Messages: message_send, message_edit, message_delete_own, message_list, message_recall, message_pin, message_unpin, pins_list, search_messages
Reactions: reaction_toggle, reactions_for
Presence: presence_heartbeat, presence_leave, presence_list, presence_sweep
Friends: friend_request, friend_respond, friend_remove, friends_list, friend_block, friend_unblock, blocks_list
Notifications: notifications_list, notifications_mark_read, notifications_unread_count
Broadcasts: broadcast_send, broadcasts_list, broadcast_delete
Moderation: mod_warn, mod_mute, mod_unmute, mod_ban, mod_unban, mod_kick, mod_reports_list, mod_report_resolve, mod_moderation_state_list, report_submit
Owner: owner_set_role, owner_users_list, owner_stats, owner_audit_list, owner_settings_get, owner_settings_set
Attachments: attachment_register

Internal helpers (`_*`) are REVOKED from anon/authenticated.

## Permission matrix (server-enforced)

| Capability | Guest | Member | Helper | Mod | Admin | Owner |
|---|---|---|---|---|---|---|
| Chat + react | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| Friends/reports | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Edit own / delete own | – | ✓ | ✓ | ✓ | ✓ | ✓ |
| Recall | – | – | – | ✓ | ✓ | ✓ |
| Mute ≤24h / kick / temp-ban ≤24h | – | – | – | ✓ | ✓ | ✓ |
| Permanent-ish ban, pin, broadcast | – | – | – | – | ✓ | ✓ |
| Role management, settings, audit | – | – | – | – | – | ✓ |
| Danger zone | – | – | – | – | – | ✓ |

## Frontend structure

public/index.html → js/config.js (injected at deploy) → js/main.js (router)
- lib/: db, state, realtime, sound, themes (30 themes), util, avatar
- views/: auth, shell (topbar + sidebar + online/offline member lists), chat, composer, message, panels (friends/notifications/pins/search/profile/settings/theme), admin, admin2
- styles/: app.css (design system) + themes.css (30 palettes, dark/light tinted neutrals)
- Icons: Flaticon UIcons 3.0.0 `uicons-regular-straight` CDN (109 verified class names)

## Deployment

- `scripts/deploy.sh`: secret-scan → config injection → Netlify API zip deploy → wait for `ready` → print live URL. Site name: kaszael-chit-chat.
- `scripts/secret-scan.sh` (Layer 103): blocks commit/deploy on JWT/PAT/token patterns and on non-placeholder config.js.
- GitHub repo `xerxkaszael-source/kaszael-chit-chat` is source-of-truth; config.js in git holds placeholders only.
