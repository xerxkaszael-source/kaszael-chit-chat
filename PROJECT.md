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
