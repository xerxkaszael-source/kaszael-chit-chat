// views/call.js — Call UI: incoming modal, active-call panel, call history.
// Brief §22-26 UX:
//   - Incoming call: fullscreen-style modal with Accept/Decline, caller name,
//     kind (voice/video), ringtone cue
//   - Active call: persistent panel with local + remote video tiles,
//     mic / cam / hangup controls
//   - History: chronological list with missed/declined/outgoing/incoming icons
//
// Authorization: RLS + RPCs already enforce that only the two participants
// can see a given call. UI-side gates are belt-and-braces.
import { state, me, notify, subscribe as stateSub } from '../lib/state.js';
import {
  accept, decline, cancel, hangup, toggleMic, toggleCam,
  history as fetchHistory, pollActive, getActive, subscribe as callSub,
  startNegotiation
} from '../lib/call.js';
import { el, ic, esc, relTime, fmtDuration, toast } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';
import { sb } from '../lib/db.js';

let viewEl = null;
let incoming = null;     // last incoming call (for re-render)
let historyRows = [];
let panelEl = null;
let _callSub = null;
let _stateSub = null;
let _callRowSub = null;  // pg subscription for call row updates

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
    }
  });
  _stateSub = stateSub(() => {
    // re-render active panel when state.profile changes (logout)
    renderActive();
  });
}

export async function renderCallView(mainEl, sub = 'inbox') {
  viewEl = el('div', { class: 'call-view' },
    el('div', { class: 'view-head' },
      el('h2', {}, sub === 'history' ? 'Call history' : 'Calls'),
      el('div', { class: 'head-tabs' },
        el('button', { class: `tab${sub === 'inbox' ? ' active' : ''}`, onclick: () => location.hash = '/call' }, 'Active'),
        el('button', { class: `tab${sub === 'history' ? ' active' : ''}`, onclick: () => location.hash = '/call/history' }, 'History'))),
    el('div', { class: 'call-body', id: 'call-body' },
      el('div', { class: 'skeleton-row' }, 'Loading…')));
  mainEl.append(viewEl);
  ensureStateSubs();
  ensureCallerSubscription();
  await pollActive();
  await refresh();
  // The active call panel is a separate floating element rendered in the
  // app shell so it stays visible across views.
  renderActive();
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
      el('div', { class: 'empty-icon' }, ic('phone')),
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
      el('div', { class: 'empty-icon' }, ic('clock-rotate-right')),
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
        el('button', { class: 'btn primary large', onclick: () => doAccept() }, ic('phone'), ' Accept'))));
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
function renderActive() {
  const old = document.getElementById('call-active-panel');
  if (old) old.remove();
  const a = getActive();
  if (!a) { panelEl = null; return; }
  const other = state.profiles.get(a.otherId) ||
                { id: a.otherId, display_name: 'In call', avatar_color: '#888' };
  const localV = a.kind === 'video' ? el('video', { class: 'call-tile local', autoplay: '', muted: '', playsinline: '' }) : null;
  const remoteV = a.kind === 'video' ? el('video', { class: 'call-tile remote', autoplay: '', playsinline: '' }) : null;
  const avatarBig = a.kind === 'voice' ? avatar(other, { size: 'xl' }) : null;
  // Attach streams when available
  setTimeout(() => {
    const lv = document.querySelector('#call-active-panel .call-tile.local');
    if (lv && a.localStream) { lv.srcObject = a.localStream; }
    const rv = document.querySelector('#call-active-panel .call-tile.remote');
    if (rv && a.remoteStream && a.remoteStream.getTracks().length) { rv.srcObject = a.remoteStream; }
  }, 0);
  panelEl = el('div', { id: 'call-active-panel', class: 'call-active-panel' },
    el('div', { class: 'call-active-tiles' }, remoteV, localV),
    avatarBig,
    el('div', { class: 'call-active-name' }, other.display_name || 'In call'),
    el('div', { class: 'call-active-state' }, a.state),
    el('div', { class: 'call-active-controls' },
      el('button', { class: 'call-ctrl', title: 'Toggle mic', onclick: () => toggleMic() }, ic('microphone')),
      a.kind === 'video' ? el('button', { class: 'call-ctrl', title: 'Toggle camera', onclick: () => toggleCam() }, ic('video')) : null,
      el('button', { class: 'call-ctrl danger', title: 'Hang up', onclick: () => hangup() }, ic('phone-slash'))));
  document.body.append(panelEl);
}