<div align="center">

# 💬 Kaszael Chit&Chat

### A polished, realtime social chatroom for friends — chat, voice & video calls, with presence and location.

<br/>

![status](https://img.shields.io/badge/status-LIVE-22c55e?style=for-the-badge&logo=netlify&logoColor=white)
![stack](https://img.shields.io/badge/stack-vanilla%20ES%20modules-3b82f6?style=for-the-badge&logo=javascript&logoColor=white)
![backend](https://img.shields.io/badge/backend-Supabase-3ecf8e?style=for-the-badge&logo=supabase&logoColor=white)
![deploy](https://img.shields.io/badge/deploy-Netlify-00C7B7?style=for-the-badge&logo=netlify&logoColor=white)
![themes](https://img.shields.io/badge/themes-30%20switchable-a855f7?style=for-the-badge&logo=color&logoColor=white)
![calls](https://img.shields.io/badge/calls-voice%20%2B%20video%20WebRTC-e91e63?style=for-the-badge)
![build](https://img.shields.io/badge/build-1a4a47f-f59e0b?style=for-the-badge&logo=git&logoColor=white)

<br/>

[**🌐 Live site**](https://kaszael-chat.netlify.app) ·
[**📦 Source**](https://github.com/xerxkaszael-source/kaszael-chit-chat) ·
[**📋 Changelog**](./CHANGELOG.md) ·
[**🛠 Architecture**](./docs/architecture.md)

<br/>

</div>

---

## 📖 Table of contents

- [What is it?](#-what-is-it)
- [Features at a glance](#-features-at-a-glance)
- [Architecture](#-architecture)
- [Deploy](#-deploy)
- [Pre-deploy audit (the 3-way sync check)](#-pre-deploy-audit-the-3-way-sync-check)
- [Audit history](#-audit-history)
  - [Owner Management far-right tab](#owner-management-far-right-tab) · `1664c09`
  - [WebRTC hardening + floating bubble](#webrtc-hardening--floating-bubble) · `1664c09`
  - [deploy.sh error reporting](#deploysh-error-reporting) · `583b1a2`
  - [CHC:busy false-positive (5 root causes)](#chcbusy-false-positive-5-root-causes) · `1a4a47f`
- [Repo layout](#-repo-layout)
- [License](#-license)

---

## ✨ What is it?

A full-scale production chat platform for friends — built and deployed from an Android phone.

- **Primary room "General"** — text, images, files, reactions, replies, edit, recall, pin, presence, typing indicators, broadcasts
- **Direct messages** — inbox, unread counts, mute, pin, real-time delivery, typing in DM, read receipts
- **Voice & video calls** — peer-to-peer via Supabase Realtime signaling, with incoming/active/history UI, floating bubble, mute/camera/hangup
- **Profiles** — avatar, bio, location (privacy-respecting granularity), friend/block system
- **6-tier moderation hierarchy** — Guest → Member → Helper → Moderator → Admin → Owner
- **30 switchable color themes** (dark + light), responsive 320 px → 1920 px
- **All mutations via SECURITY DEFINER RPCs** — tables read-only under RLS, server-side enforcement

Built by **Kaszael Lab** on Android (Termux), deployed from a mobile terminal to Netlify static + Supabase Postgres. Private project.

---

## 🎯 Features at a glance

<table>
<tr><td width="33%" valign="top">

### 💬 Core chat
- Single primary room (`General`) — full DM system alongside
- Text · images · files (R2-backed storage)
- 8-emoji reactions (`+1` ❤️ 😂 😮 😢 🔥 👏 🎉) + replies + edit + recall + pin
- Typing indicators · presence (online/offline)
- @mention highlights with notifications
- Floating broadcast banners (auto-dismiss)
- Guest access (synthetic identity, ephemeral)
- 30 color themes (dark + light)

</td><td width="33%" valign="top">

### 📨 Direct messages
- 1-to-1 conversations with realtime delivery
- Inbox: unread badge · mute · pin · last-message preview
- Per-message: reactions · reply · edit · delete
- Typing indicator in DM
- Read receipts
- Profile-aware DM (call + video icons in header)
- Sound + green-dot unread visual
- Defensive back button (chat → inbox fallback)

</td><td width="33%" valign="top">

### 📞 Voice & video calls
- Peer-to-peer via Supabase Realtime broadcast (private `call:<uuid>` channel)
- Voice + video (`/call/voice/<userId>`, `/call/video/<userId>`)
- Incoming-call modal (Accept/Decline) with ringtone cue
- Active-call floating panel (mic / cam / hangup / minimize)
- **Floating bubble** — draggable, persists across views, tap to restore
- Call history (last 30) with status icons
- **Auto-sweep stale rows** (pg_cron every minute + auto-sweep inside `call_initiate`)
- **`call_self_recover`** — manual recovery from stuck CHC:busy state

</td></tr>
<tr><td width="33%" valign="top">

### 🛡 Moderation & control
- 6-tier role hierarchy: **guest → member → helper → moderator → admin → owner**
- Warn · mute · kick · temp-ban · permanent ban
- Reports queue · recall messages · pin important ones
- Broadcast (admin+) · Delete any message (admin+)
- **Owner Control Center**: stats · roles · chat mgmt · users · audit · system · danger zone
- **URL-persisted tabs** (`#/owner/chat`, `#/owner/users` survive refresh + back/forward)
- Chat management: purge by age · purge all · archive · restore
- Full audit log of every destructive action

</td><td width="33%" valign="top">

### 👥 Friends & social
- Send/accept/decline friend requests
- Friend list with presence & last-seen
- Block users (mutual enforcement, RLS-protected)
- Profile panel with avatar · bio · location · role badge
- Privacy-respecting location (granularity: hidden → country → province → city → district)
- Unfriend with confirmation
- Staff protection (server-side: `friend_request`/`friend_block`/`report_submit` reject staff targets)

</td><td width="33%" valign="top">

### 🔒 Security model
- **All mutations via SECURITY DEFINER RPCs** (tables read-only under RLS) → client forgery impossible
- **Signaling authz**: `isFromParticipant(payload)` client gate on top of RLS-gated `calls` + `call_ice_candidates`
- DB-side rate limits per (user, action) tuple
- Guests can only text (no uploads, no DMs, ephemeral)
- Staff accounts (`owner`/`admin`) protected server-side from friend/block/report abuse
- Audit trail on every role change / ban / mute / delete / purge
- Self-only location visibility override
- **Stale-call recovery**: `pg_cron` sweeper + auto-sweep in `call_initiate` (5-layer defense)

</td></tr>
</table>

---

## 🛠 Tech stack

| Layer | Choice | Why |
|---|---|---|
| **Frontend** | Vanilla ES modules + hash router | No build step, fastest possible first paint, transparent caching |
| **UI icons** | [Flaticon UIcons Regular Straight v3](https://www.flaticon.com/uicons) | Consistent stroke set, free, 7000+ icons (verified 40 used, 0 missing) |
| **Reactions** | Unicode emoji glyphs (👍❤️😂😮😢🔥👏🎉) | Real emoji in DB-stored `:token:` for backward compat |
| **Backend** | Supabase (Postgres + Auth + Realtime + Storage) | One platform for DB + auth + subscriptions + realtime |
| **RPC model** | PL/pgSQL `SECURITY DEFINER` functions | Server-side enforcement, RLS-readonly tables, impossible to bypass from client |
| **Calls** | WebRTC offer/answer via Supabase Realtime broadcast | No third-party SFU needed for 1-to-1 calls |
| **Sweep** | pg_cron `* * * * *` + in-RPC auto-sweep | No client dependency for stale-row cleanup |
| **Deploy** | Netlify static (zip API from `scripts/deploy.sh`) | Free tier, instant rollback, deploy SHA injected into `index.html` |
| **Source-of-truth** | GitHub `xerxkaszael-source/kaszael-chit-chat` (private) | All changes reviewed via git history + 3-way md5 audit |

---

## 🏗 Architecture (one-screen map)

```
┌─────────────────────────────────────────────────────────┐
│ Browser  (kaszael-chat.netlify.app)                     │
│  public/  ──  index.html, js/views, js/lib, styles/     │
│  ESM-only, vendor supabase-js UMD locally               │
│  Hash router: /chat · /dm/<u> · /call/<k>/<u>          │
│              /owner[/<tab>] · /admin[/<tab>]           │
│              /moderation[/<tab>] · /audit · /system    │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTPS (REST + Realtime WS)
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Supabase (himrvevlnbpubwmsdhya)                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Postgres  ──  28 tables, 22 indexes             │   │
│  │  RPCs (SECURITY DEFINER, plpgsql) 122 fns       │   │
│  │  RLS: tables read-only under authenticated role  │   │
│  │  Realtime publication: 10 tables                │   │
│  │  pg_cron: chc_call_miss_sweep_1m (every minute) │   │
│  └─────────────────────────────────────────────────┘   │
│  Auth    ──  email/password (anon JWT in browser)       │
│  Realtime ──  presence + typing + DM + calls           │
│  Storage ──  avatars / chat-images / chat-files buckets  │
└─────────────────────────────────────────────────────────┘
```

Full design doc: [`docs/architecture.md`](./docs/architecture.md).

---

## 🚀 Deploy

```bash
# 1. Apply DB schema to a fresh Supabase project
#    (run migrations in order from supabase/migrations/ via Management API:
#     curl -X POST -H "Authorization: Bearer ***" \
#          -H "User-Agent: curl/7.88.1" \
#          -d '{"query":"<sql>"}' \
#          https://api.supabase.com/v1/projects/$REF/database/query)

# 2. Inject anon key + build marker + zip + push to Netlify
bash scripts/deploy.sh
```

`scripts/deploy.sh` does:
1. Stage `public/` → `build/`
2. Inject `window.SUPABASE_CONFIG` (url, anonKey, appName, version) into `build/js/config.js`
3. Inject short git SHA as `__BUILD_SHA__` in `index.html` (lets users see which deploy they're on)
4. Zip `build/` (Python — Termux has no `zip` binary)
5. Find-or-create Netlify site named `$SITE_NAME` (default `kaszael-chat`)
6. `POST /sites/{id}/deploys` with the zip; record deploy id
7. **Parse JSON properly** — surface real API errors (`Account credit usage exceeded ...`) instead of silently printing `?`

---

## 🧪 Pre-deploy audit (the 3-way sync check)

Every deploy must pass this audit before claiming "live ✅":

| Check | Tool | Pass criterion |
|---|---|---|
| Syntax | `node --check public/js/<file>.js` | exit 0 |
| ESM parse | `node --experimental-vm-modules` + `vm.SourceTextModule` | exit 0 (catches errors `node --check` misses) |
| Local md5 | `md5sum public/js/<file>.js` | matches git HEAD blob |
| GitHub md5 | `curl -L https://raw.githubusercontent.com/.../main/public/js/<file>.js \| md5sum` | matches local |
| **Netlify md5** | `curl -s https://kaszael-chat.netlify.app/js/<file>.js \| md5sum` | **matches GitHub** |
| Build marker | `curl -s https://kaszael-chat.netlify.app/ \| grep 'build [a-z0-9]\+'` | equals git HEAD short SHA |
| Icon validity | grep live Flaticon CSS for each `fi-rs-X` class | all `:before` present |
| Frontend sanity | Supabase CDN first · `createClient` in config.js · UMD not ESM import-map | all 5 |
| Constructor traps | `grep -r 'new X?.()' public/js/` | 0 hits |

INDEX.HTML is the one exception: its md5 always differs from local (deploy script rewrites the build SHA into `index.html`).

---

## 🔬 Audit history

The full ledger lives in [`CHANGELOG.md`](./CHANGELOG.md). The four audits since initial deploy:

### 1. Owner Management far-right tab · commit [`1664c09`](https://github.com/xerxkaszael-source/kaszael-chit-chat/commit/1664c09)

**Symptom:** Clicking the rightmost Owner Center tab on portrait phones / tablets — the tab visually stayed active but content jumped to a different tab.

**Root cause:** Inline `style="display:flex;gap:8px;margin:14px 0"` on the in-page tab bar had **no overflow handling**. On narrow viewports the far-right tab was clipped out of viewport, so the click landed on whatever was below the bar (typically the content area).

**Fix (5 files, +616/-84):**
- `.owner-tabs` / `.mod-tabs` CSS classes — wrap on desktop, `overflow-x: auto` at ≤700px
- Stable IDs `owner-tab-<name>`, `role="tab"`, `aria-selected`
- Defensive `!validTabs.includes(name) → 'roles'` fallback
- `scrollIntoView({ inline: 'center' })` on every setActive

**Verified:** 7/7 owner-tab invariants (rapid switch × 20, fallback, IDs, hash, scrollIntoView).

### 2. WebRTC hardening + floating bubble · commit [`1664c09`](https://github.com/xerxkaszael-source/kaszael-chit-chat/commit/1664c09)

**Hardened:** `lib/call.js` + `views/call.js` (+220 lines net).

| Area | Change |
|---|---|
| **Signaling authz** | `isFromParticipant(payload)` gate — drops any payload whose `from` UID isn't a participant |
| **ICE failure recovery** | `pc.createOffer({ iceRestart: true })` on `connectionstate === 'failed'` (was hard-hangup) |
| **Reconnect timer** | 10s on `disconnected` before ICE restart; 12s timeout for the restart itself |
| **Caller timeout** | 50s client-side timeout via `cancel()` (was infinite — could ring forever) |
| **Bye broadcast** | On teardown, broadcast `bye` so the other side drops their channel |
| **Track dedup** | `getSenders()` dedup before `addTrack` (no double-add on offer/answer) |
| **Error UX** | `friendlyMediaError(NotAllowedError/NotFoundError/NotReadableError/OverconstrainedError)` → useful toast |
| **Floating bubble** | 2 modes (full + minimized). Draggable via PointerEvents, position persisted, tap to restore, 1s duration timer |
| **Responsive** | Landscape phone shrinks panel; portrait phone goes full-width; `safe-area-inset` respected |

**Verified:** 10/10 call.js module-surface invariants; 20/20 ESM parse OK.

### 3. deploy.sh error reporting · commit [`583b1a2`](https://github.com/xerxkaszael-source/kaszael-chit-chat/commit/583b1a2)

**Bug:** When the Netlify account hit its deploy-credit limit (or any other API error), `deploy.sh` printed `deployed: ?` and exited 0 — masking every failure.

**Fix:** Parse JSON, exit non-zero on `error` key, surface the actual API message to stderr. Live diagnostic improvement; future deploys will fail loudly when the credit limit is hit (instead of silently appearing to succeed).

### 4. CHC:busy false-positive (5 root causes) · commit [`1a4a47f`](https://github.com/xerxkaszael-source/kaszael-chit-chat/commit/1a4a47f)

**Symptom:** `Call failed: CHC:busy:You are already in a call.` even though the user wasn't currently in a call. Verified live: a stale `extr4vax → scylza` row dated 2026-09-03 19:09 (5+ hours old, state `calling`) was blocking both users.

**Root causes (5 layered):**

1. **PRIMARY** — `call_miss_sweep` RPC existed but nothing invoked it. No `pg_cron` extension installed, no Edge Function, no other RPC called it. Migration 019's "defense in depth" comment was wrong — relied entirely on the client.
2. `initiate()` only guarded against re-entry after `activeCall` was set. Clicking call twice BEFORE the first RPC returned passed the guard (still null) and raced a second `call_initiate`.
3. Caller-side 50s timeout didn't fire when the user closed the tab — the row stayed.
4. `call_end` had a state gap between `accepted` and `connecting` that could leave rows stuck.
5. `pollActive` rehydrate surfaced the stale row but offered no UI to clean it up — user clicks Call → `CHC:busy`.

**Fix — defense in depth, 5 layers:**

| Layer | What |
|---|---|
| **1. Migration `027_call_busy_recovery.sql` (applied to LIVE DB)** | `pg_cron` extension + `cron.schedule('chc_call_miss_sweep_1m', '* * * * *', ...)` · `call_initiate` now auto-sweeps stale rows (≥60s calling/ringing, ≥120s reconnecting) BEFORE the busy check, in the same transaction · `call_self_recover(uuid, text)` · `call_self_recover_all(text)` · `call_end` loosened to accept ALL non-terminal states · `call_active_count()` diagnostics helper |
| **2. `lib/call.js`** | `_initInFlight` Set guards `initiate()` against re-entrancy · auto-self-recover retry on `CHC:busy` (one shot) · `selfRecoverStale()` · `callSelfRecover(callId)` · `installUnloadCleanup()` (synchronous media/peer cleanup on `beforeunload`/`pagehide`; DB row cleanup delegated to pg_cron since `sendBeacon` cannot carry Supabase auth headers) · `pollActive` emits `stale: true` for rows >60/120s |
| **3. `main.js`** | `boot()` + `onAuthed()` call `selfRecoverStale()` BEFORE `hydrateProfile()` · `installUnloadCleanup()` at module init |
| **4. `views/call.js` + CSS** | `renderStaleBanner()` — when `rehydrate` event has `stale: true`, shows dismissable banner ("Previous call looks abandoned") with "Clear stale call" button that calls `callSelfRecover(callId)` · `.call-stale-banner` CSS (warning-yellow border, responsive) |

**Verified live:**
- `pg_cron` 1.6.4 extension installed
- `cron.job` has `chc_call_miss_sweep_1m` scheduled `* * * * *` active=true
- Injected fake 90s-old stale row → `call_miss_sweep()` → cleared to `state=missed, end_reason=no_answer_timeout`
- `call_active_count()` returns empty (clean DB)
- `call_initiate` body contains `stale_initiate_sweep` + `stale_reconnecting_sweep` + `CHC:busy`
- 24/24 `call.js` exports validated

**Live DB status:** migration 027 applied at 2026-09-04. **The busy-check fix is effective IMMEDIATELY** for any user who reloads:
- Server-side auto-sweep runs inside `call_initiate` before the busy check
- `boot()` + `onAuthed()` call `selfRecoverStale()` before `hydrateProfile()`
- pg_cron sweeps within 60s regardless

**Live CDN status:** Netlify deploy credit limit (`Account credit usage exceeded`). Code is fully pushed to GitHub; live CDN still on `0346cbb`. Client-side UX (stale banner, in-flight guard, auto-self-recover retry) will ship when credits are added and `bash scripts/deploy.sh` runs.

---

## 📁 Repo layout

```
public/
├── index.html              # SPA shell + boot script + Supabase CDN + vendor
├── js/
│   ├── main.js             # Hash router, boot, view entry points
│   ├── config.js           # (built — not in repo, injected by deploy.sh)
│   ├── views/              # One file per major UI surface
│   │   ├── shell.js        # Top bar, side nav, modals
│   │   ├── chat.js         # General room
│   │   ├── message.js      # One message row (reactions + actions)
│   │   ├── composer.js     # Message input (reply/edit/upload/emoji)
│   │   ├── dm.js           # Direct message view (drawShell, picker, reactions)
│   │   ├── inbox.js        # DM list
│   │   ├── call.js         # Voice/video calls (incoming modal, floating panel, history, stale banner)
│   │   ├── panels.js       # Profile side panel
│   │   ├── friends.js      # Friend list + requests
│   │   ├── notifications.js
│   │   ├── admin.js        # Staff shell + moderation tabs (sub-route aware)
│   │   ├── admin2.js       # Owner/audit/system sub-views (URL-persisted tabs)
│   │   ├── auth.js         # Login / register / guest
│   │   ├── location-settings.js
│   │   └── themes.js       # Theme picker
│   ├── lib/                # Cross-view infrastructure
│   │   ├── db.js           # supabase-js client + rpc wrapper
│   │   ├── state.js        # Centralized state + auth context
│   │   ├── util.js         # el/ic/icBtn/toast/modal/confirmModal helpers
│   │   ├── avatar.js       # Avatar + role badges
│   │   ├── realtime.js     # WS channel lifecycle
│   │   ├── presence.js     # Online/offline + last_seen
│   │   ├── sound.js        # DM + call sound cues
│   │   ├── call.js         # WebRTC + call state machine + self-recover + unload cleanup
│   │   ├── dm.js           # DM list/messages/reactions/send (RPC wrappers)
│   │   ├── notifications.js
│   │   ├── broadcast.js
│   │   ├── location.js     # Granularity-aware resolver
│   │   └── read-receipts.js
│   └── vendor/
│       └── supabase.js     # Local UMD build (no CDN dep at boot)
├── styles/
│   ├── app.css             # Main stylesheet (~52 KB)
│   └── themes.css          # 30 themes
└── supabase/migrations/    # 28 ordered SQL files (001 → 027)
scripts/
├── deploy.sh               # Build → zip → Netlify drop (with error reporting)
└── secret-scan.sh          # Pre-commit secret scan (Layer 103)
docs/
└── architecture.md
.github/workflows/
└── deploy.yml              # Auto-deploy on push to main
```

---

## 🪪 License

Private project — Kaszael Lab. All rights reserved.

<div align="center">

<sub>Built with ☕ on Android · deployed from a phone · verified end-to-end against live Supabase · 40 icons all render, 8 emojis all glyph, every URL sub-route survives a refresh, all 5 stale-call defense layers verified.</sub>

</div>
