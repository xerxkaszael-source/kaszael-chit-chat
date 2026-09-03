// views/call.js — Call UI: incoming modal, active-call panel, call history.
// Brief §22-26 UX:
//   - Incoming call: fullscreen-style modal with Accept/Decline, caller name,
//     kind (voice/video), ringtone cue
//   - Active call: persistent panel with local + remote video tiles,
//     mic / cam / hangup controls
//   - History: chronological list with missed/declined/outgoing/incoming icons
//   - FLOATING BUBBLE (minimized): draggable, persists across views, with
//     mute/camera/hangup inline; tap bubble to restore.
//
// Authorization: RLS *** RPCs already enforce that only the two participants
// can see a given call. UI-side gates are belt-and-braces.
import { state, me, notify, subscribe as stateSub } from '../lib/state.js';
import {
  accept, decline, cancel, hangup, toggleMic, toggleCam,
  isMicOn, isCamOn, toggleMinimize, isMinimized, setPanelPosition,
  getElapsedSec, forceHangup, selfRecoverStale, callSelfRecover,
  history as fetchHistory, pollActive, getActive, subscribe as callSub,
  startNegotiation, initiate
} from '../lib/call.js';
import { el, ic, esc, relTime, fmtDuration, toast } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';
import { sb } from '../lib/db.js';

let viewEl = null;
let incoming = null;     // last incoming call (for re-render)
let rehydratedStale = null; // { call, stale } — for the "abandoned call" banner
let historyRows = [];
let panelEl = null;
let panelTimer = null;   // ticks the elapsed-seconds display
let _callSub = null;
let _stateSub = null;
let _callRowSub = null;  // pg subscription for call row updates
let _dragState = null;   // { startX, startY, origX, origY, el } for bubble drag

// --- SUBSCRIBE TO NEW CALLS REALTIME ---
// Watch the calls table for any row where I'm the callee + state=calling.
function ensureCallerSubscription() {
  if (_callRowSub) return;
  const uid = me()?.id;
  if (!uid) return;
  _callRowSub = sb.channel('call-incoming')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'calls', filter: `callee_id=eq.${uid}` },
        (payload) => {
          const c = payload?.new;
          if (!c || c.state !== 'calling') return;
          // Surface to UI
          incoming = { id: c.id, callerId: c.caller_id, kind: c.kind };
          renderIncoming();
          // Try to play a ringtone (will fail silently if no audio context yet)
          try {
            const AC = window.AudioContext || window.webkitAudioContext;
            if (AC) {
              const ctx = new AC();
              const osc = ctx.createOscillator();
              const g = ctx.createGain();
              osc.connect(g); g.connect(ctx.destination);
              osc.frequency.value = 440; g.gain.value = 0.1;
              osc.start(); osc.stop(ctx.currentTime + 0.3);
              setTimeout(() => osc.start() || osc.stop(ctx.currentTime + 0.3), 1000);
            }
          } catch {}
        })
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'calls' },
        (payload) => {
          const c = payload?.new;
          if (!c) return;
          // If our active call changed state, reflect it
          const a = getActive();
          if (a && a.callId === c.id) {
            a.state = c.state;
            renderActive();
            if (c.state === 'ended' || c.state === 'failed' || c.state === 'declined' ||
                c.state === 'missed' || c.state === 'cancelled') {
              toast(`Call ${c.state}`, 'info', 1500);
            }
            if (c.state === 'accepted' && a.role === 'caller') {
              startNegotiation().catch(e => toast(`Negotiation failed: ${e.message}`, 'error'));
            }
          }
          // Incoming modal: hide if the call got cancelled/declined
          if (incoming && incoming.id === c.id &&
              ['ended','cancelled','declined','missed','failed'].includes(c.state)) {
            incoming = null;
            renderIncoming();
          }
        })
    .subscribe();
}

function ensureStateSubs() {
  if (_callSub) return;
  _callSub = callSub((ev) => {
    if (ev.type === 'incoming') {
      incoming = { id: ev.call.callId, callerId: ev.call.otherId, kind: ev.call.kind };
      renderIncoming();
    } else if (ev.type === 'local-stream' || ev.type === 'remote-track' || ev.type === 'state') {
      renderActive();
    } else if (ev.type === 'ended') {
      incoming = null;
      renderIncoming();
      renderActive();
    } else if (ev.type === 'rehydrate') {
      // After refresh, we have an active call row but no local WebRTC.
      // Surface a minimal "active call" entry so the UI is consistent.
      // If `stale=true`, also render a "looks abandoned — hang up?" banner.
      const c = ev.call || {};
      if (!incoming && c.caller_id && c.callee_id) {
        incoming = { id: c.id, callerId: c.caller_id, calleeId: c.callee_id, kind: c.kind, rehydrated: true };
      }
      rehydratedStale = ev.stale ? { call: c, stale: true } : null;
      renderActive();
      renderStaleBanner();
    }
  });
  _stateSub = stateSub(() => {
    // re-render active panel when state.profile changes (logout)
    if (!state.profile) { resetCallUI(); }
    renderActive();
  });
}

export async function renderCallView(mainEl, sub = 'inbox', callKind = null, calleeId = null) {
  // Clear the main area FIRST so navigating from /call/inbox → /call/history
  // (or any other route → /call/...) replaces the view instead of appending a
  // duplicate "Call history / Active / History / Loading…" stack. Previous
  // behavior left each rendered .call-view in the DOM, growing the page on
  // every navigation and showing multiple "Loading…" placeholders.
  mainEl.innerHTML = '';
  viewEl = el('div', { class: 'call-view' },
    el('div', { class: 'view-head' },
      el('h2', {}, sub === 'history' ? 'Call history' : 'Calls'),
      el('div', { class: 'head-tabs' },
        el('button', { class: `tab${sub === 'inbox' ? ' active' : ''}`, onclick: () => location.hash = '/call' }, 'Active'),
        el('button', { class: `tab${sub === 'history' ? ' active' : ''}`, onclick: () => location.hash = '/call/history' }, 'History')),
      el('div', { class: 'call-body', id: 'call-body' },
        el('div', { class: 'skeleton-row' }, 'Loading…'))));
  mainEl.append(viewEl);
  ensureStateSubs();
  ensureCallerSubscription();
  await pollActive();
  await refresh();
  // The active call panel is a separate floating element rendered in the
  // app shell so it stays visible across views.
  renderActive();

  // Auto-initiate when route is /call/audio/<userId> or /call/video/<userId>.
  // Skipped when there is already an active call to avoid duplicate notifications.
  if (callKind && calleeId && (callKind === 'voice' || callKind === 'video')) {
    try {
      if (!getActive()) {
        const r = await initiate(calleeId, callKind);
        if (r && r.ok) {
          toast((callKind === 'video' ? 'Video' : 'Voice') + ' call started', 'ok');
        }
      }
    } catch (e) {
      toast(e.chc && e.chc.text || 'Could not start call', 'error');
    }
  }
}

async function refresh() {
  const body = document.getElementById('call-body');
  if (!body) return;
  body.innerHTML = '';
  if (location.hash.includes('/call/history')) {
    await renderHistory(body);
  } else {
    renderActiveList(body);
  }
}

function renderActiveList(body) {
  const a = getActive();
  if (!a) {
    body.append(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, ic('phone-call')),
      el('h3', {}, 'No active call'),
      el('p', {}, 'Start a call from a friend\u2019s profile or DM.')));
    return;
  }
  body.append(el('div', { class: 'active-call-card' },
    avatar({ id: a.otherId, display_name: 'In call' }, { size: 'lg' }),
    el('div', { class: 'active-call-meta' },
      el('div', { class: 'active-call-state' }, a.state),
      el('div', { class: 'active-call-kind' }, a.kind)),
    el('div', { class: 'active-call-actions' },
      el('button', { class: 'btn danger', onclick: () => hangup() }, ic('phone-slash'), ' End'))));
}

async function renderHistory(body) {
  historyRows = [];
  try {
    const r = await fetchHistory(30);
    historyRows = r?.calls || [];
  } catch (e) {
    toast('Failed to load call history', 'error');
  }
  if (!historyRows.length) {
    body.append(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, ic('time-past')),
      el('h3', {}, 'No call history'),
      el('p', {}, 'Calls you make or receive will appear here.')));
    return;
  }
  for (const row of historyRows) body.append(historyRow(row));
}

function historyRow(c) {
  const direction = c.direction;
  const kindIcon = c.kind === 'video' ? 'video' : 'phone';
  const stateIcon = c.state === 'missed' ? 'phone-slash' :
                    c.state === 'declined' ? 'phone-slash' :
                    c.state === 'cancelled' ? 'circle-xmark' :
                    c.state === 'failed' ? 'triangle-exclamation' :
                    'phone';
  const isFailure = ['missed','declined','cancelled','failed'].includes(c.state);
  const user = c.other_user;
  return el('div', { class: `call-history-row state-${c.state}` },
    avatar(user || { id: c.other_user_id }, { size: 'sm' }),
    el('div', { class: 'call-history-meta' },
      el('div', { class: 'call-history-line1' },
        el('span', {}, user?.display_name || 'Unknown'),
        el('span', { class: 'call-history-dir' }, direction === 'incoming' ? 'incoming' : 'outgoing')),
      el('div', { class: 'call-history-line2' },
        el('span', { class: `call-state ${isFailure ? 'fail' : 'ok'}` }, ic(stateIcon), ' ', c.state),
        c.duration_sec > 0 ? el('span', { class: 'call-duration' }, ' · ', fmtDuration(c.duration_sec)) : null,
        el('span', { class: 'call-time' }, relTime(c.started_at)))));
}

// --- INCOMING CALL MODAL ---
function renderIncoming() {
  // remove existing
  const old = document.getElementById('call-incoming-modal');
  if (old) old.remove();
  if (!incoming) return;
  const other = state.profiles.get(incoming.callerId) ||
                { id: incoming.callerId, display_name: 'Unknown', avatar_color: '#888' };
  const modal = el('div', { id: 'call-incoming-modal', class: 'call-incoming-backdrop' },
    el('div', { class: 'call-incoming-card', role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'call-incoming-header' },
        el('span', { class: 'call-kind-badge' }, ic(incoming.kind === 'video' ? 'video' : 'phone'), ' ', incoming.kind, ' call'),
        el('h2', {}, 'Incoming call')),
      avatar(other, { size: 'xl' }),
      el('div', { class: 'call-incoming-name' }, other.display_name || other.username || 'Unknown'),
      el('div', { class: 'call-incoming-actions' },
        el('button', { class: 'btn danger large', onclick: () => doDecline() }, ic('phone-slash'), ' Decline'),
        el('button', { class: 'btn primary large', onclick: () => doAccept() }, ic('phone-call'), ' Accept'))));
  document.body.append(modal);
}

async function doAccept() {
  const callId = incoming?.id;
  if (!callId) return;
  incoming = null;
  renderIncoming();
  // Trigger the call module to accept
  await accept();
  // Switch to active view
  location.hash = '/call';
}

async function doDecline() {
  const callId = incoming?.id;
  if (!callId) return;
  incoming = null;
  renderIncoming();
  await decline();
}

// --- ACTIVE CALL FLOATING PANEL ---
// Always rendered into document.body so it persists across view changes.
// Two visual modes: full (default) and minimized (floating bubble).
function renderActive() {
  // Always tear down the existing panel before rebuilding — we want a single
  // source of truth and no leaked DOM nodes / video elements.
  const old = document.getElementById('call-active-panel');
  if (old) old.remove();
  stopPanelTimer();
  const a = getActive();
  if (!a) { panelEl = null; return; }
  panelEl = buildActivePanel(a);
  document.body.append(panelEl);
  // Wire streams into the <video> tiles after the DOM is mounted.
  attachStreamsToPanel(panelEl, a);
  startPanelTimer(panelEl);
}

function buildActivePanel(a) {
  const other = state.profiles.get(a.otherId) ||
                { id: a.otherId, display_name: 'In call', avatar_color: '#888' };
  const minimized = !!a.minimized;
  // Local + remote <video> tiles (only for video calls).
  const remoteV = a.kind === 'video' ? el('video', { class: 'call-tile remote', autoplay: '', playsinline: '' }) : null;
  const localV = a.kind === 'video' ? el('video', { class: 'call-tile local', autoplay: '', muted: '', playsinline: '' }) : null;
  const avatarBig = (!minimized && a.kind === 'voice') ? avatar(other, { size: 'xl' }) : null;

  // Always-visible controls on the full panel + bubble row
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

  // Bubble row: avatar + name + duration + tiny mic/hangup controls.
  // Visible when minimized OR as a compact mode on the full panel header.
  const bubbleRow = el('div', { class: 'call-active-bubble-row' },
    avatar(other, { size: 'sm', showPresence: false }),
    el('div', { class: 'cab-name' }, other.display_name || 'In call'),
    el('div', { class: 'cab-time' }, fmtDuration(getElapsedSec())),
    el('button', { class: 'ctrl-mute', title: isMicOn() ? 'Mute' : 'Unmute', 'aria-label': 'Toggle microphone',
      onclick: (e) => { e.stopPropagation(); toggleMic(); renderActive(); } },
      ic(isMicOn() ? 'microphone' : 'microphone-slash')),
    camBtn && a.kind === 'video' ? el('button',
      { class: 'ctrl-cam', title: isCamOn() ? 'Camera off' : 'Camera on', 'aria-label': 'Toggle camera',
        onclick: (e) => { e.stopPropagation(); toggleCam(); renderActive(); } },
      ic(isCamOn() ? 'video' : 'video-slash')) : null,
    el('button', { class: 'ctrl-hangup', title: 'Hang up', 'aria-label': 'Hang up',
      onclick: (e) => { e.stopPropagation(); hangup(); } },
      ic('phone-slash')));

  const panel = el('div',
    { id: 'call-active-panel', class: `call-active-panel${minimized ? ' minimized' : ''}`,
      role: 'dialog', 'aria-label': a.kind === 'video' ? 'Video call' : 'Voice call' },
    // Top row always shows bubble (avatar + name + duration + tiny controls)
    bubbleRow,
    // Full-mode-only: tiles, big avatar, full controls
    minimized ? null : el('div', { class: 'call-active-tiles' }, remoteV, localV),
    minimized ? null : avatarBig,
    minimized ? null : el('div', { class: 'call-active-name' }, other.display_name || 'In call'),
    minimized ? null : el('div', { class: 'call-active-state' }, a.state),
    minimized ? null : el('div', { class: 'call-active-controls' },
      micBtn, camBtn, minimizeBtn, hangupBtn));

  // Click-to-restore when minimized. Drag when minimized (the bubble is
  // draggable so users can move it out of the way of chat content).
  if (minimized) {
    panel.addEventListener('click', (e) => {
      if (_dragState && _dragState.dragged) { _dragState = null; return; }
      if (e.target.closest('button')) return; // ignore button clicks inside bubble
      toggleMinimize();
    });
    enableDrag(panel);
  }
  // Restore stored position if any
  if (a.position && typeof a.position.x === 'number') {
    positionPanel(panel, a.position);
  }
  return panel;
}

function attachStreamsToPanel(panel, a) {
  // We have to wait for the DOM nodes to actually exist before assigning
  // srcObject — even a single tick is enough, but a rAF is safer.
  const apply = () => {
    if (!panel || !panel.isConnected) return;
    const lv = panel.querySelector('.call-tile.local');
    if (lv && a.localStream) {
      if (lv.srcObject !== a.localStream) lv.srcObject = a.localStream;
    }
    const rv = panel.querySelector('.call-tile.remote');
    if (rv && a.remoteStream && a.remoteStream.getTracks().length) {
      if (rv.srcObject !== a.remoteStream) rv.srcObject = a.remoteStream;
    }
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(apply);
  else setTimeout(apply, 0);
  // And once more after a delay to catch ICE-track-arrival race (remote
  // stream gets its first track via the 'track' event AFTER the panel is built).
  setTimeout(apply, 500);
}

function startPanelTimer(panel) {
  stopPanelTimer();
  panelTimer = setInterval(() => {
    const p = document.getElementById('call-active-panel');
    if (!p) { stopPanelTimer(); return; }
    const t = p.querySelector('.cab-time');
    if (t) t.textContent = fmtDuration(getElapsedSec());
    // Also refresh mute/cam icons in case the lib flipped them.
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
function stopPanelTimer() {
  if (panelTimer) { clearInterval(panelTimer); panelTimer = null; }
}

function enableDrag(panel) {
  let pid = null;
  const onDown = (e) => {
    // Only left mouse / single touch / no modifier keys.
    if (e.button !== undefined && e.button !== 0) return;
    pid = e.pointerId != null ? e.pointerId : 'mouse';
    const rect = panel.getBoundingClientRect();
    // Switch to absolute positioning the moment we start dragging so we
    // don't fight the fixed bottom/right anchors.
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

// Public: force-cleanup on logout / hard reset.
export function resetCallUI() {
  forceHangup();
  const old = document.getElementById('call-active-panel');
  if (old) old.remove();
  panelEl = null;
  stopPanelTimer();
  incoming = null;
  rehydratedStale = null;
  const sb2 = document.getElementById('call-stale-banner');
  if (sb2) sb2.remove();
}

// "Stale call" banner — shows when pollActive() finds an active call row
// older than 60s (calling/ringing) or 120s (reconnecting). Gives the user
// a way to clean it up immediately so the next call they try succeeds.
function renderStaleBanner() {
  const old = document.getElementById('call-stale-banner');
  if (old) old.remove();
  if (!rehydratedStale || !rehydratedStale.call) return;
  const c = rehydratedStale.call;
  const otherId = c.caller_id === (state.profile && state.profile.id) ? c.callee_id : c.caller_id;
  const other = state.profiles.get(otherId) || { id: otherId, display_name: 'someone', username: '' };
  const ageMs = Date.now() - new Date(c.started_at).getTime();
  const ageMin = Math.round(ageMs / 60_000);
  const banner = el('div', { id: 'call-stale-banner', class: 'call-stale-banner', role: 'alert' },
    el('div', { class: 'csb-icon' }, ic('triangle-warning')),
    el('div', { class: 'csb-body' },
      el('div', { class: 'csb-title' }, `Previous ${c.kind || 'call'} looks abandoned`),
      el('div', { class: 'csb-sub' }, `With ${other.display_name || other.username || 'someone'} · ${ageMin}m ago in '${c.state}' state. Hang up to clear it and call again.`)),
    el('button', { class: 'btn sm danger', onclick: async () => {
      const r = await callSelfRecover(c.id, 'user_dismissed_stale');
      toast(r ? 'Stale call cleared.' : 'Could not clear — try again.', r ? 'ok' : 'error');
      rehydratedStale = null;
      renderStaleBanner();
      renderActive();
    } }, ic('trash'), ' Clear stale call'),
    el('button', { class: 'icon-btn', 'aria-label': 'Dismiss', title: 'Dismiss',
      onclick: () => { rehydratedStale = null; renderStaleBanner(); } },
      ic('cross')));
  document.body.append(banner);
}