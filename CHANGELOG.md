# Changelog — Kaszael Chit&Chat

All notable changes to this project are documented here. Dates are `YYYY-MM-DD` UTC.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) loosely — pre-1.0, anything may change.

---

## [Unreleased]

### Fixed
- `FIX-20260903-08` — **broadcast delete / role apply / chat purge / user delete / `[object HTMLSpanElement]`** — *3 shared root causes fixed in one pass.* See below.

---

## [0.4.0] — 2026-09-03

### Fixed

#### `FIX-20260903-08` — Three root causes, four user-reported symptoms (commit `060ab14`)

The four reported bugs (broadcast delete, role apply, chat purge, user delete) were *all* caused by a single client-side Promise race. The visible `[object HTMLSpanElement]` text in the user list was a separate DOM-coercion bug. The user-delete RPC also had a real SQL bug discovered during the audit.

| # | Layer | Bug | Fix |
|---|-------|-----|-----|
| 1 | `util.js` `confirmModal` | `m.close()` synchronously fires `onClose → resolve(false)` **before** `resolve(true)` runs. Promise settles with `false` on every OK click → every modal-gated action early-returned silently with no toast. | Settle-once guard (`settled` flag). `onClose → settle(false)`, `ok click → settle(true); m.close()`. |
| 2 | `admin.js` + `admin2.js` | `lr-title` child = `` `${name} ${is_guest ? '(guest)' : ''} ${badge(u.role)}` `` — template literal coerces the `<span>` via `String()` → `"[object HTMLSpanElement]"`. | Pass `display_name`, guest label, badge as **separate** children to `el()` so it appends the DOM node via the `nodeType` branch. |
| 3 | `owner_user_delete` SQL (migration 011) | `delete from message_pins where user_id = target_id` — actual column is `pinned_by` → 42703. AND function parameter `target_id` shadowed WHERE-clause refs on mutes/bans → 42702 ambiguity (even `v_target_id` alias didn't fix — needed table alias). | **Migration 012**: `v_target_id` alias for non-conflicting tables + `m.target_id` / `b.target_id` table aliases for mutes/bans to qualify the column. |

**End-to-end verification (live Supabase, signed in as owner):**

- ✓ `broadcast_send → broadcast_delete` → 200 `{"ok":true}`
- ✓ `owner_set_role` → flip verified via `owner_users_list`
- ✓ `chat_purge_all` → 200 `{"purged":N}`
- ✓ `owner_user_delete` → profile row deleted, audit_logs entry `USER_DELETED critical`

**Live Netlify verification:**

- ✓ All 4 JS file MD5s match between local and `https://kaszael-chit-chat.netlify.app`
- ✓ Build tag `a1b2c3d` live
- ✓ Content checks: `settle-once guard` PRESENT, old `${badge(u.role)}` template GONE in both admin files

**Files (6):** `public/js/lib/util.js`, `public/js/views/admin.js`, `public/js/views/admin2.js`, `public/index.html` (build tag), `supabase/migrations/012_fix_owner_user_delete_pinned_by.sql`, `.gitignore` (catch-all `*.bak.*` pattern)

---

#### `FIX-20260903-07` — User Management tab + `owner_user_delete` RPC (commit `56af756`, `e30f123`)

- **NEW Owner Center tab**: `User management` — searchable list of all users, each row has a Delete button gated by `isMe` + `isStaff` checks. Confirms via `DELETE USER` phrase modal.
- **NEW RPC `owner_user_delete(target_id uuid)`**: owner-only; deletes all user data across 14 tables (notifications, settings, rate_limits, blocks, friendships, reactions, attachments, pins, reports, mutes, bans, audit_logs, presence, profile) + calls `auth.admin.delete_user()`. Refuses self + other-owner.
- **FK constraints**: `audit_logs.actor_id` and `audit_logs.target_id` changed to `ON DELETE SET NULL` (keep audit history).
- Migration 011 deployed via Management API. *(Superseded by 012 for the ambiguity + column fixes.)*

---

#### `FIX-20260903-06` — `message_list` ambiguous `room_id` (commit `78dbcb9`)

- **Real root cause of "Could not load messages. Retrying…"** — migration 008 introduced a PL/pgSQL ambiguity: the function parameter `room_id` and the `messages.room_id` column both had the same name. Postgres returned `42702: column reference "room_id" is ambiguous` on EVERY call. The frontend's `loadInitial()` retried every 2.5 s forever.
- Migration 010: rewrote `message_list()` using table alias `m` + local variable `v_room` pattern. Returns messages correctly for both initial load and pagination (`before_ts`).
- Verified: HTTP 200 + 5 messages via anon key.

---

#### `FIX-20260903-05` — Staff protection + stuck retry card (commit `cbe9c93`)

- **Staff protection**: server-side RPCs (`friend_request`, `friend_block`, `report_submit`) now reject any target with `role IN ('owner','admin')`. Migration 009 deployed. UI also hides Block + Report buttons on staff profiles (defense in depth — Add friend stays visible but will toast error).
- **Stuck retry card**: `Could not load messages. Retrying…` card now cleared on successful `loadInitial()`. Previously it persisted forever if first attempt failed and later attempt succeeded.

---

#### `FIX-20260903-04` — Broadcast bubble single-X + Chat Management RPCs (commit `f61ba75`)

- **Broadcast bubble single-X**: removed duplicate stray `closeIconSvg()` in `.bb-head` (was rendering 2 X icons per bubble — one real close button and one orphan SVG).
- **Archive input layout**: rewrote `Archive messages older than X days` from `<div class="field">` (cramped stack) to flex row with proper label/input/unit spacing. Added **Restore all archived** button.
- **Realtime broadcast sound timing**: moved `playBroadcastSound()` inside the same `.then()` so sound + bubble appear together.
- **Chat Management RPCs deployed**: migration 008 adds 4 owner-only RPCs (`chat_purge_older_than`, `chat_purge_all`, `chat_archive_older_than`, `chat_archive_restore_all`) + `archived_at` column on messages + updated `message_list()` to exclude archived.

---

#### `FIX-20260903-03` — Mod tab stacking + Broadcast UI rewrite + Chat Mgmt tab (commit `1942a78`, `6bb4444`)

- **Mod tab stacking**: Reports/States/Lookup tabs no longer duplicate content. Single content holder + `setActive()` swap.
- **Unban/Unmute instant feedback**: optimistic UI (row fades 0.4 instantly), button disabled during RPC, toast on success/failure.
- **Broadcast send**: disabled state, loading indicator, proper empty-state message.
- **Broadcast delete**: separated `broadcastCard()` helper, trash icon, refresh history after delete.
- **Role management**: refreshes the badge + dropdown after Apply so the new role is visible immediately.
- **Icon `megaphone` → `bell`**: broadcast header + cards now use bell icon consistently.
- **Chat Management tab (NEW)** in Owner Center: purge by age, purge all, archive (all with `PURGE HISTORY` confirmation).
- **Loading screen logo**: empty `<div class="boot-logo">` replaced with inline SVG chat bubble.

---

#### `FIX-20260903-02` — Stuck-on-loading missing paren in `panels.js` (commit `e607d13`)

- **Symptom**: `JS error: SyntaxError: Unexpected token ';'. Expected ')' to end an argument list.` — site stuck at `Loading Chit&Chat…`
- **Root cause**: `public/js/views/panels.js` line 183 was missing 1 closing paren for `body.append(` opened at line 175. Needed 5 closes after the Date chain; only 4 were present.
- **Why previous session missed it**: `node --check panels.js` reported PASS. The bug only surfaces with a full ESM parser (`Node vm.SourceTextModule`). `node --check` uses V8 script-mode which is more permissive.
- **Fix**: 1-char change on line 183 — `...toLocaleDateString()));` → `...toLocaleDateString()))));`.
- **Lesson (memory)**: For browser-targeted ESM modules, `node --check` is insufficient. Always validate with `vm.SourceTextModule`.

---

## [0.3.0] — 2026-09-02 — Initial live deployment

### Added

- **First deploy** of the complete chatroom: schema, RPC security model, 30-theme frontend, owner bootstrap, role hierarchy, moderation RPCs.
- Full Supabase schema (17 tables, 22 indexes, FK rules), migrations 001–006.
- PL/pgSQL RPCs with `SECURITY DEFINER` and parameter-shadowing fixes (migration `b3ccc25`).
- Netlify deploy script (`scripts/deploy.sh`) — config injection + zip API deploy from Termux.
- GitHub Actions auto-deploy on push to `main` (`.github/workflows/deploy.yml`).
- Cache-busting + on-screen error trap + build marker (commit `546b20f`).
- Vendor `supabase-js` UMD locally (drop jsdelivr CDN dependency — commit `90c03f6`).
- Fix `profile null text`, floating broadcast bubbles, owner broadcast, theme activation (commit `61b291d`).
- Style: center composer input + text-align (commit `2d69c6d`).

### Security

- Owner bootstrap via Supabase Auth admin-create (service key) → password hashed by Supabase; plaintext never persisted.
- Email NOT stored in `profiles` (stays in `auth.users`) → no leak surface.
- No FK to `profiles.id` (workspace database-contract rule) → `profile_id = uuid` columns + indexes.
- Mutations only via RPC; direct table writes denied by RLS.

---

## Release tags

| Tag | Date | Summary |
|---|---|---|
| `[Unreleased]` | — | live edits since last tag |
| `[0.4.0]` | 2026-09-03 | Eight rounds of bug fixes; full Owner Center; chat management; staff protection; mod/broadcast UI rewrite |
| `[0.3.0]` | 2026-09-02 | First live deployment |

---

## Verification ladder (every fix)

Every fix in this repo passes this ladder before being marked verified:

1. **Parse-check** — `node --experimental-vm-modules parse-all.mjs` (catches ESM-specific syntax errors that `node --check` misses).
2. **Server-side RPC test** — sign in as actual owner, call the affected RPC, assert the return value.
3. **Live MD5 match** — fetched JS file MD5 from `https://kaszael-chit-chat.netlify.app` must equal local MD5.
4. **Content check** — grep the live file for the new pattern AND the absence of the old buggy pattern.
5. **Ledger entry** — append `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` with the `FIX-YYYYMMDD-NN` id, all evidence, and the lessons learned.

Full ledger: [`/sdcard/Kaszael/logs/audits/verification-ledger.jsonl`](../../../../logs/audits/verification-ledger.jsonl) — 11 entries as of this release.

---

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html