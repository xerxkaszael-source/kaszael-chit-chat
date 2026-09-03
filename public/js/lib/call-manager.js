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

// ----- public API -----
export function isMounted() { return mounted; }
export function getIncoming() { return _incomingCall; }

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

  // 1. Subscribe to lib/call.js events (incoming / state / ended / rehydrate).
  _callUnsub = callSub(handleCallEvent);

  // 2. Subscribe to state changes — re-render active panel and tear down on logout.
  _attachStateListener(() => {
    if (!state.profile) {
      unmountCallManager();
      try { _incomingCall = null; renderIncoming(); renderActive(); } catch {}
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
        onCallsInsert)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls' },
        onCallsUpdate)
    .subscribe((status) => {
      if (status === 'SUBSCRIBED') console.info('[chc-call-manager] SUBSCRIBED');
      else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        console.warn('[chc-call-manager] channel status', status);
      }
    });

  // 4. Authoritative server read: pick up a still-active row after refresh.
  pollActive().catch(() => {});

  // 5. Render whatever we have (likely nothing on fresh mount).
  renderIncoming();
  renderActive();
}

// Subscribe to the global state pubsub exactly once. The returned handle
// overwrites any prior _stateUnsub so we never accumulate listeners.
function _attachStateListener(handler) {
  if (_stateUnsub) { try { _stateUnsub(); } catch {} _stateUnsub = null; }
  // Lazy import avoids a circular reference at module-eval time.
  import('./state.js').then(({ subscribe }) => {
    _stateUnsub = subscribe((topic) => handler(topic));
  }).catch(() => {});
}

export function unmountCallManager() {
  if (!mounted) return;
  mounted = false;
  try { _pgChannel && sb.removeChannel(_pgChannel); } catch {}
  try { _callUnsub && _callUnsub(); } catch {}
  try { _stateUnsub && _stateUnsub(); } catch {}
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
  if (ev.type === 'incoming') {
    _incomingCall = {
      id: ev.call.callId,
      callerId: ev.call.otherId,
      kind: ev.call.kind
    };
    renderIncoming();
    playRingtone();
    armIncomingExpiry();
  } else if (ev.type === 'state' || ev.type === 'local-stream' || ev.type === 'remote-track') {
    // Stop ringtone as soon as call moves past ringing (either side).
    if (ev.call && ev.call.state !== 'ringing' && ev.call.state !== 'calling') {
      stopRingtone();
    }
    renderActive();
  } else if (ev.type === 'ended') {
    _incomingCall = null;
    stopRingtone();
    clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
    renderIncoming();
    renderActive();
  } else if (ev.type === 'rehydrate') {
    // After refresh, the row exists but WebRTC is gone. Surface a minimal
    // active-call panel so the user can hang up cleanly.
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
}

// ----- incoming modal (floating) -----
function renderIncoming() {
  const old = document.getElementById('call-incoming-modal');
  if (old) old.remove();
  if (!_incomingCall) { stopRingtone(); return; }
  const other = state.profiles.get(_incomingCall.callerId) ||
                { id: _incomingCall.callerId, display_name: 'Unknown', avatar_color: '#888' };
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
            onclick: () => doAccept() }, ic('phone-call'), ' Accept'))));
  document.body.append(modal);
}

async function doAccept() {
  if (!_incomingCall) return;
  const callId = _incomingCall.id;
  _incomingCall = null;
  renderIncoming();
  stopRingtone();
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  try { await accept(); } catch (e) {
    toast(e.chc && e.chc.text || e.message || 'Accept failed', 'error');
  }
}

async function doDecline() {
  if (!_incomingCall) return;
  const callId = _incomingCall.id;
  _incomingCall = null;
  renderIncoming();
  stopRingtone();
  clearTimeout(_incomingExpiryTimer); _incomingExpiryTimer = null;
  try { await decline('declined'); } catch {}
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
  const remoteV = a.kind === 'video'
    ? el('video', { class: 'call-tile remote', autoplay: '', playsinline: '' }) : null;
  const localV = a.kind === 'video'
    ? el('video', { class: 'call-tile local', autoplay: '', muted: '', playsinline: '' }) : null;
  const avatarBig = (!minimized && a.kind === 'voice') ? avatar(other, { size: 'xl' }) : null;

  const micBtn = el('button',
    { class: `call-ctrl${isMicOn() ? '' : ' muted'}`, title: isMicOn() ? 'Mute mic' : 'Unmute mic',
      'aria-label': isMicOn() ? 'Mute mic' : 'Unmute mic',
      onclick: () => { toggleMic(); renderActive(); } },
    ic(isMicOn() ? 'microphone' : 'microphone-slash'));
  const camBtn = a.kind === 'video' ? el('button',
    { class: `call-ctrl${isCamOn() ? '' : ' muted'}`, title: isCamOn() ? 'Camera off' : 'Camera on',
      'aria-label': isCamOn() ? 'Camera off' : 'Camera on',
      onclick: () => { toggleCam(); renderActive(); } },
    ic(isCamOn() ? 'video-camera' : 'video-slash')) : null;
  const hangupBtn = el('button',
    { class: 'call-ctrl danger', title: 'Hang up', 'aria-label': 'Hang up',
      onclick: () => hangup() },
    ic('phone-slash'));
  const minimizeBtn = el('button',
    { class: 'call-ctrl ctrl-minimize', title: minimized ? 'Expand' : 'Minimize',
      'aria-label': minimized ? 'Expand' : 'Minimize',
      onclick: (e) => { e.stopPropagation(); toggleMinimize(); } },
    ic(minimized ? 'arrow-up-right-and-arrow-down-left-from-center' : 'arrow-down-right-and-arrow-up-left-from-center'));

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
    minimized ? null : el('div', { class: 'call-active-controls' },
      micBtn, camBtn, minimizeBtn, hangupBtn));

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
    try { panel.setPointerCapture && panel.setPointerCapture(pid); } catch {}
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
    try { panel.releasePointerCapture && panel.releasePointerCapture(pid); } catch {}
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
      } catch {}
    };
    beep();
    _ringtoneTimer = setInterval(beep, 1000);
  } catch {}
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