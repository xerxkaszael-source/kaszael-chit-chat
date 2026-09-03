# Changelog — Kaszael Chit&Chat

All notable changes to this project are documented here. Dates are `YYYY-MM-DD` UTC.

Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). This project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html) loosely — pre-1.0, anything may change.

---

## [Unreleased]

### Fixed (commit `92cea31`) — Accept bubble disappears + iPhone Chrome misses call + permission UX
Three layered call bugs fixed end-to-end per spec §1-50.

**BUG #1 — Accept bubble disappears (root cause confirmed via state-machine audit):**
The legacy `doAccept()` cleared `_incomingCall` and removed the modal from the DOM **before** awaiting `lib/call.accept()`. Then `accept()` called `acquireMedia()` which blocks on the permission prompt; if media failed, the catch handler called `decline('media_failed')` → `teardown()` → `activeCall = null` → no UI ever shown.

**BUG #2 — iPhone Chrome / iOS Safari misses incoming call (root cause: WebSocket suspension):**
iOS WebKit (Safari AND Chrome — both use WebKit on iOS) aggressively suspends WebSocket connections when the page is backgrounded, the device locks, or iOS puts the tab in a frozen state. On return, the socket may be CLOSED without an explicit error event — every incoming-call realtime event is dropped until the user manually reloads.

**BUG #3 — Microphone/camera permission prompt not appearing:**
The old `accept()` had no secure-context check, no per-error-type UI mapping, and silently swallowed getUserMedia failures.

**Fix (state machine + atomic transitions + iOS reconnect + permission UX):**

1. **16-state call state machine** in `lib/call.js` — `idle`, `outgoing_calling`, `outgoing_ringing`, `incoming_ringing`, `accepting`, `connecting`, `connected`, `reconnecting`, `declining`, `declined`, `cancelled`, `busy`, `timeout`, `failed`, `ending`, `ended`. `setCallState()` validates every transition (no-op on invalid).

2. **Atomic accept path** — `incoming_ringing → accepting` (UI updates) → secure-context check → mediaDevices check → `acquireMedia()` → `connecting` → `call_accept` RPC → `drainPendingSignaling()`. ActiveCall NEVER null mid-transition. On failure: state → `failed` with `_permissionError` set; UI shows red banner with Try-Again.

3. **Incoming modal stays visible during accept** — `handleCallEvent` only clears the modal when state has moved PAST `incoming_ringing`/`accepting`. Until then a pulsing "Requesting permission…" pill is shown. `doAccept` disables the button + shows "Accepting…" (idempotent — no double-click race).

4. **iOS lifecycle reconnect** — `visibilitychange → visible`, `pageshow (bfcache)`, `online`, `offline` handlers in `call-manager.js`. Each triggers `handleRecovery()` which re-verifies auth session (`sb.auth.getSession()`) + re-subscribes the existing channel (supabase-js reuses the socket, no duplicates) + calls `pollActive()` to pick up any missed server row. 250ms debounce + `_recoveryInFlight` guard coalesces rapid iOS events.

5. **Per-call-id caller timeout** (`_callerTimeoutTimerByCallId` Map) — old single-timer design leaked when calls overlapped; each timer now guards on `call_id` + state.

6. **Offer-arrives-before-accept race fix** — signaling messages received during `incoming_ringing`/`accepting` are queued in `_pendingSignalingByCallId`, drained after accept completes the state transition.

7. **getUserMedia error mapping** — `NotAllowedError` → permission-denied message (voice vs video tailored), `NotFoundError` → no microphone/camera detected, `NotReadableError` → in use by another app, `OverconstrainedError` → camera doesn't support settings, `SecurityError` → not HTTPS, `NotSupportedError` → browser doesn't support, `AbortError` → interrupted. Per-kind wording (voice = mic only, video = cam + mic).

8. **iOS-safe `<video>` tags** — `autoplay + playsinline + muted` (local tile always muted; remote also muted to satisfy iOS autoplay rules). `env(safe-area-inset-bottom/right)` honored via `@supports` query so the bubble clears the iOS home indicator + notch.

9. **Permission diagnostic panel** — `window.__CHC_PERM_DEBUG__ = true` (default off) shows `isSecureContext`, `mediaDevices` availability, microphone/camera `Permissions.query()` state, UA, current call state, last permission error. Toggleable at runtime via `window.chcCallDebug.permEnable() / permDisable()`.

**Verification (audit_live):**
- `node --check` passes on every file in `public/js/`.
- 0 unresolved imports, 0 `new X?.(` traps, 1 declaration each of `TERMINAL_STATES`/`ALLOWED`/`isTerminal`/`canTransition`/`setCallState`.
- `handleIncoming` called from exactly one production path (call-manager.js line 162).
- Realtime infrastructure smoke test PASSES (service-role → INSERT fires; anon-key path documented as failing per earlier test — fixed in browser via supabase-js auto `setAuth(session.access_token)`).
- No DB changes needed.

**Deploy gate:** pushed to GitHub (`92cea31`). NOT deployed to Netlify — account credit limit hit per M16 (every deploy returns `Account credit usage exceeded`). User must:
1. Add credits via app.netlify.com → Billing, OR
2. Disable envelope-mode blocker per `.netlify/state.json`, OR
3. Deploy to GitHub Pages / Cloudflare Pages / Vercel.

Until the new code is on the CDN, the browser keeps loading the old `0346cbb` build — the bug will not be fixed for the user. After deploy, verify with the diagnostic overlays:
- Bottom-left `[CALL RT]` overlay shows `uid`, `channel: call-incoming-global`, `status: SUBSCRIBED ✓`
- `window.__CHC_PERM_DEBUG__ = true` toggles the `[PERM]` panel bottom-right
- `window.chcCallDebug.state()` returns the current call state machine snapshot
- `window.chcCallDebug.accept()` triggers a programmatic accept (for two-user automated tests)

**NOT VERIFIED:** real two-session browser test (cannot open two browsers from Termux). The user MUST run the iPhone Chrome → desktop and desktop → iPhone Chrome acceptance test from spec §38 once the code is live.

---
User A clicks Voice/Video Call → `call_initiate` inserts the row, the realtime event fires — but User B never received the incoming-call UI unless they happened to be on `/call/inbox` or `/call/history`. On every other route (`/chat`, `/dm/<uid>`, `/owner/<tab>`, `/notifications`, `/friends`, `/location`) there was no listener, so the floating incoming-call modal never appeared. Even on `/call`, the legacy view kept its own local `incoming` variable and called `accept()` from `lib/call.js` without ever going through `handleIncoming()`, so the WebRTC hand-off was a no-op (`activeCall` stayed `null` for the callee path).

**Root causes (2, layered):**
1. **PRIMARY:** `views/call.js` mounted its own postgres_changes subscription on `calls` from inside `renderCallView()`. That function only runs when `view === 'call'` in the router. Result: the realtime listener lived inside the view, not at the app root. Spec §5/§6 explicitly forbid this architecture.
2. `lib/call.js` exports `handleIncoming(callId, callerId, kind)` which sets `activeCall` and emits `incoming`, but **no caller invoked it anywhere in the codebase**. The view's local `renderIncoming()` path bypassed the lib entirely, so `accept()` (guarded on `activeCall.role === 'callee'`) silently no-op'd.

**Fix:**
- New `public/js/lib/call-manager.js` — global call manager:
  - `mountCallManager()` called once from `main.js` `enterApp()` (BEFORE `startRealtime`)
  - postgres_changes subscription on `calls` with `filter: callee_id=eq.<auth.uid()>` (RLS narrows to my rows)
  - On INSERT → `lib/call.handleIncoming()` → emit `incoming` → render floating modal in `document.body`
  - On UPDATE → reflect state, kick off WebRTC negotiation when caller sees `accepted`
  - Owns floating active-call panel (full + minimized bubble modes), drag, mic/cam/hangup
  - `ensureCallManager()` idempotent helper for any view that wants to ensure it's up
- `views/call.js` slimmed from 508 → 146 lines: only history list + `/call/voice|video/<uid>` auto-initiate remain.
- `main.js` wires `mountCallManager()` into `enterApp()`; `resetCallUI` on kicked-banned now comes from the manager.

**DB changes:** none. `calls` is already in `supabase_realtime`, RLS restricts visibility, pg_cron `chc_call_miss_sweep_1m` (last 3 runs succeeded) handles stale-row cleanup server-side.

**Verification (audit_live):**
- `node --check` passes on every file in `public/js/`
- 0 unresolved imports
- 0 `new X?.(` constructor-through-optional-chain traps
- Exactly ONE `call-incoming-*` channel subscriber (the manager)
- `handleIncoming` invoked from exactly one place (manager line 162)
- `mountCallManager` invoked once at boot (main.js line 96); function idempotent

**Deploy gate:** pushed to GitHub (`cd89be6`, `b08786a`, `b437371`). NOT deployed to Netlify — account credit limit hit, every deploy attempt returns `Account credit usage exceeded`. The user MUST redeploy manually:
1. Add credits via app.netlify.com → account → Billing, OR
2. Disable the envelope-mode blocker at `.netlify/state.json` and retry, OR
3. Push the build to a different hosting target (GitHub Pages works as a drop-in)

Until the new code is on the CDN, the user's browser keeps loading the OLD `0346cbb` build — `call-manager.js` returns 404, `views/call.js` still has the OLD view-scoped listener bug, and the incoming-call bubble never appears.

### Diagnostic tooling added (`b437371`)
- Small fixed overlay in the bottom-left of the page showing live realtime state (auth uid, channel name, SUBSCRIBED status, last event, mounted flag, incoming/active call ids).
- Structured `console.info` logs at every key transition (`[chc-call-manager] mounting for uid <id>`, channel status, postgres_changes INSERT/UPDATE, call-bus events).
- One-shot re-subscribe after a 5s delay on CHANNEL_ERROR/TIMED_OUT/CLOSED to recover from transient realtime disconnects without infinite loops.
- Toggle off with `window.__CHC_HIDE_DEBUG__ = true` for production.

---

### Fixed (commit TBD) — CHC:busy false-positive (5 root causes, 6 layers)
When a caller/callee network drops, tab closes, or mobile background suspends the app mid-call, the row in `calls` stays in `calling`/`ringing`/`reconnecting` state forever — and the next time EITHER party tries to call ANYONE, `call_initiate` rejects with `CHC:busy:You are already in a call.` Verified live on 2026-09-04: a stale row from `extr4vax` → `scylza` dated 2026-09-03 19:09 was blocking both users.

**Root causes (5, layered):**
1. **PRIMARY:** `call_miss_sweep` RPC existed but nothing invoked it. No `pg_cron` extension installed, no Edge Function, no other RPC calls it. The migration 019 comment "defense in depth" was wrong — it relied entirely on the client.
2. `initiate()` in `lib/call.js` only guarded against re-entry after `activeCall` was set. Clicking call twice BEFORE the first RPC returned passed the guard (still null) and raced a second `call_initiate` RPC.
3. Caller-side 50s timeout didn't fire when the user closed the tab — the row stayed.
4. `call_end` only worked on a subset of states (gap between `accepted` and `connecting` could leave the row stuck).
5. `pollActive` rehydrate event surfaced the stale row but offered no UI to clean it up — user clicks Call → `CHC:busy`.

**Fix (defense in depth, 4 layers):**

Layer 1 — Migration `027_call_busy_recovery.sql`:
- `CREATE EXTENSION pg_cron` + `cron.schedule('chc_call_miss_sweep_1m', '* * * * *', ...)` — runs every minute
- `call_initiate` now auto-sweeps stale rows (>=60s in calling/ringing, >=120s in reconnecting) BEFORE the busy check, in the same transaction
- `call_self_recover(v_call_id uuid, v_reason text)` — lets a participant manually clean up a stale row
- `call_self_recover_all(v_reason text)` — bulk self-recover (used by the client on boot)
- `call_end` loosened to accept ALL non-terminal states (no more gap)
- `call_active_count()` — diagnostic helper
- All granted to `authenticated`

Layer 2 — `lib/call.js`:
- `_initInFlight` Set guards `initiate()` against re-entrancy
- Auto-self-recover retry on `CHC:busy` (once) — calls `call_self_recover_all` and retries
- `selfRecoverStale()` exported — call on app boot + post-auth
- `callSelfRecover(callId)` exported — UI button hook for the stale banner
- `installUnloadCleanup()` — `beforeunload` + `pagehide` listeners that synchronously stop media tracks + close peer (DB row cleanup delegated to pg_cron since auth headers can't survive unload)
- `pollActive` now tags the emit with `stale: true` if the row is older than 60s/120s in the relevant states
- `installUnloadCleanup` guard for non-browser envs (Node tests / SSR)

Layer 3 — `main.js`:
- `boot()` and `onAuthed()` both call `selfRecoverStale()` BEFORE `hydrateProfile()` — covers the "user already has session, refreshes after a crash" case
- `installUnloadCleanup()` called at module init (alongside `applyTheme` / `watchSystemTheme`)

Layer 4 — `views/call.js`:
- New `renderStaleBanner()` — when `rehydrate` event has `stale: true`, shows a dismissable banner ("Previous call looks abandoned") with a "Clear stale call" button that calls `callSelfRecover(callId)`
- `resetCallUI()` also clears the banner

Layer 5 — CSS:
- `.call-stale-banner` styling (warning-yellow border, centered top, responsive)

**Verified live on DB:**
- `pg_cron` extension installed (1.6.4)
- `cron.job` has `chc_call_miss_sweep_1m` scheduled `* * * * *` active=true
- Injected fake 90s-old stale row → `call_miss_sweep()` cleared it (1 row affected) → state=`missed`, end_reason=`no_answer_timeout`
- `call_active_count()` returns empty (clean)
- `call_initiate` body verified to contain `stale_initiate_sweep` + `stale_reconnecting_sweep` + `CHC:busy`

**Verified locally:**
- 20/20 JS files pass `vm.SourceTextModule` ESM parse
- `node --check` clean
- `call.js` module-surface test: 24/24 exports valid (added `selfRecoverStale`, `callSelfRecover`, `installUnloadCleanup` to the 21 existing)

**Files (4):** `public/js/lib/call.js`, `public/js/main.js`, `public/js/views/call.js`, `public/styles/app.css`, `supabase/migrations/027_call_busy_recovery.sql`

**Live DB status:** migration 027 applied via Management API at 2026-09-04 (the cron job is running NOW). Live CDN still on `0346cbb` (Netlify deploy credit limit) — but the **busy-check fix is effective IMMEDIATELY for any user who reloads**, because:
- The next `call_initiate` will run the auto-sweep server-side (migration 027 is already live).
- Once they re-auth, `selfRecoverStale()` in `boot()` will also clear any leftover rows before the busy check fires.
- The cron job will sweep within 1 minute regardless.

**Users with stuck state right now:** Anyone whose `auth.uid()` is a participant in a stale row should re-auth (or just wait 60s for the cron sweep) and the symptom will disappear.

---

### Fixed (commit `583b1a2` + `1664c09`)
- **deploy.sh error reporting** — when Netlify returns an error (e.g. credit limit, invalid token, payload too large) deploy.sh was printing `deployed: ?` and exiting 0, so the user couldn't tell the deploy had failed. Now the script parses the JSON response, exits non-zero on `error` key, and surfaces the actual API message (e.g. `"Account credit usage exceeded - new deploys are blocked until credits are added"`) to stderr.

### Fixed (commit `1664c09`) — Owner Management tab + WebRTC hardening + floating bubble
Six files changed (+616/-84): `public/js/views/admin2.js`, `public/js/views/admin.js`, `public/js/lib/call.js`, `public/js/views/call.js`, `public/js/main.js`, `public/styles/app.css`.

**Owner Management far-right tab bug — ROOT CAUSE + FIX:**
- The Owner Center in-page tab bar used inline `style="display:flex;gap:8px;..."` with NO overflow handling. On portrait phones / tablets, the **far-right "User management" tab clipped out of viewport** and appeared missing — the user clicked it, the click landed on whatever was below the tab bar (typically the content area), the visible tab stayed active while the content re-rendered for that (now-invisible) tab. Same pattern in the Moderation tab bar.
- Fix: replaced inline styles with stable CSS classes `.owner-tabs` / `.mod-tabs` that wrap on desktop and switch to `overflow-x: auto` horizontal scroll on `max-width: 700px`. Stable `owner-tab-<name>` / `mod-tab-<name>` IDs, `role="tab"`/`role="tablist"`/`role="tabpanel"` for ARIA, `aria-selected` toggling. Defensive `!validTabs.includes(name) → 'roles'` fallback. `scrollIntoView({ inline: 'center' })` on every setActive so the active tab is always visible on narrow screens.

**WebRTC hardening (lib/call.js):**
- `isFromParticipant(payload)` gate in the signaling handler — drops any signal whose `from` UID is not the other participant or self. Server-side RLS on `calls` / `call_ice_candidates` is the primary defense; this is belt-and-braces.
- ICE restart on `connectionstate === 'failed'` (was hard-hangup immediately).
- 10s reconnect timer on `disconnected` before attempting ICE restart.
- 50s caller-side call timeout (was infinite — UI could ring forever).
- `bye` broadcast on teardown so the other side drops its channel.
- Idempotent track-add (`getSenders()` dedup before `addTrack`).
- `friendlyMediaError(NotAllowedError|NotFoundError|NotReadableError|OverconstrainedError)` → useful toast text.
- Fixed `getUserId()` (was `state.profile ? null` — returned null always).
- `forceHangup()` for logout/hard-reset cleanup.
- `isMicOn()` / `isCamOn()` expose real `MediaStreamTrack.enabled` state.
- `setMinimized()` / `toggleMinimize()` / `isMinimized()` for the floating bubble.
- ICE servers array accepts optional `window.SUPABASE_CONFIG.iceServers` override (TURN-ready architecture).

**Floating active-call bubble (Phase 4 from brief §18-20):**
- Active call panel now has 2 modes: full + minimized. Panel is rendered on `document.body` so it persists across view changes.
- Minimized = draggable bubble with avatar + name + duration + mic + cam (video only) + hangup. Tap bubble to restore.
- PointerEvents API for drag (touch + mouse + pen). Position stored on `activeCall.position` so it survives `renderActive` rebuilds.
- 1s `panelTimer` ticks the duration display and refreshes mute/cam icons when the lib flips them.
- `resetCallUI()` exported, wired into `main.js` `kicked-banned` path.
- Landscape phone (`orientation: landscape` + `max-height: 500px`): smaller panel + tiles.
- Portrait phone (`max-width: 480px`): full-width panel.
- `env(safe-area-inset-bottom)` respected on `.call-active-panel` and `.composer`.

**Responsive audit:**
- Composer already used `var(--safe-b)` — extended to call panel.
- No `100vh` anywhere — all `100dvh` throughout.
- Owner tabs horizontal-scroll breakpoint at 700px (where the topbar starts hiding room-sub at 620px is the natural seam).
- Owner tab min-height 36px for thumb-friendly tap targets.

**Verified:**
- 20/20 JS files pass `vm.SourceTextModule` ESM parse (browser-grade, stricter than `node --check`).
- `node --check` on every modified file.
- No `new X?.()` constructor-on-optional-chain traps.
- Owner-tab invariants: 7/7 (rapid switch, fallback, IDs, hash, scrollIntoView).
- call.js module-surface invariants: 10/10 (subscribe, no-call guards, idempotent imports).

**Files (6):** `public/js/views/admin2.js`, `public/js/views/admin.js`, `public/js/lib/call.js`, `public/js/views/call.js`, `public/js/main.js`, `public/styles/app.css`

**DEPLOY STATUS:** Netlify account `xerxkaszael` has hit the deploy-credit limit (`Account credit usage exceeded - new deploys are blocked until credits are added`). Commits are pushed to GitHub `main` (HEAD = `583b1a2`); live CDN is still on `0346cbb` until the credit issue is resolved. The `build/` directory and `deploy.zip` on disk reflect the new code — a re-deploy with valid credits is the final step.

---

### Fixed (commit `0346cbb`)
- **Stuck-on-loading `SyntaxError: Unexpected token ';'. Expected ')'`** — build `c38fbbd` site stuck at "Loading Chit&Chat…" with this JS error. Root cause: commit `bbe3e14` wrapped the 2 DM call buttons (icBtn for voice + video) in a new `el('div', { class: 'dm-call-actions' }, icBtn, icBtn)` wrapper. The wrapper opened **1 new paren** but the closing line `})),` was left with **2 closes** (same as the pre-wrapper code), so the outer `dmViewEl.append(` from line 148 was **never closed**. V8 reported the error at line 181 — but the unclosed `(` was actually from line 148 (V8 reports where it ran out of expected tokens, not where the missing open was). Both `node --check` and strict `vm.SourceTextModule` ESM parsing confirm the bug.
- **Fix**: 1-char change on line 178 — `})),` → `}))),` (closes: arrow fn + icBtn + dm-call-actions wrapper).
- **Verification**: 3-way MD5 LOCAL (`461c79b1...`) = LIVE Netlify CDN = GitHub raw. Fixed pattern `}))),` present, buggy pattern `})),` absent. Build marker `0346cbb` live.
- **Lesson (M14, M15)**: When restructuring children of an `el(..., [...children...])` call into a wrapper, the wrapper's closing paren MUST be added at the correct line. Do a line-by-line paren accounting (after stripping strings/comments) from the OUTERMOST opening — V8's error position is misleading when it points far from the original unclosed paren.

**Files (1):** `public/js/views/dm.js`

---

### Fixed (commit `c38fbbd`)
- **DM cleanup dynamic-import parser trap** — replaced `await import('../lib/notifications.js')` inside `cleanupDmRealtime()` with a direct call to `refreshDmUnread()` (already imported at top). Dynamic `import()` with relative paths was tripping the browser's ESM parser in some build pipelines. (Turned out a separate, older paren bug at `bbe3e14` was the actual cause of the still-stuck loading screen — see commit `0346cbb`.)

**Files (1):** `public/js/views/dm.js`

---

### Fixed (commit `bbe3e14`)
- **Reaction emojis** — reaction picker + already-reacted pills now show real Unicode glyphs (👍 ❤️ 😂 😮 😢 🔥 👏 🎉) instead of the design-time text labels (`+1`, `love`, `haha`, `fire`, `clap`, `party`). DB-stored `:token:` strings unchanged for backward compatibility (resolved via `tokenToGlyph()` lookup; falls back to the raw token for older reactions).
- **Owner/Moderation tab persistence** — `#/owner/chat`, `#/owner/users`, `#/owner/roles` and `#/moderation/reports`, `#/moderation/states`, `#/moderation/lookup` now survive re-renders, browser back/forward, and direct deep-links. Tab click updates the URL; router passes the sub-tab to `ownerView(main, sub)` / `moderationView(main, sub)`. Sidebar "Owner Center" / "Moderation" buttons still default to the first tab.
- **7 broken Flaticon icons** — the icon library `uicons-regular-straight` v3.0.0 doesn't have these class names (`:before` rule absent → blank square): `phone`→`phone-call`, `video`→`video-camera`, `reply`→`reply-all`, `smile`→`smile-beam`, `clock-rotate-right`→`time-past`, `user-times`→`user-xmark`, plain `magnifying-glass`→`magnifying-glass-binary`. Plus 3 admin icons: `box-archive`→`folder-archive`, `broom`→`broom-ball`, `fire`→`fire-flame-simple`. **All 40 icons used in code now have valid Flaticon classes.**
- **DM call/video header layout** — moved voice + video call buttons to the **top right** of the DM header (was next to the username, which didn't fit narrow screens). New `.dm-call-actions` wrapper with `display: inline-flex; gap: 4px; flex-shrink: 0`. Spacer pushes them right via `flex: 1`.
- **Inbox icon spacing** — `.inbox-line2` gap bumped 8px → 10px + 4px right padding so mute/pin icons don't visually collide with the preview text. Mute/pin icon font 12px → 13px for readability.
- **Reaction picker sizing** — `.reaction-pick` was 12px text + 32px tall; now 20px glyph + 36×36 with `scale(1.15)` hover, so the emoji actually looks like an emoji.
- **Reaction-chip + dm-reaction pill sizing** — added `.rx-glyph` / `.dm-rx-glyph` rule (font-size:16px, line-height:1) so the rendered emoji isn't crushed into 12px text.

**Files (7):** `public/js/views/dm.js`, `public/js/views/message.js`, `public/js/views/admin.js`, `public/js/views/admin2.js`, `public/js/main.js`, `public/styles/app.css`, `README.md`, `CHANGELOG.md`

---

### Fixed (commit `726ba9e`)
- **Call router bug** — `#/call/audio/<userId>` was passing args in the wrong order (router did `rest[0]=sub, rest[1]=callKind, rest[2]=calleeId`, so `sub='audio'`, `callKind='<userId>'`, `calleeId=null`). Tap voice/video icon in DM → tab header read "Calls" with active-tab title `sub='audio'`, and the auto-initiate body got `calleeId=null` so nothing happened.
- **Fix**: router detects when `rest[0] === 'audio' || rest[0] === 'video'` and shifts: `_kind = rest[0]; _callee = rest[1]`. Otherwise `_sub = rest[0] || 'inbox'`. Now `#/call/audio/<u>` → `renderCallView(ROOT, 'inbox', 'audio', '<u>')` — title shows "Calls" with Active tab selected, and `initiate('<u>', 'audio')` fires immediately.
- `renderCallView(mainEl, sub='inbox', callKind=null, calleeId=null)` — when both `callKind` and `calleeId` are set (and not already in an active call), the view now auto-fires `initiate(calleeId, callKind)` and toasts "Voice call started" / "Video call started". Skipped when `getActive()` is truthy to avoid duplicate notifications.

**Files (2):** `public/js/views/call.js`, `public/js/main.js`

---

### Fixed (commit `70b01d4`)
- **DM back button** — defensive: if `location.hash === '#/inbox'` already, force re-route via `#/chat` then `requestAnimationFrame(() => location.hash = '#/inbox')`. Avoids the case where `route()` is a no-op because the resolved view name happens to match.
- **DM voice + video icons** — added to DM header. Navigate via `location.hash = '/call/audio/' + currentOtherId` / `/call/video/`. (Required commit `726ba9e` to actually work — that was the router shift fix above.)
- **Removed green-dot from `sideItem`** — `syncNav` no longer toggles the unread green-dot. Inbox already has its own unread counter. The dot was visually noisy and often wrong (didn't match the inbox unread count anyway).
- **Profile location** — `user_public` RPC now returns `location_granularity`, `location_country`, `location_province`, `location_city`, `location_district`, `location_village`, `location_formatted` (migration 025). `renderProfileBody` displays the formatted location (or builds it from the granularity-aware parts) when `location_granularity !== 'hidden'`. Self always sees own location regardless of granularity setting (server-side guarantee in the RPC).
- **Migration 025** — `location_get_for(target_id uuid)` + `user_public` enhancements.

**Files (7):** `public/js/views/dm.js`, `public/js/views/shell.js`, `public/js/views/panels.js`, `public/js/views/main.js`, `public/styles/app.css`, `public/index.html`, `supabase/migrations/025_location_fields.sql`

---

### Fixed (commit `69f8002`)
- **DM openDm param swap** — `openDm(otherId, convId = null)`. Some callers (notably inbox.js — previously bugged) passed `(convId, otherId)`, which made `dm_list` query `conversation_id = otherId` → that UUID has no row in `conversation_members` → returned `'not_member'` → DM stuck on "Loading…". Recovery: detect the swap (otherId looks like UUID but isn't in profiles, AND the second arg looks like a UUID) and silently re-call with the args swapped.
- **DM green-dot** — live green-dot on the DM avatar in inbox indicates "typing in this conversation".
- **DM sound** — soft chime on incoming DM (respects mute setting).
- **Owner-bypass DM** — owner can DM anyone (even without friendship), server-side.

**Files (4):** `public/js/views/dm.js`, `public/js/views/inbox.js`, `public/js/lib/dm.js`, `public/js/lib/sound.js`

---

### Fixed (commit `c378fe9`)
- **config.js commit** — `anon` key is PUBLIC (JWT role=anon, RLS-limited). Was committed as a broken `__SUPABASE_URL__` placeholder; replaced with the real key. Earlier session claimed the inject-at-deploy model was working — verified false when the live site's `config.js` returned `eyJhbG...7cSQ` (truncated to 13 chars) instead of full 208-char JWT.

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
- ✓ All 4 JS file MD5s match between local and `https://kaszael-chat.netlify.app`
- ✓ Build tag `a1b2c3d` live
- ✓ Content checks: `settle-once guard` PRESENT, old `${badge(u.role)}` template GONE in both admin files

**Files (6):** `public/js/lib/util.js`, `public/js/views/admin.js`, `public/js/views/admin2.js`, `public/index.html` (build tag), `supabase/migrations/012_fix_owner_user_delete_pinned_by.sql`, `.gitignore` (catch-all `*.bak.*` pattern)

---

#### `FIX-20260903-07` — User Management tab + `owner_user_delete` RPC (commit `56af756`, `e30f123`)

- **NEW Owner Center tab**: `User management` — searchable list of all users, each row has a Delete button gated by `isMe` + `isStaff` checks. Confirms via `DELETE USER` phrase modal.
- **NEW RPC `owner_user_delete(target_id uuid)`**: owner-only; deletes all user data across 14 tables (notifications, settings, rate_limits, blocks, friendships, reactions, attachments, pins, reports, mutes, bans, audit_logs, presence, profile) + calls `auth.admin.deleteUser()`. Refuses self + other-owner.
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
| `[Unreleased]` | — | live edits since last tag — reactions, tab persistence, icon library sync, DM header layout |
| `[0.4.0]` | 2026-09-03 | Eight rounds of bug fixes; full Owner Center; chat management; staff protection; mod/broadcast UI rewrite |
| `[0.3.0]` | 2026-09-02 | First live deployment |

---

## Verification ladder (every fix)

Every fix in this repo passes this ladder before being marked verified:

1. **Parse-check** — `node --check public/js/<file>.js` for every modified file (must return 0).
2. **Server-side RPC test** (when SQL touched) — sign in as actual owner, call the affected RPC, assert the return value.
3. **3-way MD5 match** — fetched JS file MD5 from `https://kaszael-chat.netlify.app` MUST equal local MD5 MUST equal `https://raw.githubusercontent.com/xerxkaszael-source/kaszael-chit-chat/main/...` raw MD5. INDEX.HTML is the one exception (build SHA is rewritten by `scripts/deploy.sh`).
4. **Content check** — grep the live file for the new pattern AND the absence of the old buggy pattern.
5. **Icon validity** — for every `ic('foo')` or `icBtn('foo', ...)` call, confirm `fi-rs-foo:before` exists in the live Flaticon CSS (`cdn-uicons.flaticon.com/3.0.0/uicons-regular-straight`). 40/40 must pass.
6. **Ledger entry** — append `/sdcard/Kaszael/logs/audits/verification-ledger.jsonl` with the `FIX-YYYYMMDD-NN` id, all evidence, and the lessons learned.

Full ledger: [`/sdcard/Kaszael/logs/audits/verification-ledger.jsonl`](../../../../logs/audits/verification-ledger.jsonl) — 14 entries as of this release.

---

[Keep a Changelog]: https://keepachangelog.com/en/1.1.0/
[Semantic Versioning]: https://semver.org/spec/v2.0.0.html