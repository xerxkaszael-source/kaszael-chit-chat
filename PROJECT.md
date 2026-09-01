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
