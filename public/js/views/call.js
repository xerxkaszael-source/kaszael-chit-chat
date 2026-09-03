// views/call.js — Call history list view + /call/voice|video/<uid> auto-initiate.
//
// Realtime listening, incoming-call UI, and floating active-call bubble are
// owned by lib/call-manager.js (mounted once at app boot, survives view
// changes). This view is responsible for:
//   1. Showing the "Calls" inbox tab (Active call summary card if any)
//   2. Showing the "Call history" chronological list
//   3. Auto-initiating a call when the route is /call/voice/<uid> or
//      /call/video/<uid> (used by the DM header Call buttons).
//
// Authorization: RLS + SECURITY DEFINER RPCs already enforce that only the two
// participants can see a given call. UI-side gates are belt-and-braces.
import { state, me } from '../lib/state.js';
import {
  history as fetchHistory, initiate, getActive
} from '../lib/call.js';
import { ensureCallManager } from '../lib/call-manager.js';
import { el, ic, relTime, fmtDuration, toast } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';

let viewEl = null;
let historyRows = [];

// Belt-and-braces: if the manager hasn't mounted yet (route hit before
// enterApp finished), mount it now. mountCallManager is idempotent.
function ensureManager() {
  try { ensureCallManager(); } catch {}
}

export async function renderCallView(mainEl, sub = 'inbox', callKind = null, calleeId = null) {
  // Clear the main area FIRST so navigating from /call/inbox → /call/history
  // (or any other route → /call/...) replaces the view instead of appending a
  // duplicate "Call history / Active / History / Loading…" stack.
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
  ensureManager();
  await refresh();

  // Auto-initiate when route is /call/voice/<userId> or /call/video/<userId>.
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
      el('button', { class: 'btn danger', onclick: () => import('../lib/call.js').then(({ hangup }) => hangup()) }, ic('phone-slash'), ' End'))));
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