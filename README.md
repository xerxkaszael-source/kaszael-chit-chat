# Kaszael Chit&Chat

A polished, realtime social chatroom for friends. Pure chat — no calls.

- Single room ("General") · text + images + files · reactions · replies · edit/recall/pin
- Friends, presence (online/offline lists), typing indicators, @mentions, notifications
- Roles: Guest / Member / Helper / Moderator / Admin / Owner — server-enforced hierarchy
- Moderation: warn / mute / kick / temp+permanent ban / recall / reports queue / full audit log
- Owner Control Center: stats, users, roles, broadcasts, audit, settings, danger zone
- 30 switchable color themes (dark + light) · Flaticon UIcons · responsive 320px→1920px
- Security: all mutations via SECURITY DEFINER RPCs, RLS read-only policies, DB-side rate limits

See `docs/architecture.md` for the full design. Deploy: `scripts/deploy.sh` (Netlify). DB: `supabase/migrations/` (fresh Supabase project).
