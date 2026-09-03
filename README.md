<div align="center">

# 💬 Kaszael Chit&Chat

### A polished, realtime social chatroom for friends — chat, voice & video calls, with presence and location.

<br/>

![status](https://img.shields.io/badge/status-LIVE-22c55e?style=for-the-badge&logo=netlify&logoColor=white)
![stack](https://img.shields.io/badge/stack-vanilla%20ES%20modules-3b82f6?style=for-the-badge&logo=javascript&logoColor=white)
![backend](https://img.shields.io/badge/backend-Supabase-3ecf8e?style=for-the-badge&logo=supabase&logoColor=white)
![deploy](https://img.shields.io/badge/deploy-Netlify-00C7B7?style=for-the-badge&logo=netlify&logoColor=white)
![themes](https://img.shields.io/badge/themes-30%20switchable-a855f7?style=for-the-badge&logo=color&logoColor=white)
![build](https://img.shields.io/badge/build-bbe3e14-f59e0b?style=for-the-badge&logo=git&logoColor=white)

<br/>

[**🌐 Live site**](https://kaszael-chat.netlify.app) · [📦 Source](https://github.com/xerxkaszael-source/kaszael-chit-chat) · [📋 Changelog](./CHANGELOG.md) · [🛠 Architecture](./docs/architecture.md)

<br/>

</div>

---

## ✨ What is it?

A full-scale production chat platform for friends — built and deployed from an Android phone.

- **Primary room** "General" — text, images, files, reactions, replies, edit, recall, pin, presence, typing indicators, broadcasts
- **Direct messages** — inbox, unread counts, mute, pin, real-time delivery, typing in DM, read receipts
- **Voice & video calls** — peer-to-peer via Supabase Realtime broadcast channel, with incoming/active/history UI
- **Profiles** — avatar, bio, location (privacy-respecting granularity), friend/block system
- **6-tier moderation hierarchy** — Guest → Member → Helper → Moderator → Admin → Owner
- **30 switchable color themes** (dark + light), responsive 320 px → 1920 px
- **All mutations via SECURITY DEFINER RPCs** — tables read-only under RLS, server-side enforcement

Built by **Kaszael Lab** on Android (Termux), deployed from a mobile terminal to Netlify static + Supabase Postgres. Private project.

---

## 🎯 Features at a glance

<table>
<tr>
<td width="33%" valign="top">

### 💬 Core chat
- Single primary room (`General`) — full DM system alongside
- Text · images · files (R2-backed storage)
- 8-emoji reactions (`+1` ❤️ 😂 😮 😢 🔥 👏 🎉) + replies + edit + recall + pin
- Typing indicators · presence (online/offline)
- @mention highlights with notifications
- Floating broadcast banners (auto-dismiss)
- Guest access (synthetic identity, ephemeral)
- 30 color themes (dark + light)

</td>
<td width="33%" valign="top">

### 📨 Direct messages
- 1-to-1 conversations with realtime delivery
- Inbox: unread badge · mute · pin · last-message preview
- Per-message: reactions · reply · edit · delete
- Typing indicator in DM
- Read receipts
- Profile-aware DM (call + video icons in header)
- Sound + green-dot unread visual
- Defensive back button (chat → inbox fallback)

</td>
<td width="33%" valign="top">

### 📞 Voice & video calls
- Peer-to-peer via Supabase Realtime broadcast
- Voice (`/call/audio/<userId>`) and video (`/call/video/<userId>`) routes
- Incoming-call modal (Accept/Decline)
- Active-call floating panel (mic / cam / hangup)
- Call history (last 30) with status icons
- Cross-view persistence (panel stays visible while navigating)
- Privacy-respecting caller ID display

</td>
</tr>
<tr>
<td width="33%" valign="top">

### 🛡 Moderation & control
- 6-tier role hierarchy: **guest → member → helper → moderator → admin → owner**
- Warn · mute · kick · temp-ban · permanent ban
- Reports queue · recall messages · pin important ones
- Broadcast (admin+) · Delete any message (admin+)
- **Owner Control Center**: stats · users · roles · chat mgmt · broadcasts · audit log · settings · danger zone
- Chat management: purge by age · purge all · archive · restore
- Full audit log of every destructive action

</td>
<td width="33%" valign="top">

### 👥 Friends & social
- Send/accept/decline friend requests
- Friend list with presence & last-seen
- Block users (mutual enforcement, RLS-protected)
- Profile panel with avatar · bio · location · role badge
- Privacy-respecting location (granularity: hidden → country → province → city → district)
- Unfriend with confirmation

</td>
<td width="33%" valign="top">

### 🔒 Security model
- **All mutations via SECURITY DEFINER RPCs** (tables read-only under RLS) → client forgery impossible
- DB-side rate limits per (user, action) tuple
- Guests can only text (no uploads, no DMs, ephemeral)
- Staff accounts (`owner`/`admin`) protected server-side from friend/block/report abuse
- Audit trail on every role change / ban / mute / delete / purge
- Self-only location visibility override

</td>
</tr>
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
│  │ Postgres  ──  20+ tables, 22 indexes             │   │
│  │  RPCs (SECURITY DEFINER, plpgsql) ~30 fns        │   │
│  │  RLS: tables read-only under authenticated role  │   │
│  │  Realtime publication: messages + reactions      │   │
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
#     curl -X POST -H "Authorization: Bearer $SUPABASE_PAT" \
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

---

## 🧪 Pre-deploy audit (the 3-way sync check)

Every deploy must pass this audit before claiming "live ✅":

| Check | Tool | Pass criterion |
|---|---|---|
| Syntax | `node --check public/js/<file>.js` | exit 0 |
| Local md5 | `md5sum public/js/<file>.js` | matches git HEAD blob |
| GitHub md5 | `curl -L https://raw.githubusercontent.com/.../main/public/js/<file>.js \| md5sum` | matches local |
| **Netlify md5** | `curl -s https://kaszael-chat.netlify.app/js/<file>.js \| md5sum` | **matches GitHub** |
| Build marker | `curl -s https://kaszael-chat.netlify.app/ \| grep 'build [a-f0-9]\+'` | equals git HEAD short SHA |
| Icon validity | grep live Flaticon CSS for each `fi-rs-X` class | all `:before` present |
| Frontend sanity | Supabase CDN first · `createClient` in config.js · UMD not ESM import-map | all 5 |

INDEX.HTML is the one exception: its CDN md5 always differs from local (deploy script rewrites the build SHA into `js/config.js`).

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
│   │   ├── call.js         # Voice/video calls (incoming modal, active panel, history)
│   │   ├── panels.js       # Profile side panel
│   │   ├── friends.js      # Friend list + requests
│   │   ├── notifications.js
│   │   ├── admin.js        # Staff shell + moderation tabs (sub-route aware)
│   │   ├── admin2.js       # Owner/audit/system sub-views
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
│   │   ├── call.js         # WebRTC + call state machine
│   │   ├── dm.js           # DM list/messages/reactions/send (RPC wrappers)
│   │   ├── notifications.js
│   │   ├── broadcast.js
│   │   ├── location.js     # Granularity-aware resolver
│   │   └── read-receipts.js
│   └── vendor/
│       └── supabase.js     # Local UMD build (no CDN dep at boot)
├── styles/
│   ├── app.css             # Main stylesheet (~46 KB)
│   └── themes.css          # 30 themes
└── supabase/migrations/    # 25 ordered SQL files
scripts/
└── deploy.sh               # Build → zip → Netlify drop
docs/
└── architecture.md
.github/workflows/
└── deploy.yml              # Auto-deploy on push to main
```

---

## 🐛 Recent fixes (the audit-driven cycle)

The full changelog of every fix shipped lives in [**`CHANGELOG.md`**](./CHANGELOG.md). The highlights from this session:

- **`v52-bbe3e14`** — Reaction emojis: real glyphs (👍❤️😂😮😢🔥👏🎉) instead of text labels (`+1`/`love`/`haha`/`fire`/`clap`/`party`); 7 broken Flaticon icon names replaced (`phone`→`phone-call`, `video`→`video-camera`, etc.); DM call/video buttons moved to top right of header
- **`v52-726ba9e`** — Call route bug: `/call/audio/<userId>` was passing args in the wrong order; sub shifted to `/call/<kind>/<userId>` semantics
- **`v52-70b01d4`** — DM header: defensive back button (chat → inbox fallback); call + video icons added; green-dot removed from sideItem; profile shows location
- **`v52-69f8002`** — DM openDm param swap recovery; green-dot; DM sound; owner-bypass DM
- **`v52-c378fe9`** — config.js: commit real anon key, not broken placeholder
- **`v52-79fa9db`** — 3 bugs from Phase 4-7 follow-up audit

Full ledger: `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` (`FIX-20260903-*`).

---

## 🪪 License

Private project — Kaszael Lab. All rights reserved.

<div align="center">

<sub>Built with ☕ on Android · deployed from a phone · verified end-to-end against live Supabase · 40 icons all render, 8 emojis all glyph, every URL sub-route survives a refresh.</sub>

</div>