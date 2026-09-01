// main.js — boot, router, session bootstrap
import { sb } from './lib/db.js';
import { state, subscribe, notify, isOwner } from './lib/state.js';
import { applyTheme, watchSystemTheme } from './lib/themes.js';
import { installAudioUnlock } from './lib/sound.js';
import { startRealtime, stopRealtime } from './lib/realtime.js';
import { rpc } from './lib/db.js';
import { renderAuth } from './views/auth.js';
import { renderShell } from './views/shell.js';
import { renderAdmin } from './views/admin.js';
import { toast, el, ic } from './lib/util.js';

applyTheme();
watchSystemTheme();
installAudioUnlock();

const ROOT = document.getElementById('app');

// ---------- session bootstrap ----------
async function boot() {
  const { data: { session } } = await sb.auth.getSession();
  state.session = session;
  if (session) {
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
      try { state.settings = await loadSettings(); } catch { state.settings = null; }
    }
    return true;
  } catch {
    return false;
  }
}

async function loadSettings() {
  const { data } = await sb.from('user_settings').select('*').eq('user_id', state.profile.id).maybeSingle();
  return data;
}

async function onAuthed() {
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
  try {
    await startRealtime();
  } catch (e) {
    console.error('[chc] realtime start failed', e);
  }
  if (state.flags.kicked) notify('kicked-banned');
  route();
}

// ---------- router ----------
export function navigate(hash) { location.hash = hash; }

function route() {
  const h = location.hash.replace(/^#\/?/, '') || 'chat';
  const [view] = h.split('/');
  notify('route');
  const adminViews = new Set(['admin', 'moderation', 'broadcast', 'audit', 'system', 'owner']);
  if (adminViews.has(view)) {
    if (!state.profile || state.isGuest || !(isOwner() || ['admin', 'moderation', 'broadcast'].includes(view) && state.profile)) {
      navigate('/chat'); return;
    }
    renderAdmin(ROOT, view);
    return;
  }
  renderShell(ROOT, view);
}

window.addEventListener('hashchange', route);
subscribe((topic) => {
  if (topic === 'kicked-banned') {
    // heartbeat told us we're kicked/banned → force back to auth
    stopRealtime();
    entered = false;
    sb.auth.signOut().finally(() => location.reload());
  }
});

window.addEventListener('beforeunload', () => { try { stopRealtime(); } catch {} });

boot().catch((e) => {
  console.error('[chc] boot failed', e);
  ROOT.innerHTML = '';
  ROOT.append(el('div', { class: 'auth-screen' },
    el('div', { class: 'auth-card' },
      el('h1', {}, 'Connection problem'),
      el('p', { class: 'sub', style: 'margin:10px 0' }, 'Could not reach the server. Check your connection and retry.'),
      el('button', { class: 'btn primary full', onclick: () => location.reload() }, ic('rotate-right'), 'Retry'))));
});
