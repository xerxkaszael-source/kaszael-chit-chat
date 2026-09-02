# Kaszael Chit&Chat — PROJECT.md

**Status:** LIVE (deployed 2026-09-02 — https://kaszael-chit-chat.netlify.app)
**Started:** 2026-09-02
**Stack:** Vanilla ES modules (no build step) + Supabase (Auth/Postgres/Realtime/Storage) + Netlify static deploy + GitHub source-of-truth.

## Purpose
Full-scale production chatroom for friends. Single primary room "General". Pure chat — NO calls of any kind.

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
