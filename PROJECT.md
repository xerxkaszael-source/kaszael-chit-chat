# Kaszael Ngobrol — PROJECT.md (renamed 2026-09-04 from Kaszael Chit&Chat)

**Status:** LIVE (deployed 2026-09-04 — https://kaszael-ngobrol.netlify.app/)
**Started:** 2026-09-02 (as Kaszael Chit&Chat)
**Renamed:** 2026-09-04 — migrated from old Netlify account `kaszael-chat` (credit limit) to new account `kaszaelTM` + new site `kaszael-ngobrol` (site id `803d2c44-4a6a-48e1-8a5c-b78dcee9b4cc`). Old URL `https://kaszael-chat.netlify.app` is dead.
**Stack:** Vanilla ES modules (no build step) + Supabase (Auth/Postgres/Realtime/Storage) + Netlify static deploy + GitHub source-of-truth.

## Purpose
Full-scale production chatroom for friends. Single primary room "General". Includes realtime calls (voice + video) over WebRTC, DMs, friends, owner moderation, broadcasts, audit logs, and location.

## Architecture (summary — detail in docs/)
- Frontend: static SPA, hash router, ES modules, supabase-js via import map (jsdelivr CDN). Dark-first design system.
- Backend: Supabase. ALL mutations via SECURITY DEFINER RPCs (tables read-only under RLS) → client forgery impossible.
- Roles: guest(0) member(10) helper(20) moderator(30) admin(40) owner(50). Hierarchy enforced in RPCs.
- Guests: synthetic profile rows (random UUID = bearer token), anon RPC path, ephemeral — purged on logout + 24h sweep.
- Presence: DB heartbeat (30s) + sweep in same RPC (offline >120s). Typing: Realtime Broadcast (no DB writes).
- Storage: buckets avatars/chat-images/chat-files, authenticated uploads to own `{uid}/` prefix only. Guests text-only.
- Owner bootstrap: Supabase Auth admin-create (service key) → password hashed by Supabase; plaintext never persisted.

## Canonical decisions
1. NO FK to profiles.id (workspace database-contract rule). profile_id = uuid columns + indexes.
2. Email NOT stored in profiles (stays in auth.users) → no leak surface.
3. Mutations only via RPC; direct table writes denied by RLS.
4. Guest messages deleted on guest purge (ephemeral policy); audit event retained.
5. Moderators: recall/mute/kick/temp-ban(≤24h). Admins: +permanent ban/pin/broadcast. Owner: +roles/settings/danger-zone.
6. Netlify deploy = API zip deploy from local build (GitHub repo remains source of truth).

## Important files
- supabase/migrations/001_full_schema.sql — complete schema (fresh project)
- public/ — the deployed site
- scripts/deploy.sh — config injection + Netlify zip deploy
- scripts/secret-scan.sh — pre-commit secret scan (Layer 103)

## Current status / next actions
See TASKS.md. Live state in mission file logs/missions/MISSION-20260902-002-kaszael-chit-chat.md.

## Bug fixes log


### 2026-09-03 — PHASE 4: REALTIME HARDENING + PRESENCE + NOTIFICATION CENTER (commits 08d471a, f1f5325, 9d66589)

**Next-Gen Phase 4 — three incremental commits on `next-gen` branch (3 ahead of `main`).**

- **Phase 4a — DM realtime hardening (`08d471a`)**
  - Fix sender-hydrate hack in dm.js INSERT handler — new messages now resolve
    the sender profile via `ensureProfile()` instead of rendering `?` placeholders.
  - Per-conversation typing broadcast channel `typing-dm:<convId>` — typing events
    no longer leak across conversations.
  - Reactions realtime via postgres_changes on `message_reactions_dm` (RLS-gated).
  - Read-receipts realtime via postgres_changes on `message_reads`; flips
    `m.read_by_other=true` → bubble shows ✓✓ instead of ✓.
  - Debounced batch read-mark (1.5s flush, multi-tab dedup via localStorage).
  - Failed-message state styling (red border + opacity).
  - All styles use theme tokens (--bg-*, --text-*, --accent, --danger).
- **Phase 4b — Centralized read-receipts flusher (`f1f5325`)**
  - New `lib/read-receipts.js` with `queueReadMark(convId, msgId)` — single
    source of truth for the read-mark queue, shared across views.
  - Multi-tab reconcile via `storage` event listener on `chc:dm:read:<convId>`.
  - Optimistic local inbox decrement on successful RPC (zeroes conv's
    `unread_count` and recomputes `state.dmUnreadTotal`).
  - Requeue + retry on RPC failure (no silent data loss).
- **Phase 4c — Presence hardening + Notification Center (`9d66589`)**
  - Migration 018 extends `presence.state` from 3-state (online/idle/offline) to
    full 6-state (online/away/busy/dnd/invisible/offline) per brief §27.
  - Adds `last_activity_at` column + `presence_sweep_away()` server-side sweep.
  - Replaces `presence_heartbeat(session_id)` to accept `v_status` + `v_activity`.
  - New RPCs: `presence_set_status`, `presence_get_for`.
  - New `lib/presence.js` client-side manager: activity detector (mouse/key/touch),
    5-min idle timer, visibility handler, localStorage persistence.
  - `lib/realtime.js` heartbeat carries chosen status; presence track is **skipped
    entirely when status === 'invisible'** (privacy opt-out).
  - Notification Center: new RPCs `notifications_list` (paginated, actor-joined),
    `notifications_mark_read`, `notifications_mark_all_read`.
  - New `views/notifications.js` with full UI: unread row styling, mark-all-read
    button, kind-aware icons, deep-link via `payload.link`.
  - main.js routes `#/notifications` to the new view.
- **Verification:**
  - All JS files pass `node --check`
  - 3 commits pushed to `next-gen` (local == remote hash)
  - GitHub: `9d66589` is HEAD of `next-gen`, ahead of `main` by 3 commits
  - Live URL (`kaszael-chat.netlify.app`) **NOT deployed** — anonKey still
    truncated in `public/js/config.js`; deploy blocked until key restored
- **Live deploy blocker:** anonKey for `himrvevlnbpubwmsdhya` is not in any
  workspace-local env, pool, or git history. Migration 018 + frontend changes
  are ready; will trigger Netlify drop once key is provided.



### 2026-09-03 — PHASE 4 DEPLOYED + LIVE-VERIFIED (commits 95f90ca, 6a98e7a2)

**LIVE @ https://kaszael-chat.netlify.app** — anon key restored (208 chars),
migration 018 applied (16/16 statements), 6 RPC smoke tests pass.

- anonKey: full 208-char JWT for `himrvevlnbpubwmsdhya` (no longer truncated)
- migration 018: 6-state presence enum, last_activity_at, 3 new RPCs,
  notifications RLS, 12-kind check
- Live assets: 26 JS files, 341KB total
- Auth-gated RPCs correctly return `CHC:unauthorized` for anon:
  presence_set_status, presence_heartbeat, notifications_list, profile_own
- Public-by-design RPCs return safe defaults for anon: presence_sweep_away,
  presence_get_for, presence_list, notifications_unread_count
- Direct REST reads blocked by RLS on direct_messages / message_reads /
  notifications (0 rows visible to anon)
- Realtime publication includes notifications + presence tables

Deploy mechanism: `scripts/deploy.sh` reads `~/.hermes/.env` for
SUPABASE_ANON_KEY + NETLIFY_AUTH_TOKEN, injects anon key into config.js,
zips public/, drops to Netlify site `kaszael-chat` via API.


### 2026-09-03 — broadcast delete / role apply / purge / user delete / [object HTMLSpanElement] (FIX-20260903-08)
**Three independent root causes were silently breaking all four reported bugs at once.**

- **(1) `util.js` confirmModal Promise race — THE smoking gun.** Old: `ok.addEventListener('click', () => { m.close(); resolve(true); })`. `m.close()` synchronously fires `onClose → resolve(false)`, settling the Promise before `resolve(true)` can run. Awaiter always saw `false`. Every modal-gated action (broadcast delete, role apply, user delete, chat purge) early-returned with no toast and no state change. Users saw "click does nothing." Fix: settle-once guard (`settled` flag). Verified by simulation: old→False, new→True; cancel path still→False.

- **(2) `admin.js` + `admin2.js` — badge() template-literal coercion.** Old: `lr-title` child = `${name} ${is_guest?'(guest)':''} ${badge(u.role)}`. Template literals coerce the badge `<span>` via `String()` → `"[object HTMLSpanElement]"` so the role badge rendered as raw text instead of a styled element. Fix: pass `display_name`, guest label, badge as SEPARATE children to `el()` so it can append the DOM node (its `nodeType` branch).

- **(3) Supabase — `owner_user_delete` had TWO bugs.**
  - **3a:** migration 011 said `delete from message_pins where user_id = target_id` but the actual column is `pinned_by` → 42703 column does not exist.
  - **3b:** just-discovered — function parameter `target_id` shadows WHERE-clause column refs on mutes/bans → 42702 ambiguous column reference. Even `v_target_id` alias wasn't enough because in `where target_id = X` the LHS bare `target_id` is still ambiguous. Fix: table alias `m.target_id`, `b.target_id` to qualify the column.
  - Migration 012 deployed via Management API.

- **End-to-end verification** (live Supabase, signed in as owner):
  - `broadcast_send → broadcast_delete` → 200 `{"ok":true}`
  - `owner_set_role` → role flip verified via `owner_users_list`
  - `chat_purge_all` → 200 `{"purged":N}`
  - `owner_user_delete` → profile row deleted, audit_logs entry written (`USER_DELETED critical`)
- **Live Netlify verification:** all 4 JS file MD5s match between local and `https://kaszael-chit-chat.netlify.app`. Build tag `a1b2c3d` live.
- **Files (6) committed:** `public/js/lib/util.js`, `public/js/views/admin.js`, `public/js/views/admin2.js`, `public/index.html`, `supabase/migrations/012_fix_owner_user_delete_pinned_by.sql`, `.gitignore` (catch-all bak patterns so timestamped backups never get committed).
- **Commit:** `060ab14` pushed to `xerxkaszael-source/kaszael-chit-chat` main.


### 2026-09-03 — User Management tab + delete RPC (FIX-20260903-07)
- **NEW Owner Center tab**: 'User management' — searchable list of all users, each row has a Delete button gated by isMe + isStaff checks. Confirms via 'DELETE USER' phrase modal.
- **NEW RPC owner_user_delete(target_id uuid)**: owner-only; deletes all user data across 14 tables (notifications, settings, rate_limits, blocks, friendships, reactions, attachments, pins, reports, mutes, bans, audit_logs, presence, profile) + calls `auth.admin.delete_user()`. Refuses self + other-owner.
- **FK constraints**: audit_logs.actor_id and audit_logs.target_id changed to ON DELETE SET NULL (keep audit history).
- **Migration 011 deployed** via Management API.

### 2026-09-03 — message_list ambiguous fix (FIX-20260903-06)
- **Real root cause of "Could not load messages. Retrying…"**: migration 008 (which I wrote earlier this session) introduced a PL/pgSQL ambiguity — the function parameter `room_id` and the `messages.room_id` column both had the same name, so Postgres returned `42702: column reference "room_id" is ambiguous` on EVERY call. The frontend's `loadInitial()` retried every 2.5s forever.
- **Migration 010**: rewrote `message_list()` using table alias `m` + local variable `v_room` pattern (matching the original migration 004 style). Now returns messages correctly for both initial load and pagination (`before_ts`).
- **Verified**: HTTP 200 + 5 messages via anon key. Both branches (initial + pagination) work.

### 2026-09-03 — Security + chat retry (FIX-20260903-05)
- **Staff protection**: server-side RPCs (`friend_request`, `friend_block`, `report_submit`) now reject any target with `role IN ('owner','admin')`. Migration 009 deployed via Supabase Management API. UI also hides Block + Report buttons on staff profiles (defense in depth — 'Add friend' stays visible but will toast error).
- **Stuck retry card**: 'Could not load messages. Retrying…' card now cleared on successful `loadInitial()`. Previously it persisted forever if first attempt failed and later attempt succeeded.

### 2026-09-03 — Batch fixes round 3 (FIX-20260903-04)
- **Broadcast bubble single-X**: removed duplicate stray `closeIconSvg()` in `.bb-head` (was rendering 2 X icons per bubble — one real close button and one orphan SVG). Now only `bb-close` button has the X.
- **Archive input layout**: rewrote `Archive messages older than X days` from `<div class="field">` (cramped stack) to flex row with proper label/input/unit spacing. Added **Restore all archived** button.
- **Realtime broadcast sound timing**: moved `playBroadcastSound()` inside the same `.then()` so sound + bubble appear together (was: sound first, bubble async via dynamic import — caused race).
- **Chat Management RPCs deployed**: `supabase/migrations/008_chat_management.sql` adds 4 owner-only RPCs (`chat_purge_older_than`, `chat_purge_all`, `chat_archive_older_than`, `chat_archive_restore_all`) + `archived_at` column on messages + updated `message_list()` to exclude archived. Deployed via Supabase Management API (`POST /database/query`).
- **Broadcast delete verified**: RPC `broadcast_delete(broadcast_id uuid)` exists and is wired correctly. Earlier "not work" was actually the 2-X bubble bug confusing the user about delete confirmation.

### 2026-09-03 — Batch fixes round 2 (FIX-20260903-03)
- **Mod tab stacking**: Reports/States/Lookup tabs no longer duplicate content. Single content holder + `setActive()` swap.
- **Unban/Unmute instant feedback**: optimistic UI (row fades 0.4 instantly), button disabled during RPC, toast on success/failure.
- **Broadcast send**: disabled state, loading indicator, proper empty-state message.
- **Broadcast delete**: separated `broadcastCard()` helper, trash icon, refresh history after delete.
- **Role management**: refreshes the badge + dropdown after Apply so the new role is visible immediately.
- **Icon `megaphone` → `bell`**: broadcast header + cards now use bell icon consistently.
- **Chat Management tab (NEW)** in Owner Center:
  - Purge messages by age (input days/hours, requires typing `PURGE HISTORY`)
  - Purge ALL chat history (one-shot, requires `PURGE HISTORY`)
  - Archive messages (soft-delete by age threshold, requires `Archive` confirm)
  - All calls expected RPCs: `chat_purge_older_than`, `chat_purge_all`, `chat_archive_older_than` (owner must add to Supabase)
- **Loading screen logo**: empty `<div class="boot-logo">` replaced with inline SVG chat bubble (gradient blue + white path). Now visible before login.

### 2026-09-03 — Stuck-on-loading: missing paren in panels.js (FIX-20260903-02)
- **Symptom:** `JS error: SyntaxError: Unexpected token ';'. Expected ')' to end an argument list.` — site stuck at "Loading Chit&Chat…"
- **Root cause:** `public/js/views/panels.js` line 183 was missing 1 closing paren for `body.append(` opened at line 175. The nested `body.append(el(... el('div', {...}, presExpr, '...Date.toLocaleString()')))` chain needed 5 closes after the Date chain; only 4 were present.
- **Why previous session missed it:** `node --check panels.js` reported PASS. The bug only surfaces with a **full ESM parser** (Node `vm.SourceTextModule`). `node --check` uses V8 script-mode which is more permissive.
- **Fix:** 1-char change on line 183 — `...toLocaleDateString()));` → `...toLocaleDateString()))));` (insert `)` before `;`).
- **Backup:** `public/js/views/panels.js.bak.20260903_012800`
- **Verification:**
  - 18/18 JS files pass `vm.SourceTextModule` ESM parse
  - Full browser-like boot (with browser API shims) loads config.js + main.js without SyntaxError
  - Local MD5 `35b99dd24fc9e6862cbbb84806168e13` == Live MD5 (post-deploy)
  - Netlify deploy id `6a986cbbc0db89e8c3c83e82` state=ready
- **Lesson learned (memory):** For browser-targeted ESM modules, `node --check` is insufficient. Always validate with `vm.SourceTextModule` (Node) or a real bundler. Added `node --experimental-vm-modules` parse-all.mjs harness to `temp/` for future use.
- **Ledger entry:** `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` FIX-20260903-02


### 2026-09-03 — Stuck-on-loading: missing paren in panels.js (FIX-20260903-02)
- **Symptom:** `JS error: SyntaxError: Unexpected token ';'. Expected ')' to end an argument list.` — site stuck at "Loading Chit&Chat…"
- **Root cause:** `public/js/views/panels.js` line 183 was missing 1 closing paren for `body.append(` opened at line 175. The nested `body.append(el(... el('div', {...}, presExpr, '...Date.toLocaleString()')))` chain needed 5 closes after the Date chain; only 4 were present.
- **Why previous session missed it:** `node --check panels.js` reported PASS. The bug only surfaces with a **full ESM parser** (Node `vm.SourceTextModule`). `node --check` uses V8 script-mode which is more permissive.
- **Fix:** 1-char change on line 183 — `...toLocaleDateString()));` → `...toLocaleDateString()))));` (insert `)` before `;`).
- **Backup:** `public/js/views/panels.js.bak.20260903_012800`
- **Verification:**
  - 18/18 JS files pass `vm.SourceTextModule` ESM parse
  - Full browser-like boot (with browser API shims) loads config.js + main.js without SyntaxError
  - Local MD5 `35b99dd24fc9e6862cbbb84806168e13` == Live MD5 (post-deploy)
  - Netlify deploy id `6a986cbbc0db89e8c3c83e82` state=ready
- **Lesson learned (memory):** For browser-targeted ESM modules, `node --check` is insufficient. Always validate with `vm.SourceTextModule` (Node) or a real bundler. Added `node --experimental-vm-modules` parse-all.mjs harness to `temp/` for future use.
- **Ledger entry:** `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` FIX-20260903-02

## PRODUCTION HARDENING PASS (2026-09-03) — §93 DoD re-verify

**Trigger**: re-running MASTER PROMPT after prior session interrupted mid-audit.

**Findings**:
- 3 stale .bak files in `public/` (config.js, shell.js, panels.js) — removed
- `direct_messages`, `conversation_members`, `message_bookmarks` were missing from
  `supabase_realtime` publication — Phase 3 DM realtime was effectively silent
- `direct_messages` lacked `REPLICA IDENTITY FULL` — UPDATE/DELETE payloads were
  incomplete (Realtime spec violation)
- `index.html` build marker was hardcoded `a1b2c3d` (placeholder) — replaced
  with `__BUILD_SHA__` for deploy-time injection
- No new feature work needed — Phases 1-7 (general chat, friends, DM, calls,
  notifications, presence, location, security audit, performance) were all
  already shipped, and §29 icon policy was already addressed in Phase 7
  (emoji audit pass + reaction picker redesign: buttons show text labels,
  not emoji characters)

**Fixes (single commit `1b9513d` on `next-gen`)**:
1. Migration 021 (`supabase/migrations/021_dm_realtime_publication.sql`)
   - ALTER direct_messages REPLICA IDENTITY FULL
   - ADD direct_messages, conversation_members, message_bookmarks to
     supabase_realtime publication (idempotent: skips if already present)
2. `scripts/deploy.sh` §2b — inject short commit SHA into `index.html`
3. `public/index.html` — placeholder `a1b2c3d` → token `__BUILD_SHA__`
4. `public/js/*.bak.1*` — removed (3 files)

**Verified live (post-deploy `6a98f868a1ae2dba21c1c1d3`)**:
- Build marker on live CDN: `1b9513d` ✓
- Anon key length on live CDN: 208 chars ✓
- realtime publication: 10 tables (was 7) ✓
- direct_messages REPLICA IDENTITY: `f` (FULL) ✓
- All 28 JS files pass `node --check` ✓
- All static assets HTTP 200 ✓
- No .bak files in production deploy ✓
- E2E guest flow: signup → guest_enter → message_list → message_send ✓
- E2E member DM flow: signup → friend_request → friend_respond →
  conversation_get_or_create → dm_send ✓
- Security: guests blocked from friend_request (`CHC:guest:Guests cannot
  add friends.`) ✓
- Security: non-friends blocked from conversation_get_or_create
  (`{ok: false, error: 'not_friends'}`) ✓

**§93 Definition of Done**: 14/14 verified (one check originally showed
404 due to my own URL typo — `location.js` is actually
`location-settings.js`, all views verified present).

**Deployment gate**: PASS
- GitHub: `next-gen` at `1b9513d` (17 commits, ahead of main)
- Netlify: live at `https://kaszael-chat.netlify.app` (canonical URL still
  serves real app, no envelope — user unlinked envelope manually)
- DB: 28 tables, 111 RPCs (109 SECDEF), 31 policies, 72 indexes
- Realtime: 10 publication tables
- No secrets committed (anon key is public by design)
