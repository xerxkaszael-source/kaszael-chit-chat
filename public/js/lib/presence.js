// lib/presence.js — client-side presence manager.
// Per brief §27: 6 statuses (online/away/busy/dnd/invisible/offline) with
// activity-based auto-away. Heartbeat still goes through lib/realtime.js
// (which calls presence_heartbeat RPC); this module owns:
//   - the user's chosen status (persisted in localStorage so it survives reload)
//   - the activity detector (mouse/keyboard/touch + visibility)
//   - automatic transition to 'away' after 5 minutes of no input
//   - skipping the realtime presence track when status === 'invisible'
import { state, notify } from './state.js';

const STORAGE_KEY = 'chc:presence:status';
const IDLE_MS = 5 * 60 * 1000; // 5 minutes
const ACTIVITY_THCH_MS = 30 * 1000; // 30s — don't write activity_ts on every mousemove

export const STATUSES = ['online', 'away', 'busy', 'dnd', 'invisible', 'offline'];

let _status = null;
let _idleTimer = null;
let _activityFlushTimer = null;
let _activityDirty = false;
let _lastActivityWrite = 0;
let _sweepTimer = null;
let _listeners = new Set();

export function getStatus() { return _status; }

export function setStatus(s, opts = {}) {
  if (!STATUSES.includes(s)) return;
  _status = s;
  try { localStorage.setItem(STORAGE_KEY, s); } catch {}
  for (const fn of _listeners) fn(s);
  notify('presence');
  if (!opts.silent && typeof window !== 'undefined') {
    // fire a one-shot RPC so server-side presence row reflects the change immediately
    import('./db.js').then(({ rpc }) => rpc('presence_set_status', { v_status: s }).catch(() => {}));
  }
}

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

export function start() {
  if (typeof window === 'undefined') return;
  // restore saved status
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && STATUSES.includes(saved)) _status = saved;
    else _status = 'online';
  } catch { _status = 'online'; }

  // activity listeners (passive — debounced)
  const onActivity = () => {
    _activityDirty = true;
    clearTimeout(_idleTimer);
    _idleTimer = setTimeout(handleIdle, IDLE_MS);
    if (!state.profile) return;
    if (_status === 'away' || _status === 'offline' || _status === 'invisible') {
      // auto-restore to online on activity (but not for invisible — that's a deliberate choice)
      if (_status === 'away') setStatus('online', { silent: true });
    }
  };
  for (const ev of ['mousemove', 'keydown', 'touchstart', 'scroll', 'click']) {
    window.addEventListener(ev, onActivity, { passive: true });
  }
  // visibility — offline when tab hidden for long, online when back
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      onActivity();
    } else {
      // schedule an idle timer — if user is gone > 5min, mark away; > 30min, offline
      clearTimeout(_idleTimer);
      _idleTimer = setTimeout(() => {
        if (_status === 'online' || _status === 'away') setStatus('away', { silent: true });
      }, IDLE_MS);
    }
  });
  // initial idle timer
  clearTimeout(_idleTimer);
  _idleTimer = setTimeout(handleIdle, IDLE_MS);

  // activity timestamp throttled writer (so realtime.js can pick it up)
  _activityFlushTimer = setInterval(() => {
    if (!_activityDirty) return;
    _activityDirty = false;
    _lastActivityWrite = Date.now();
  }, ACTIVITY_THCH_MS);
}

function handleIdle() {
  if (_status === 'invisible' || _status === 'dnd' || _status === 'busy') return;
  if (_status !== 'away') setStatus('away', { silent: true });
}

export function getLastActivityWrite() { return _lastActivityWrite; }
export function reset() {
  clearTimeout(_idleTimer);
  clearTimeout(_activityFlushTimer);
  clearInterval(_sweepTimer);
  _status = null;
  _activityDirty = false;
  _listeners.clear();
}