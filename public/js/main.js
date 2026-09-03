// main.js — boot, router, session bootstrap
import { sb } from './lib/db.js';
import { state, subscribe, notify, isOwner } from './lib/state.js';
import { applyTheme, watchSystemTheme } from './lib/themes.js';
import { installAudioUnlock } from './lib/sound.js';
import { startRealtime, stopRealtime } from './lib/realtime.js';
import { rpc } from './lib/db.js';
import { renderAuth } from './views/auth.js';
import { renderShell } from './views/shell.js';
import { openDm, cleanupDmRealtime } from './views/dm.js';
import { renderNotifications } from './views/notifications.js';
import { renderCallView } from './views/call.js';
import { mountCallManager, resetCallUI as resetCallManagerUI } from './lib/call-manager.js';
import { renderLocationSettings } from './views/location-settings.js';
import { renderAdmin } from './views/admin.js';
import { toast, el, ic } from './lib/util.js';
import { loadInbox } from './lib/dm.js';
import { refreshDmUnread } from './lib/notifications.js';
import { start as startPresence } from './lib/presence.js';
import { installUnloadCleanup, selfRecoverStale } from './lib/call.js';

applyTheme();
watchSystemTheme();
installAudioUnlock();
installUnloadCleanup();

const ROOT = document.getElementById('app');

// ---------- session bootstrap ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (session) {
    // Clean up stale call rows on app boot (covers refresh-after-crash case).
    // Safe no-op if no session or no stale rows.
    try { await selfRecoverStale(); } catch (e) {}
    const ok = await hydrateProfile();
    if (ok) { enterApp(); return; }
    // session exists but profile gone/invalid → sign out cleanly
    await sb.auth.signOut();
  }
  renderAuth(ROOT, onAuthed);
}

async function hydrateProfile() {
  try {
    const own = await rpc('profile_own');
    if (!own.profile) return false;
    state.profile = own.profile;
    state.flags = { muted: own.muted, banned: own.banned, kicked: own.kicked };
    state.isGuest = !!own.profile.is_guest;
    if (own.banned) {
      await sb.auth.signOut();
      toast('This account is banned.', 'error', 6000);
      return false;
    }
    if (!state.isGuest) {
      try { state.settings = await loadSettings(); } catch (e) { state.settings = null; }
    }
    return true;
  } catch (e) {
    return false;
  }
}

async function loadSettings() {
  const { data } = await sb.from('user_settings').select('*').eq('user_id', state.profile.id).maybeSingle();
  return data;
}

async function onAuthed() {
  // First-thing: clean up any stale call rows this user might be stuck on
  // from a previous crashed tab / dropped network. This makes the busy
  // check in call_initiate pass on the very first attempt.
  try {
    const n = await selfRecoverStale();
    if (n > 0) toast(`Cleared ${n} stale call${n > 1 ? 's' : ''} from a previous session`, 'info', 3000);
  } catch (e) {}
  const ok = await hydrateProfile();
  if (!ok) { renderAuth(ROOT, onAuthed); return; }
  enterApp();
}

// ---------- app entry ----------
let entered = false;
async function enterApp() {
  if (entered) return;
  entered = true;
  ROOT.innerHTML = '';
  renderShell(ROOT);
  // Mount the GLOBAL call manager BEFORE presence/realtime so the
  // postgres_changes subscription on `calls` is active as soon as the user
  // is signed in. Incoming-call UI + floating active-call bubble are owned
  // by this module — they survive view changes (/chat, /dm, /owner/...,
  // /notifications) and only render into document.body.
  try { mountCallManager(); } catch (e) { console.error('[chc] call manager mount failed', e); }
  // Start presence manager BEFORE realtime so heartbeat picks up chosen status.
  startPresence();
  try {
    await startRealtime();
  } catch (e) {
    console.error('[chc] realtime start failed', e);
  }
  // Preload DM unread count in background (also drives the green-dot on inbox)
  loadInbox().then(convs => {
    state.dmInbox = convs || [];
    state.dmUnreadTotal = (convs || []).reduce((s, c) => s + (c.unread_count || 0), 0);
    notify('route'); // re-sync badges
    notify('inbox'); // also notify the new 'inbox' topic so the green-dot subscribes
  }).catch(() => {});
  if (state.flags.kicked) notify('kicked-banned');
  route();
}

// ---------- router ----------
export function navigate(hash) { location.hash = hash; }

function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'chat';
  const [view, ...rest] = h.split('/');
  notify('route');
  // cleanup any open DM realtime when leaving. Async — we await the read-mark
  // flush so the inbox badge reflects the new unread state immediately when
  // the user navigates back. (Previously sync → read-marks stuck in the
  // 1.5s debounce queue → inbox kept showing the old unread counter.)
  if (view !== 'dm') cleanupDmRealtime().catch(() => {});
  const adminViews = new Set(['admin', 'moderation', 'broadcast', 'audit', 'system', 'owner']);
  if (adminViews.has(view)) {
    if (!state.profile || state.isGuest || !(isOwner() || ['admin', 'moderation', 'broadcast'].includes(view) && state.profile)) {
      navigate('/chat'); return;
    }
    // rest[0] is the active sub-tab (e.g. /owner/chat keeps "Chat management" tab active).
    renderAdmin(ROOT, view, rest[0] || null);
    return;
  }
  if (view === 'dm' && rest[0]) {
    // /dm/<userId>
    openDm(rest[0]);
    return;
  }
  if (view === 'notifications') {
    renderNotifications(ROOT.querySelector('.main') || ROOT);
    return;
  }
  if (view === 'call') {
    // /call/<tab>             — call history/inbox (rest[0] = 'inbox'|'history')
    // /call/voice/<userId>    — initiate voice call to userId
    // /call/video/<userId>    — initiate video call to userId
    // /call/audio/<userId>    — legacy alias for /call/voice/<userId> (was
    //   sent by the DM header before the CHC:invalid_kind fix).
    let _sub = 'inbox', _kind = null, _callee = null;
    if (rest[0] === 'voice' || rest[0] === 'video' || rest[0] === 'audio') {
      // route is /call/<kind>/<userId> — no inbox/history tab. 'audio' is
      // coerced to 'voice' here so the DB's check (kind in ('voice','video'))
      // accepts it.
      _kind = rest[0] === 'audio' ? 'voice' : rest[0];
      _callee = rest[1] || null;
    } else {
      _sub = rest[0] || 'inbox';
    }
    renderCallView(ROOT.querySelector('.main') || ROOT, _sub, _kind, _callee);
    return;
  }
  if (view === 'location') {
    renderLocationSettings(ROOT.querySelector('.main') || ROOT);
    return;
  }
  renderShell(ROOT, view);
}

window.addEventListener('hashchange', route);
subscribe((topic) => {
  if (topic === 'kicked-banned') {
    // heartbeat told us we're kicked/banned → force back to auth
    stopRealtime();
    try { resetCallManagerUI(); } catch (e) {}
    entered = false;
    sb.auth.signOut().finally(() => location.reload());
  }
});

window.addEventListener('beforeunload', () => { try { stopRealtime(); } catch (e) {} });

boot().catch((e) => {
  console.error('[chc] boot failed', e);
  ROOT.innerHTML = '';
  ROOT.append(el('div', { class: 'auth-screen' },
    el('div', { class: 'auth-card' },
      el('h1', {}, 'Connection problem'),
      el('p', { class: 'sub', style: 'margin:10px 0' }, 'Could not reach the server. Check your connection and retry.'),
      el('button', { class: 'btn primary full', onclick: () => location.reload() }, ic('rotate-right'), 'Retry'))));
});
