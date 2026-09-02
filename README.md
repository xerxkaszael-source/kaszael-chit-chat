<div align="center">

# 💬 Kaszael Chit&Chat

### A polished, realtime social chatroom for friends — pure chat, no calls.

<br/>

![status](https://img.shields.io/badge/status-LIVE-22c55e?style=for-the-badge&logo=netlify&logoColor=white)
![stack](https://img.shields.io/badge/stack-vanilla%20ES%20modules-3b82f6?style=for-the-badge&logo=javascript&logoColor=white)
![backend](https://img.shields.io/badge/backend-Supabase-3ecf8e?style=for-the-badge&logo=supabase&logoColor=white)
![deploy](https://img.shields.io/badge/deploy-Netlify-00C7B7?style=for-the-badge&logo=netlify&logoColor=white)
![themes](https://img.shields.io/badge/themes-30%20switchable-a855f7?style=for-the-badge&logo=color&logoColor=white)

<br/>

[**🌐 Live site**](https://kaszael-chit-chat.netlify.app) · [📦 Source](https://github.com/xerxkaszael-source/kaszael-chit-chat) · [📋 Changelog](./CHANGELOG.md) · [🛠 Architecture](./docs/architecture.md)

<br/>

</div>

---

## ✨ What is it?

A full-scale production chatroom for friends. Single primary room **"General"** — text + images + files + reactions + replies + edit/recall/pin + presence + typing indicators + broadcasts. Roles from Guest to Owner, with server-enforced moderation hierarchy. 30 switchable color themes, responsive 320 px → 1920 px.

Built by **Kaszael Lab** on Android (Termux), deployed from a mobile terminal to Netlify static + Supabase Postgres.

---

## 🎯 Features at a glance

<table>
<tr>
<td width="50%" valign="top">

### 💬 Core chat
- Single primary room (`General`)
- Text, images, files (R2-backed storage)
- Reactions · replies · edit · recall · pin
- Typing indicators · presence (online/offline)
- @mention highlights with notifications
- Floating broadcast banners (auto-dismiss)
- Guest access (synthetic identity, ephemeral)
- 30 color themes (dark + light)

</td>
<td width="50%" valign="top">

### 🛡 Moderation & control
- 6-tier role hierarchy: **guest → member → helper → moderator → admin → owner**
- Warn · mute · kick · temp-ban · permanent ban
- Reports queue · recall messages · pin important ones
- Broadcast (admin+) · Delete any message (admin+)
- **Owner Control Center**: stats · users · roles · broadcasts · audit log · settings · danger zone
- Chat management: purge by age · purge all · archive · restore
- Full audit log of every destructive action

</td>
</tr>
<tr>
<td width="50%" valign="top">

### 🔒 Security model
- **All mutations via SECURITY DEFINER RPCs** (tables read-only under RLS) → client forgery impossible
- DB-side rate limits per (user, action) tuple
- Guests can only text (no uploads, no DMs, ephemeral)
- Staff accounts (`owner`/`admin`) protected server-side from friend/block/report abuse
- Audit trail on every role change / ban / mute / delete / purge

</td>
<td width="50%" valign="top">

### 📐 Engineering
- Vanilla ES modules · no build step · no bundler
- Hash router · SPA · offline-friendly cache headers
- Vendor `supabase-js` UMD locally (no CDN dep)
- Live error trap with on-screen diagnostic overlay
- Build-tag in HTML for cache-buster verification
- Auto-deploy via GitHub Actions on push to `main`

</td>
</tr>
</table>

---

## 🛠 Tech stack

| Layer        | Choice                                              | Why |
|--------------|-----------------------------------------------------|-----|
| Frontend     | Vanilla ES modules + hash router                    | No build step, fastest possible first paint, transparent caching |
| UI icons     | [Flaticon UIcons](https://www.flaticon.com/uicons)  | Consistent stroke set, free, 7000+ icons |
| Backend      | Supabase (Postgres + Auth + Realtime + Storage)     | One platform for DB + auth + subscriptions + file storage |
| RPC model    | PL/pgSQL `SECURITY DEFINER` functions               | Server-side enforcement, RLS-readonly tables, impossible to bypass from client |
| Deploy       | Netlify static (zip API from `scripts/deploy.sh`)   | Free tier, instant rollback, GitHub Actions CI |
| CI/CD        | `.github/workflows/deploy.yml` on push to `main`    | Auto-deploy with manual approval gate |
| Source-of-truth | GitHub `xerxkaszael-source/kaszael-chit-chat` (private) | All changes reviewed via git history |

---

## 🏗 Architecture (one-screen map)

```
┌─────────────────────────────────────────────────────────┐
│ Browser  (kaszael-chit-chat.netlify.app)                 │
│  public/  ──  index.html, js/, styles/, vendor/          │
│  ESM-only, vendor supabase-js UMD locally               │
└──────────────────────────┬──────────────────────────────┘
                           │ HTTPS (REST + Realtime WS)
                           ▼
┌─────────────────────────────────────────────────────────┐
│ Supabase (himrvevlnbpubwmsdhya)                         │
│  ┌─────────────────────────────────────────────────┐   │
│  │ Postgres  ──  17 tables, 22 indexes             │   │
│  │  RPCs (SECURITY DEFINER, plpgsql)                │   │
│  │  RLS: tables read-only under authenticated role  │   │
│  └─────────────────────────────────────────────────┘   │
│  Auth    ──  email/password (anon JWT)                  │
│  Realtime ──  broadcast channel (typing + broadcasts)   │
│  Storage ──  avatars / chat-images / chat-files buckets  │
└─────────────────────────────────────────────────────────┘
```

Full design doc: [`docs/architecture.md`](./docs/architecture.md).

---

## 🚀 Deploy

```bash
# 1. Apply DB schema to a fresh Supabase project
#    (run migrations in order from supabase/migrations/ via Management API)

# 2. Inject config + zip + push to Netlify
bash scripts/deploy.sh
```

CI also auto-deploys on every push to `main` (see `.github/workflows/deploy.yml`).

---

## 🐛 Bug-fix history

The full changelog of every fix shipped lives in [**`CHANGELOG.md`**](./CHANGELOG.md). The highlights:

- **`FIX-20260903-08`** — broadcast delete / role apply / chat purge / user delete / `[object HTMLSpanElement]` — 3 shared root causes
- **`FIX-20260903-07`** — User Management tab + `owner_user_delete` RPC
- **`FIX-20260903-06`** — `message_list` ambiguous column (chat never loaded)
- **`FIX-20260903-05`** — staff protection on friend/block/report + stuck retry card
- **`FIX-20260903-04`** — broadcast bubble single-X + chat management RPCs
- **`FIX-20260903-03`** — mod tab stacking + broadcast UI rewrite + chat mgmt tab
- **`FIX-20260903-02`** — stuck-on-loading missing paren in `panels.js`

Full ledger: `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` (`FIX-20260903-*`).

---

## 🪪 License

Private project — Kaszael Lab. All rights reserved.

<div align="center">

<sub>Built with ☕ on Android · deployed from a phone · verified end-to-end against live Supabase</sub>

</div>