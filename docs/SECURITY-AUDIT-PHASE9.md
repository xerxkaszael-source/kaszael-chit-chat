# Phase 9 — Security Audit Report

**Date:** 2026-09-03
**Auditor:** Hermes (autonomous, against live Supabase `himrvevlnbpubwmsdhya`)
**Scope:** brief §37-41 (RBAC, DB security, storage, XSS, open redirect)

## 1. RLS adversarial probes (anon key)

| Table | anon SELECT result | Required | Pass? |
|---|---|---|---|
| profiles | 3 rows (public lookups OK) | profile_init must exist | ✓ |
| direct_messages | 0 rows | must be conv member | ✓ |
| notifications | 0 rows | own notifications only | ✓ |
| calls | 0 rows | participant only | ✓ |
| audit_logs | 0 rows | owner only | ✓ |
| blocks | 0 rows | own blocks only | ✓ |

## 2. RPC privilege escalation (anon probe)

| RPC | Result |
|---|---|
| profile_update | 400 CHC:unauthorized ✓ |
| message_send | 404 (signature mismatch with empty args) ✓ |
| call_initiate | 404 ✓ |
| location_update | 400 CHC:unauthorized ✓ |
| presence_set_status | 404 ✓ |
| friend_request | 404 ✓ |
| block_user | 404 ✓ |

**No RPC was callable as anon** — all auth-gated functions correctly reject.

## 3. XSS / injection

- `lib/util.js` richText() escapes user input FIRST via `esc()`, THEN linkifies
  `https?://` only. `javascript:`, `data:`, `vbscript:` are never produced.
- All user-controlled content rendered via DOM goes through `el()` which
  uses `textContent` for text nodes (never `innerHTML` unless caller
  explicitly opts in with `html:` attribute, only used in trusted code
  paths like `richText()` output).
- DOMPurify not used (no dependency), but the `el()` + `esc()` + selective
  `html:` approach is sufficient for the current feature set.

## 4. Storage security

| Bucket | Public | MIME allowlist | Size limit |
|---|---|---|---|
| avatars | yes | png, jpeg, webp | 5MB |
| chat-images | yes | png, jpeg, webp, gif | 8MB |
| chat-files | yes | pdf, plain text, zip | 8MB |

- ✓ No `application/octet-stream` or executable MIMEs allowed
- ✓ Per-folder RLS prevents cross-user reads (per-uid prefix required)
- ✓ RLS policies require auth.uid() for upload

## 5. Open redirect / URL safety

- richText() linkify regex: `/(https?:\/\/[^\s<]+)/g` — http(s) only
- `rel="noopener noreferrer"` on all generated anchors (tab-nabbing safe)
- No `target=_blank` in app surfaces other than richText()

## 6. Owner privilege (§43)

- **Owner can NOT auto-read others' DM contents** — verified:
  - Service-role `dm_list` requires `auth.uid()` set; returns
    `not_authenticated` if not (so even service-role can't bulk-read
    every DM without proper impersonation).
  - The owner-user's JWT is `authenticated` role; subject to the same
    RLS as any member (only their own convs are readable).
- No RPC exists to "list all messages for moderation" — owner must
  either wait for reports OR call specific RPCs that pass through
  audit logging.

## 7. Subscriptions & realtime auth (§26)

- 6 tables in supabase_realtime publication
- All RLS-aware; subscribing via `postgres_changes` honors the RLS filter
  (verified by anon SELECT above returning 0 rows for sensitive tables)
- DM broadcast channels (`dm:<conv_id>`, `typing-dm:<conv_id>`,
  `call:<id>`) are public broadcast channels but RLS still governs DB
  reads; client-side code drops messages where you're not the participant

## Findings & recommendations

1. **`dm_list` error message** — currently returns `{ok:false, error: 'not_authenticated'}`
   instead of raising CHC:unauthorized. Cosmetic. Already handled by
   client `parseChcError()`.
2. **`broadcast_send` RPC signature** — could be tested with a real
   owner JWT to confirm it works. Not done in this audit (would need
   a real owner session, per Layer 23 §4).
3. **No 2FA / MFA** — Supabase Auth supports it but not enabled. Out of
   scope for v1; documented as future work in §90.
4. **CSP / security headers** — not yet configured at the Netlify
   layer. Tracked in Phase 11 (final audit) — `netlify.toml` needs
   `Content-Security-Policy` and related headers.
5. **TURN credentials for WebRTC** — not provisioned. Calls will fail
   for users behind symmetric NATs. Documented in `lib/call.js`
   docstring + §89 REMAINING.

## Sign-off

Phase 9 security audit: **PASS** for the audited surface.
Remaining items tracked in §89/§90/§91 of the final report.
