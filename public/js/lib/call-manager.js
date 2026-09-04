// lib/call-manager.js — Global call manager.
//
// Purpose:
//   Mount ONE authoritative incoming-call listener at app boot. The listener
//   survives navigation: it stays active whether the user is on /chat, /dm,
//   /owner/<tab>, /notifications, or /call itself. Incoming-call UI and the
//   floating active-call bubble are rendered into document.body from this
//   module — they are NOT owned by any view.
//
// Pipeline:
//   A clicks Call ─► call_initiate RPC inserts calls row
//   ─► supabase_realtime postgres_changes INSERT (RLS filters to callee only)
//   ─► this module receives event
//   ─► lib/call.handleIncoming(callId, callerId, kind) sets activeCall
//   ─► emit('incoming') ─► renderIncoming() shows floating modal
//   ─► user clicks Accept ─► lib/call.accept() ─► call_accept RPC + WebRTC
//   ─► emit('state') ─► renderActive() shows floating bubble
//
// Lifecycle:
//   mountCallManager(profile)   — called once from main.js enterApp()
//   unmountCallManager()        — called on logout (kicked-banned) / hard reset
//
// Idempotency:
//   mountCallManager() is safe to call multiple times — second+ calls return
//   the existing channel ref without subscribing again.
//
// Server-truth reads:
//   call_active() on mount lets us recover a still-active row after a
//   page refresh (the WebRTC state itself is lost, but the DB row + state
//   tell us what to surface).

import { sb } from './db.js';
import { state, notify, me } from './state.js';
import {
  accept, decline, cancel, hangup,
  handleIncoming, pollActive,
  subscribe as callSub, getActive,
  toggleMic, toggleCam, isMicOn, isCamOn,
  toggleMinimize, isMinimized, setPanelPosition,
  getElapsedSec, forceHangup, selfRecoverStale
} from './call.js';
import { el, ic, esc, fmtDuration, toast } from './util.js';
import { avatar } from './avatar.js';

// ----- module state -----
let mounted = false;
let _pgChannel = null;          // postgres_changes on public.calls
let _callUnsub = null;          // lib/call.js event bus unsubscribe
let _stateUnsub = null;         // state change unsubscribe
let _incomingCall = null;       // { id, callerId, kind } — for incoming modal
let _panelEl = null;            // active-call floating panel DOM
let _panelTimer = null;         // ticks elapsed-seconds
let _dragState = null;          // bubble drag tracking
let _ringtoneTimer = null;      // incoming-call ringtone loop
let _incomingExpiryTimer = null;// auto-dismiss after 60s

// Constants
const INCOMING_TIMEOUT_MS = 60_000;  // matches DB call_miss_sweep

// ----- debug overlay (development-time diagnostics) -----
// BOTH overlays default to OFF. To enable in production for debugging:
//   window.__CHC_CALL_DEBUG__ = true    → bottom-left [CALL RT] panel
//   window.__CHC_PERM_DEBUG__ = true    → bottom-right [PERM] panel
//   window.chcCallDebug.permEnable() / .debugEnable()  → runtime toggle
// These overlays were annoying during real use; they are now strictly opt-in
// for diagnostics. The bottom-left panel is also de-activated by default
// because most users don't need realtime diagnostics in production.
const _debug = { lastChannel: null, lastStatus: null, lastEvent: null, lastError: null };

function isDebug() {
  try {
    if (typeof window === 'undefined') return false;
    if (window.__CHC_HIDE_DEBUG__) return false;
    // Default OFF. Must explicitly enable.
    return window.__CHC_CALL_DEBUG__ === true;
  } catch (e) { return false; }
}

function ensureDebugOverlay() {
  if (!isDebug()) return;
  if (document.getElementById('chc-call-debug')) return;
  const o = el('div',
    { id: 'chc-call-debug',
      style: 'position:fixed;left:8px;bottom:8px;z-index:2147483646;background:rgba(0,0,0,.78);color:#9be7ff;font:11px/1.35 monospace;padding:8px 10px;border-radius:6px;max-width:340px;pointer-events:none;white-space:pre-wrap;word-break:break-word' },
    '[CALL RT] booting…');
  document.body.appendChild(o);
}

function setDebugLine(label, value) {
  if (!isDebug()) return;
  ensureDebugOverlay();
  const o = document.getElementById('chc-call-debug');
  if (!o) return;
  o.textContent =
    `[CALL RT]\n` +
    `${label}\n` +
    `uid: ${state.profile?.id || '(none)'}\n` +
    `channel: ${_debug.lastChannel || '-'}\n` +
    `status: ${_debug.lastStatus || '-'}\n` +
    `last event: ${_debug.lastEvent || '-'}\n` +
    `last error: ${_debug.lastError || '-'}\n` +
    `mounted: ${mounted}\n` +
    `incoming: ${_incomingCall ? _incomingCall.id.slice(0,8) + ' from ' + (_incomingCall.callerId||'?').slice(0,8) : '-'}\n` +
    `active: ${getActive() ? getActive().callId.slice(0,8) + ' role=' + getActive().role + ' state=' + getActive().state : '-'}`;
}

// ----- public API -----
export function isMounted() { return mounted; }
export function getIncoming() { return _incomingCall; }
export function getDebugSnapshot() { return { ..._debug, mounted, uid: state.profile?.id || null }; }

// Idempotent helper for callers that want to ensure the manager is up
// without knowing whether enterApp() has already done it. Safe to call many
// times — second+ invocations are no-ops.
export function ensureCallManager() {
  if (mounted) return;
  mountCallManager();
}

// ----- mount / unmount -----
export function mountCallManager() {
  if (mounted) return; // idempotent

  const uid = me()?.id;
  if (!uid) {
    // Profile not yet hydrated — defer to next state notification.
    _attachStateListener(() => {
      if (me()?.id && !mounted) mountCallManager();
    });
    return;
  }

  mounted = true;
  console.info('[chc-call-manager] mounting for uid', uid);
  _debug.lastChannel = `call-incoming-global (filter: callee_id=eq.${uid})`;
  setDebugLine('mounting');

  // 1. Subscribe to lib/call.js events (incoming / state / ended / rehydrate).
  _callUnsub = callSub(handleCallEvent);

  // 2. Subscribe to state changes — re-render active panel and tear down on logout.
  _attachStateListener(() => {
    if (!state.profile) {
      unmountCallManager();
      try { _incomingCall = null; renderIncoming(); renderActive(); } catch (e) {}
    } else {
      renderActive();
    }
  });

  // 3. postgres_changes on calls table — INSERT (incoming) + UPDATE (state).
  //    RLS filters rows so we only see calls where auth.uid() matches
  //    caller_id or callee_id. Filter on callee_id is the safe narrow.
  _pgChannel = sb.channel('call-incoming-global')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee_id=eq.${uid}` },
        (payload) => {
          console.info('[chc-call-manager] postgres_changes INSERT', payload?.new);
          _debug.lastEvent = `INSERT call=${payload?.new?.id?.slice(0,8)} caller=${payload?.new?.caller_id?.slice(0,8)} state=${payload?.new?.state}`;
          setDebugLine('event: INSERT');
          onCallsInsert(payload);
        })
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls' },
        (payload) => {
          const c = payload?.new;
          console.info('[chc-call-manager] postgres_changes UPDATE', c?.id, c?.state);
          _debug.lastEvent = `UPDATE call=${c?.id?.slice(0,8)} state=${c?.state}`;
          setDebugLine('event: UPDATE');
          onCallsUpdate(payload);
        })
    .subscribe((status, err) => {
      _debug.lastStatus = status;
      if (err) _debug.lastError = String(err);
      console.info('[chc-call-manager] channel status:', status, err || '');
      if (status === 'SUBSCRIBED') {
        setDebugLine('SUBSCRIBED ✓');
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setDebugLine('SUBSCRIPTION FAILED');
        // Attempt one re-subscribe after a delay (recovery without infinite loop).
        // The channel itself is reusable in supabase-js; calling .subscribe() again
        // reconnects. We throttle to one retry every 5s.
        if (!_reconnectInFlight) {
          _reconnectInFlight = true;
          setTimeout(() => {
            _reconnectInFlight = false;
            try { _pgChannel && _pgChannel.subscribe(); } catch (e) {}
          }, 5000);
        }
      }
    });

  // 4. Authoritative server read: pick up a still-active row after refresh.
  pollActive().catch(() => {});

  // 5. Render whatever we have (likely nothing on fresh mount).
  renderIncoming();
  renderActive();

  // 6. Perm diagnostic overlay is opt-in only (do not auto-mount in
  //    production — toggled via window.__CHC_PERM_DEBUG__ = true).
  try {
    if (typeof window !== 'undefined' && window.__CHC_PERM_DEBUG__ === true) {
      startPermDebugOverlay();
    }
  } catch (e) {}

  // Expose a small console API for runtime debugging.
  try {
    if (typeof window !== 'undefined') {
      window.chcCallDebug = Object.assign(window.chcCallDebug || {}, {
        manager: getDebugSnapshot,
        state: () => ({ activeCall: getActive(), incomingCall: _incomingCall, mounted }),
        accept: () => doAccept(),
        decline: () => doDecline(),
        hangup: () => import('./call.js').then(({ hangup }) => hangup()),
        permEnable: () => { window.__CHC_PERM_DEBUG__ = true; startPermDebugOverlay(); },
        permDisable: () => { window.__CHC_PERM_DEBUG__ = false; const e = document.getElementById('chc-perm-debug'); if (e) e.remove(); },
        debugEnable: () => { window.__CHC_HIDE_DEBUG__ = false; setDebugLine('re-enabled'); },
        debugDisable: () => { window.__CHC_HIDE_DEBUG__ = true; const e = document.getElementById('chc-call-debug'); if (e) e.remove(); },
      });
    }
  } catch (e) {}
}

let _reconnectInFlight = false;

// Subscribe to the global state pubsub exactly once. The returned handle
// overwrites any prior _stateUnsub so we never accumulate listeners.
function _attachStateListener(handler) {
  if (_stateUnsub) { try { _stateUnsub(); } catch (e) {} _stateUnsub = null; }
  // Lazy import avoids a circular reference at module-eval time.
  import('./state.js').then(({ subscribe }) => {
    _stateUnsub = subscribe((topic) => handler(topic));
  }).catch(() => {});
}

export function unmountCallManager() {
  if (!mounted) return;
  mounted = false;
  try { _pgChannel && sb.removeChannel(_pgChannel); } catch (e) {}
  try { _callUnsub && _callUnsub(); } catch (e) {}
  try { _stateUnsub && _stateUnsub(); } catch (e) {}
  _pgChannel = null;
  _callUnsub = null;
  _stateUnsub = null;
  clearInterval(_panelTimer); _panelTimer = null;
  clearTimeout(_ringtoneTimer); _ringtoneTimer = null;
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  // Detach DOM
  const inc = document.getElementById('call-incoming-modal'); if (inc) inc.remove();
  const act = document.getElementById('call-active-panel'); if (act) act.remove();
  _incomingCall = null;
  _panelEl = null;
  console.info('[chc-call-manager] unmounted');
}

// ----- postgres_changes handlers -----
function onCallsInsert(payload) {
  const c = payload?.new;
  if (!c) return;
  if (c.state !== 'calling') return; // only care about incoming calls
  // Hand off to lib/call.js — it sets activeCall, starts signaling, emits 'incoming'.
  handleIncoming(c.id, c.caller_id, c.kind).catch((e) => {
    console.error('[chc-call-manager] handleIncoming failed', e);
  });
}

function onCallsUpdate(payload) {
  const c = payload?.new;
  if (!c) return;
  const a = getActive();
  // Active call state changed → reflect in UI.
  if (a && a.callId === c.id) {
    a.state = c.state;
    renderActive();
    // Caller side: when callee accepts, kick off WebRTC negotiation.
    if (c.state === 'accepted' && a.role === 'caller') {
      import('./call.js').then(({ startNegotiation }) => {
        startNegotiation().catch((e) => toast(`Negotiation failed: ${e.message}`, 'error'));
      });
    }
    if (['ended','failed','declined','missed','cancelled'].includes(c.state)) {
      toast(`Call ${c.state}`, 'info', 1500);
    }
  }
  // Incoming modal: clear if caller cancelled / was declined by someone else.
  if (_incomingCall && _incomingCall.id === c.id &&
      ['ended','cancelled','declined','missed','failed'].includes(c.state)) {
    _incomingCall = null;
    renderIncoming();
  }
}

// ----- lib/call.js event bridge -----
function handleCallEvent(ev) {
  console.info('[chc-call-manager] call-bus event', ev.type, ev.call ? ('call=' + (ev.call.callId||'?').slice(0,8)) : '');
  _debug.lastEvent = `bus:${ev.type}${ev.call ? ' call='+(ev.call.callId||'?').slice(0,8) : ''}`;
  if (ev.type === 'incoming') {
    // Callee sees the incoming bubble. State = incoming_ringing.
    _incomingCall = {
      id: ev.call.callId,
      callerId: ev.call.otherId,
      kind: ev.call.kind
    };
    renderIncoming();
    playRingtone();
    armIncomingExpiry();
  } else if (ev.type === 'state' || ev.type === 'local-stream' || ev.type === 'remote-track') {
    // CRITICAL: Bug #1 fix — only clear the incoming modal when the call
    // state has moved PAST incoming_ringing/accepting. Until then, the
    // incoming modal stays visible while we transition through accepting
    // → connecting → connected.
    const cur = ev.call;
    const pastIncoming = cur && cur.state !== 'incoming_ringing' && cur.state !== 'accepting';
    if (pastIncoming) {
      // Clear incoming modal if this is the same call we were ringing on.
      if (_incomingCall && cur.callId === _incomingCall.id) {
        _incomingCall = null;
        stopRingtone();
        clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
      }
    } else if (cur && cur.state === 'accepting') {
      // While accepting, the modal stays but we add a "Connecting…" overlay.
      const modal = document.getElementById('call-incoming-modal');
      if (modal) {
        const card = modal.querySelector('.call-incoming-card');
        if (card && !card.querySelector('.chc-accepting-pill')) {
          const pill = el('div',
            { class: 'chc-accepting-pill', style: 'margin-top:8px;padding:6px 12px;background:rgba(255,255,255,.12);border-radius:999px;font-size:13px;color:#9be7ff;text-align:center' },
            'Connecting… requesting microphone permission');
          card.appendChild(pill);
        }
      }
    }
    renderIncoming(); // may remove modal if
    renderActive();
  } else if (ev.type === 'ended') {
    _incomingCall = null;
    stopRingtone();
    clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
    renderIncoming();
    renderActive();
  } else if (ev.type === 'rehydrate') {
    const c = ev.call || {};
    if (!_incomingCall && c.caller_id && c.callee_id) {
      _incomingCall = {
        id: c.id, callerId: c.caller_id, calleeId: c.callee_id,
        kind: c.kind, rehydrated: true
      };
    }
    renderIncoming();
    renderActive();
  }
  setDebugLine('event-bus: ' + ev.type);
}

// ----- incoming modal (floating) -----
function renderIncoming() {
  const old = document.getElementById('call-incoming-modal');
  if (old) old.remove();
  if (!_incomingCall) { stopRingtone(); return; }
  const other = state.profiles.get(_incomingCall.callerId) ||
                { id: _incomingCall.callerId, display_name: 'Unknown', avatar_color: '#888' };
  const cur = getActive();
  const isAccepting = cur && cur.callId === _incomingCall.id && cur.state === 'accepting';
  const acceptLabel = isAccepting ? 'Accepting…' : 'Accept';
  const modal = el('div', { id: 'call-incoming-modal', class: 'call-incoming-backdrop' },
    el('div', { class: 'call-incoming-card', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'call-incoming-header' },
        el('span', { class: 'call-kind-badge' },
          ic(_incomingCall.kind === 'video' ? 'video' : 'phone'),
          ' ', _incomingCall.kind, ' call'),
        el('h2', {}, 'Incoming call')),
      avatar(other, { size: 'xl' }),
      el('div', { class: 'call-incoming-name' }, other.display_name || other.username || 'Unknown'),
      el('div', { class: 'call-incoming-actions' },
        el('button', { class: 'btn danger large',
            onclick: () => doDecline() }, ic('phone-slash'), ' Decline'),
        el('button', { class: 'btn primary large',
            onclick: () => doAccept() }, ic('phone-call'),
          ' ', el('span', { class: 'chc-accept-label' }, acceptLabel)))));
  document.body.append(modal);
}

async function doAccept() {
  if (!_incomingCall) return;
  const callId = _incomingCall.id;
  const acceptBtn = document.querySelector('#call-incoming-modal .btn.primary');
  // Idempotent: if already accepting, no-op.
  if (acceptBtn && acceptBtn.disabled) return;
  if (acceptBtn) {
    acceptBtn.disabled = true;
    // Replace innerHTML so the icon is preserved (textContent nukes it).
    const label = acceptBtn.querySelector('.chc-accept-label');
    if (label) label.textContent = 'Accepting…';
    else acceptBtn.textContent = 'Accepting…';
  }
  stopRingtone();
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  try {
    await accept();
  } catch (e) {
    if (acceptBtn) {
      acceptBtn.disabled = false;
      const label = acceptBtn.querySelector('.chc-accept-label');
      if (label) label.textContent = 'Accept';
      else acceptBtn.textContent = 'Accept';
    }
  }
  // Belt-and-braces: re-render the incoming modal so any error state
  // surfaced by lib/call.accept() (e.g. state === 'failed' from media
  // rejection) is reflected in the UI. If state machine has moved past
  // incoming_ringing/accepting, renderIncoming() will tear down the modal
  // and renderActive() will show the active panel with the error banner.
  renderIncoming();
  renderActive();
}

async function doDecline() {
  if (!_incomingCall) return;
  const callId = _incomingCall.id;
  _incomingCall = null;
  renderIncoming();
  stopRingtone();
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  try { await decline('declined'); } catch (e) {}
}

// ----- active-call floating panel -----
function renderActive() {
  const old = document.getElementById('call-active-panel');
  if (old) old.remove();
  clearInterval(_panelTimer); _panelTimer = null;
  const a = getActive();
  if (!a) { _panelEl = null; return; }
  _panelEl = buildActivePanel(a);
  document.body.append(_panelEl);
  attachStreams(_panelEl, a);
  startPanelTimer(_panelEl);
}

function buildActivePanel(a) {
  const other = state.profiles.get(a.otherId) ||
                { id: a.otherId, display_name: 'In call', avatar_color: '#888' };
  const minimized = !!a.minimized;
  // iOS-safe <video> tags: autoplay + playsinline + muted (local) per spec §12.
  const remoteV = a.kind === 'video'
    ? el('video', { class: 'call-tile remote', autoplay: '', playsinline: '', muted: '' }) : null;
  const localV = a.kind === 'video'
    ? el('video', { class: 'call-tile local', autoplay: '', playsinline: '', muted: '' }) : null;
  const avatarBig = (!minimized && a.kind === 'voice') ? avatar(other, { size: 'xl' }) : null;

  // Permission-error banner (spec §10 / §35) — show clear UI when media
  // acquisition failed. Always-visible so the user can read and retry.
  const permErr = a._permissionError;
  const errorBanner = permErr ? el('div',
    { class: 'call-perm-error', style: 'background:rgba(231,76,60,.18);border:1px solid #e74c3c;border-radius:8px;padding:10px 12px;margin-top:8px;font-size:12px;line-height:1.45;color:#ffd9d9' },
    el('div', { style: 'font-weight:700;margin-bottom:4px;color:#ffb3b3' }, ic('triangle-warning'), ' Media access failed'),
    el('div', {}, permErr),
    el('button',
      { class: 'btn sm', style: 'margin-top:8px',
        onclick: async () => {
          // Re-acquire media. The user just saw the OS prompt again.
          try {
            const stream = await navigator.mediaDevices.getUserMedia({
              audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
              video: a.kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false,
            });
            a.localStream = stream;
            a._permissionError = null;
            import('./call.js').then(({ getActive }) => {
              const c = getActive();
              if (c) c.state = 'connecting';
            });
            renderActive();
          } catch (e) {
            a._permissionError = (e && (e.message || String(e))) || 'Permission denied.';
            renderActive();
          }
        } },
      ic('rotate-right'), ' Try again')) : null;

  const micBtn = el('button',
    { class: `call-ctrl${isMicOn() ? '' : ' muted'}`, title: isMicOn() ? 'Mute mic' : 'Unmute mic',
      'aria-label': isMicOn() ? 'Mute mic' : 'Unmute mic',
      onclick: () => { toggleMic(); renderActive(); },
      style: 'display:none' },  // hidden — bubble-row ctrl-mute is the single source
    ic(isMicOn() ? 'microphone' : 'microphone-slash'));
  const camBtn = a.kind === 'video' ? el('button',
    { class: `call-ctrl${isCamOn() ? '' : ' muted'}`, title: isCamOn() ? 'Camera off' : 'Camera on',
      'aria-label': isCamOn() ? 'Camera off' : 'Camera on',
      onclick: () => { toggleCam(); renderActive(); },
      style: 'display:none' },  // hidden — bubble-row ctrl-cam is the single source
    ic(isCamOn() ? 'video-camera' : 'video-slash')) : null;
  const hangupBtn = el('button',
    { class: 'call-ctrl danger', title: 'Hang up', 'aria-label': 'Hang up',
      onclick: () => hangup(),
      style: 'display:none' },  // hidden — bubble-row ctrl-hangup is the single source
    ic('phone-slash'));
  const minimizeBtn = el('button',
    { class: 'call-ctrl ctrl-minimize', title: minimized ? 'Expand' : 'Minimize',
      'aria-label': minimized ? 'Expand' : 'Minimize',
      onclick: (e) => { e.stopPropagation(); toggleMinimize(); } },
    ic(minimized ? 'arrow-up-right-and-arrow-down-left-from-center' : 'arrow-down-right-and-arrow-up-left-from-center'));

  // Show a "connecting…" pill during accepting/connecting/ending/declining
  // (Bug C fix: while RPC is in flight, surface a status pill so the user
  // sees that teardown is in progress and isn't a hang).
  const connPillState = a.state === 'accepting' ? 'Requesting permission…'
    : a.state === 'connecting' ? 'Connecting…'
    : a.state === 'outgoing_calling' ? 'Calling…'
    : a.state === 'outgoing_ringing' ? 'Ringing…'
    : a.state === 'ending' ? 'Disconnecting…'
    : a.state === 'declining' ? 'Declining…'
    : null;
  const connPill = connPillState
    ? el('div', { class: 'call-conn-pill',
        style: 'margin-top:6px;padding:4px 10px;background:rgba(74,158,255,.18);color:#9be7ff;border-radius:999px;font-size:11px;text-align:center;font-weight:600;text-transform:uppercase;letter-spacing:.04em' },
      connPillState)
    : null;

  const bubbleRow = el('div', { class: 'call-active-bubble-row' },
    avatar(other, { size: 'sm', showPresence: false }),
    el('div', { class: 'cab-name' }, other.display_name || 'In call'),
    el('div', { class: 'cab-time' }, fmtDuration(getElapsedSec())),
    el('button', { class: 'ctrl-mute', title: isMicOn() ? 'Mute' : 'Unmute', 'aria-label': 'Toggle microphone',
      onclick: (e) => { e.stopPropagation(); toggleMic(); renderActive(); } },
      ic(isMicOn() ? 'microphone' : 'microphone-slash')),
    a.kind === 'video' ? el('button',
      { class: 'ctrl-cam', title: isCamOn() ? 'Camera off' : 'Camera on', 'aria-label': 'Toggle camera',
        onclick: (e) => { e.stopPropagation(); toggleCam(); renderActive(); } },
      ic(isCamOn() ? 'video' : 'video-slash')) : null,
    !minimized ? el('button',
      { class: 'ctrl-minimize', title: 'Minimize', 'aria-label': 'Minimize',
        onclick: (e) => { e.stopPropagation(); toggleMinimize(); } },
      ic('arrow-down-right-and-arrow-up-left-from-center')) : null,
    el('button', { class: 'ctrl-hangup', title: 'Hang up', 'aria-label': 'Hang up',
      onclick: (e) => { e.stopPropagation(); hangup(); } },
      ic('phone-slash')));

  const panel = el('div',
    { id: 'call-active-panel', class: `call-active-panel${minimized ? ' minimized' : ''}`,
      role: 'dialog', 'aria-label': a.kind === 'video' ? 'Video call' : 'Voice call' },
    bubbleRow,
    minimized ? null : el('div', { class: 'call-active-tiles' }, remoteV, localV),
    minimized ? null : avatarBig,
    minimized ? null : el('div', { class: 'call-active-name' }, other.display_name || 'In call'),
    minimized ? null : el('div', { class: 'call-active-state' }, a.state),
    connPill,
    errorBanner
    // Note: the full controls row (micBtn/camBtn/hangupBtn) is intentionally
    // NOT rendered here — those buttons are in the bubble row at the top of
    // the panel (compact always-visible). Re-rendering them here would create
    // duplicate icons. (Fixes Bug A.) The minimizeBtn is rendered inside
    // the bubble row when not minimized.
  );

  if (minimized) {
    panel.addEventListener('click', (e) => {
      if (_dragState && _dragState.dragged) { _dragState = null; return; }
      if (e.target.closest('button')) return;
      toggleMinimize();
    });
    enableDrag(panel);
  }
  if (a.position && typeof a.position.x === 'number') positionPanel(panel, a.position);
  return panel;
}

function attachStreams(panel, a) {
  const apply = () => {
    if (!panel || !panel.isConnected) return;
    const lv = panel.querySelector('.call-tile.local');
    if (lv && a.localStream && lv.srcObject !== a.localStream) lv.srcObject = a.localStream;
    const rv = panel.querySelector('.call-tile.remote');
    if (rv && a.remoteStream && a.remoteStream.getTracks().length && rv.srcObject !== a.remoteStream) {
      rv.srcObject = a.remoteStream;
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  else setTimeout(apply, 0);
  // Catch the ICE-track-arrival race (remote stream gets its first track AFTER
  // the panel is built).
  setTimeout(apply, 500);
}

function startPanelTimer(panel) {
  clearInterval(_panelTimer);
  _panelTimer = setInterval(() => {
    const p = document.getElementById('call-active-panel');
    if (!p) { clearInterval(_panelTimer); _panelTimer = null; return; }
    const t = p.querySelector('.cab-time');
    if (t) t.textContent = fmtDuration(getElapsedSec());
    const a = getActive(); if (!a) return;
    const muteBtn = p.querySelector('.ctrl-mute, .call-ctrl[title*="mic" i]');
    const camBtn = p.querySelector('.ctrl-cam, .call-ctrl[title*="camera" i]');
    if (muteBtn) {
      const mic = isMicOn();
      muteBtn.classList.toggle('muted', !mic);
      muteBtn.title = mic ? 'Mute mic' : 'Unmute mic';
      muteBtn.setAttribute('aria-label', muteBtn.title);
    }
    if (camBtn) {
      const cam = isCamOn();
      camBtn.classList.toggle('muted', !cam);
      camBtn.title = cam ? 'Camera off' : 'Camera on';
      camBtn.setAttribute('aria-label', camBtn.title);
    }
  }, 1000);
}

function enableDrag(panel) {
  let pid = null;
  const onDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    pid = e.pointerId != null ? e.pointerId : 'mouse';
    const rect = panel.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = rect.top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
    panel.classList.add('dragging');
    _dragState = { startX: e.clientX, startY: e.clientY, origX: rect.left, origY: rect.top, el: panel, dragged: false, pid };
    try { panel.setPointerCapture && panel.setPointerCapture(pid); } catch (e) {}
    e.preventDefault();
  };
  const onMove = (e) => {
    if (!_dragState || _dragState.pid !== pid) return;
    const dx = e.clientX - _dragState.startX;
    const dy = e.clientY - _dragState.startY;
    if (Math.abs(dx) + Math.abs(dy) > 4) _dragState.dragged = true;
    const x = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, _dragState.origX + dx));
    const y = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, _dragState.origY + dy));
    panel.style.left = x + 'px';
    panel.style.top = y + 'px';
  };
  const onUp = (e) => {
    if (!_dragState || _dragState.pid !== pid) return;
    const rect = panel.getBoundingClientRect();
    setPanelPosition(rect.left, rect.top);
    panel.classList.remove('dragging');
    try { panel.releasePointerCapture && panel.releasePointerCapture(pid); } catch (e) {}
    setTimeout(() => { if (_dragState && _dragState.pid === pid) _dragState = null; }, 50);
  };
  panel.addEventListener('pointerdown', onDown);
  panel.addEventListener('pointermove', onMove);
  panel.addEventListener('pointerup', onUp);
  panel.addEventListener('pointercancel', onUp);
}

function positionPanel(panel, pos) {
  panel.style.left = Math.max(8, Math.min(window.innerWidth - panel.offsetWidth - 8, pos.x)) + 'px';
  panel.style.top = Math.max(8, Math.min(window.innerHeight - panel.offsetHeight - 8, pos.y)) + 'px';
  panel.style.right = 'auto';
  panel.style.bottom = 'auto';
}

// ----- ringtone (lightweight) -----
function playRingtone() {
  stopRingtone();
  const AC = window.AudioContext || window.webkitAudioContext;
  if (!AC) return;
  try {
    const ctx = new AC();
    const beep = () => {
      if (!ctx) return;
      try {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.connect(g); g.connect(ctx.destination);
        osc.frequency.value = 440; g.gain.value = 0.08;
        osc.start(); osc.stop(ctx.currentTime + 0.3);
      } catch (e) {}
    };
    beep();
    _ringtoneTimer = setInterval(beep, 1000);
  } catch (e) {}
}
function stopRingtone() {
  if (_ringtoneTimer) { clearInterval(_ringtoneTimer); _ringtoneTimer = null; }
}

// ----- incoming call expiry (60s — matches DB sweep) -----
function armIncomingExpiry() {
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  if (!_incomingCall) return;
  _incomingExpiryTimer = setTimeout(() => {
    if (_incomingCall) {
      // Don't auto-decline (the DB sweep handles that server-side); just clear UI.
      _incomingCall = null;
      renderIncoming();
      stopRingtone();
    }
  }, INCOMING_TIMEOUT_MS);
}

// ----- expose reset for kicked-banned flow -----
export function resetCallUI() {
  forceHangup();
  const inc = document.getElementById('call-incoming-modal'); if (inc) inc.remove();
  const act = document.getElementById('call-active-panel'); if (act) act.remove();
  _incomingCall = null;
  _panelEl = null;
  clearInterval(_panelTimer); _panelTimer = null;
  stopRingtone();
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
}

// =====================================================================
// iOS / iPhone Chrome WebKit reconnect lifecycle (spec §14–17)
// =====================================================================
// iOS Safari + Chrome (both use WebKit on iOS) aggressively suspend WebSocket
// connections when:
//   - the page is backgrounded (visibilitychange → hidden)
//   - the device screen locks
//   - iOS puts the tab in a frozen state
// When the page returns to foreground, the WebSocket may be CLOSED without
// firing an explicit `error` event. Without recovery, the user misses every
// incoming call until they manually reload.
//
// Defense in depth:
//   1. On visibilitychange → visible, force a re-subscribe (no-op if healthy).
//   2. On pageshow, do the same (covers iOS "page restored from frozen" path).
//   3. On online event, do the same.
//   4. We never destroy the channel — supabase-js's channel.subscribe()
//      transparently reconnects the underlying socket if needed.
//   5. If the channel returns SUBSCRIBED, no duplicate listeners are created
//      because we only re-call subscribe(), not channel().
//   6. pollActive() re-validates the authoritative server state on visibility
//      return — if there's an active row, the user sees the bubble immediately.
let _recoveryInFlight = false;
function handleRecovery() {
  if (!mounted) return;
  if (_recoveryInFlight) return;
  _recoveryInFlight = true;
  setTimeout(async () => {
    try {
      const uid = me()?.id;
      if (uid && _pgChannel) {
        // Re-verify auth session (iOS sometimes kills localStorage).
        try {
          const { data } = await sb.auth.getSession();
          if (!data || !data.session) {
            console.warn('[chc-call-manager] recovery: no auth session');
            setDebugLine('recovery: no session');
            _recoveryInFlight = false;
            return;
          }
        } catch (e) { console.warn('[chc-call-manager] getSession failed', e); }
        // Re-subscribe the channel — supabase-js reuses the existing socket if alive.
        try { _pgChannel.subscribe(); } catch (e) { console.warn('[chc-call-manager] re-subscribe failed', e); }
        // Authoritative server read: pick up any active row that arrived while
        // we were disconnected (Bug #2 fix).
        try { await pollActive(); } catch (e) {}
        setDebugLine('recovery: re-subscribed');
      }
    } finally {
      _recoveryInFlight = false;
    }
  }, 250); // small debounce — iOS fires multiple events in rapid succession
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  // Visibility (covers iOS Safari + Chrome on iPhone)
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      console.info('[chc-call-manager] visibility → visible — running recovery');
      handleRecovery();
    }
  });
  // pageshow (covers bfcache restoration on iOS)
  window.addEventListener('pageshow', (e) => {
    if (e.persisted) {
      console.info('[chc-call-manager] pageshow (bfcache) — running recovery');
      handleRecovery();
    }
  });
  // Generic pagehide — DON'T teardown, just observe (so we know to reconnect on return).
  // Network recovery
  window.addEventListener('online', () => {
    console.info('[chc-call-manager] online — running recovery');
    handleRecovery();
  });
  // Offline — log diagnostic; supabase-js will surface CHANNEL_ERROR/TIMED_OUT.
  window.addEventListener('offline', () => {
    console.warn('[chc-call-manager] offline — incoming call delivery may stall');
    _debug.lastError = 'browser offline';
    setDebugLine('offline');
  });
}

// =====================================================================
// Permission diagnostic panel (spec §13) — dev only
// =====================================================================
// Show a small fixed panel with media permission state so the user (and
// the dev) can see at a glance:
//   - isSecureContext
//   - mediaDevices availability
//   - microphone + camera permission state (where queryable)
//   - current call state
//   - last permission error
//
// Toggle with: window.__CHC_PERM_DEBUG__ = true (default false — quieter
// than the realtime overlay).
let _permPollTimer = null;
async function _queryPerm(name) {
  try {
    if (!navigator.permissions || !navigator.permissions.query) return 'unsupported';
    const r = await navigator.permissions.query({ name });
    return r.state; // 'granted' | 'denied' | 'prompt'
  } catch (e) {
    return 'unsupported';
  }
}
function ensurePermDebugOverlay() {
  try {
    if (typeof window === 'undefined') return;
    if (!window.__CHC_PERM_DEBUG__) return;
  } catch (e) { return; }
  if (document.getElementById('chc-perm-debug')) return;
  const o = el('div',
    { id: 'chc-perm-debug',
      style: 'position:fixed;right:8px;bottom:8px;z-index:2147483645;background:rgba(0,0,0,.85);color:#ffd479;font:11px/1.4 monospace;padding:10px 12px;border-radius:8px;max-width:340px;pointer-events:none;white-space:pre-wrap;word-break:break-word' },
    '[PERM] booting…');
  document.body.appendChild(o);
  async function refresh() {
    if (!document.getElementById('chc-perm-debug')) return;
    const mic = await _queryPerm('microphone');
    const cam = await _queryPerm('camera');
    const cur = getActive();
    o.textContent =
      `[PERM]\n` +
      `isSecureContext: ${window.isSecureContext ? 'YES' : 'NO'}\n` +
      `mediaDevices: ${(navigator.mediaDevices && navigator.mediaDevices.getUserMedia) ? 'YES' : 'NO'}\n` +
      `microphone: ${mic}\n` +
      `camera: ${cam}\n` +
      `UA: ${(navigator.userAgent || '').slice(0, 60)}\n` +
      `active: ${cur ? cur.callId.slice(0,8) + ' state=' + cur.state : '-'}\n` +
      `permErr: ${cur && cur._permissionError ? cur._permissionError.slice(0,80) : '-'}`;
  }
  refresh();
  clearInterval(_permPollTimer);
  _permPollTimer = setInterval(refresh, 2000);
}
export function startPermDebugOverlay() {
  ensurePermDebugOverlay();
}

// Re-evaluate permission debug after each render in case mic/cam state changed.
const _origRenderActive = renderActive;
function renderActiveWithPermDebug() {
  _origRenderActive();
  ensurePermDebugOverlay();
}
// Replace the public renderActive with the wrapped version. (We still call
// the original internally via the variable capture above.)