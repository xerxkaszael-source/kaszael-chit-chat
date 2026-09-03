// shell.js — app frame: topbar, sidebar (nav + online/offline member lists), main view
import { sb, rpc, from, GENERAL_ROOM } from '../lib/db.js';
import { state, subscribe, notify, me, canModerate, canAdmin, isOwner, isMemberPlus, profileOf } from '../lib/state.js';
import { el, ic, icBtn, toast, relTime, esc } from '../lib/util.js';
import { avatar, badge } from '../lib/avatar.js';
import { renderChat } from './chat.js';
import { renderInbox } from './inbox.js';
import { openDm } from './dm.js';
import { openFriends, openNotifications, openPins, openSearch, openSettings, openProfile, openThemePicker } from './panels.js';
import { setSoundEnabled } from '../lib/sound.js';

let shellEl = null, sidebarEl = null, mainEl = null, connPill = null;
let memberOnlineEl = null, memberOfflineEl = null;
let notifBadgeEl = null;

export function renderShell(root, view = 'chat') {
  // keep shell mounted; only swap the main area
  if (!shellEl || !root.contains(shellEl)) {
    root.innerHTML = '';
    shellEl = buildShell();
    root.append(shellEl);
    loadStaticData();
    subscribe(onStateChange);
  }
  mainEl.innerHTML = '';
  if (view === 'friends') openFriendsInline();
  else if (view === 'inbox') renderInbox(mainEl);
  else if (view === 'dm') { /* dm.js handles its own mount via openDm */ }
  else renderChat(mainEl);
  syncNav(view);
}

function buildShell() {
  sidebarEl = el('aside', { class: 'sidebar', 'aria-label': 'Navigation' });
  mainEl = el('main', { class: 'main' });
  connPill = el('span', { class: 'conn-pill' }, el('span', { class: 'led' }), el('span', { class: 'cp-text' }, 'connecting'));

  const topbar = el('header', { class: 'topbar' },
    icBtn('burger-menu', 'Menu', () => sidebarEl.classList.toggle('mobile-open')),
    el('div', { class: 'brand' },
      el('span', { class: 'brand-mark' }, ic('comment')),
      el('span', {}, 'Chit&Chat')),
    el('div', { style: 'margin-left:6px' },
      el('div', { class: 'room-title' }, 'General'),
      el('div', { class: 'room-sub', id: 'room-sub' }, 'the one room where everyone gathers')),
    el('div', { class: 'topbar-spacer' }),
    connPill,
    icBtn('magnifying-glass', 'Search messages', () => openSearch()),
    notifBtn(),
    icBtn('users', 'Friends', () => openFriends()),
    icBtn('thumbtack', 'Pinned', () => openPins()),
    icBtn('swatchbook', 'Theme', () => openThemePicker()),
    icBtn('settings', 'Settings', () => openSettings()),
    meAvatarBtn());

  drawSidebar();

  return el('div', { class: 'app' },
    topbar,
    el('div', { class: 'app-body' }, sidebarEl, mainEl));
}

function notifBtn() {
  const b = icBtn('bell', 'Notifications', () => openNotifications());
  notifBadgeEl = el('span', { class: 'count-badge hidden' }, '0');
  b.append(notifBadgeEl);
  return b;
}

function meAvatarBtn() {
  const b = el('button', { class: 'icon-btn', 'aria-label': 'My profile', onclick: () => openProfile(me().id) });
  b.append(avatar(me(), { size: 'sm' }));
  return b;
}

// ---------- sidebar: nav + ONLINE / OFFLINE member lists ----------
function drawSidebar() {
  sidebarEl.innerHTML = '';
  const nav = el('nav', { class: 'side-nav' },
    sideItem('comment', 'Chat', () => { location.hash = '/chat'; closeMobile(); }),
    sideItem('users', 'Friends', () => openFriends()),
    sideItem('envelope', 'Inbox', () => { location.hash = '/inbox'; closeMobile(); }, () => state.dmUnreadTotal),
    sideItem('bell', 'Notifications', () => openNotifications(), () => state.unreadNotifs),
    sideItem('user', 'Profile', () => openProfile(me().id)),
    sideItem('settings', 'Settings', () => openSettings()),
    sideItem('swatchbook', 'Theme', () => openThemePicker()));

  if (canModerate()) {
    nav.append(el('div', { class: 'side-section-title' }, 'Staff'));
    nav.append(sideItem('gavel', 'Moderation', () => { location.hash = '/moderation'; }));
  }
  if (canAdmin()) {
    nav.append(sideItem('megaphone', 'Broadcast', () => { location.hash = '/broadcast'; }));
    nav.append(sideItem('chart-mixed', 'Admin', () => { location.hash = '/admin'; }));
    nav.append(sideItem('list-check', 'Audit', () => { location.hash = '/audit'; }));
  }
  if (isOwner()) {
    nav.append(sideItem('crown', 'Owner Center', () => { location.hash = '/owner'; }));
    nav.append(sideItem('triangle-warning', 'System', () => { location.hash = '/system'; }));
  }
  if (state.isGuest) {
    nav.append(el('div', { class: 'side-section-title' }, 'Guest session'));
    nav.append(sideItem('exit', 'Leave & erase guest data', async () => {
      try { await rpc('guest_leave'); } catch {}
      await sb.auth.signOut();
      location.hash = ''; location.reload();
    }));
  } else {
    nav.append(el('div', { class: 'side-section-title' }, ''));
    nav.append(sideItem('exit', 'Sign out', async () => {
      await sb.auth.signOut();
      location.hash = ''; location.reload();
    }));
  }

  memberOnlineEl = el('div', {});
  memberOfflineEl = el('div', {});
  const lists = el('div', { class: 'member-lists' },
    el('div', { class: 'side-section-title', id: 'online-title' }, 'Online — 0'),
    memberOnlineEl,
    el('div', { class: 'side-section-title', id: 'offline-title' }, 'Offline — 0'),
    memberOfflineEl);

  sidebarEl.append(nav, lists);
  renderMemberLists();
}

function sideItem(iconName, label, onclick, countFn) {
  const item = el('button', { class: 'side-item', onclick }, ic(iconName), el('span', {}, label));
  if (countFn) {
    const c = el('span', { class: 'count hidden' }, '0');
    item.append(c);
    item._countFn = countFn; item._countEl = c;
  }
  return item;
}

function syncNav(view) {
  sidebarEl.querySelectorAll('.side-item').forEach(i => i.classList.remove('active'));
  // refresh badges
  sidebarEl.querySelectorAll('.side-item').forEach(item => {
    if (item._countFn) {
      const n = item._countFn();
      item._countEl.textContent = n > 99 ? '99+' : String(n);
      item._countEl.classList.toggle('hidden', n === 0);
    }
  });
}

function closeMobile() { sidebarEl.classList.remove('mobile-open'); }

// ---------- member lists (online / offline split, moves live) ----------
let allRegistered = [];
export async function loadStaticData() {
  try {
    const [{ data: profs }, { data: pres }] = await Promise.all([
      from('profiles').select('*').eq('is_guest', false),
      from('presence').select('*')
    ]);
    allRegistered = profs || [];
    for (const p of profs || []) state.profiles.set(p.id, p);
    state.presence.clear();
    for (const pr of pres || []) state.presence.set(pr.user_id, pr);
    renderMemberLists();
    // guest profiles for chat display
    const { data: guests } = await from('profiles').select('*').eq('is_guest', true);
    for (const g of guests || []) state.profiles.set(g.id, g);
  } catch (e) {
    console.error('[chc] loadStaticData', e);
  }
}

export function renderMemberLists() {
  if (!memberOnlineEl) return;
  memberOnlineEl.innerHTML = '';
  memberOfflineEl.innerHTML = '';
  const online = [], offline = [];
  for (const p of allRegistered) {
    const pr = state.presence.get(p.id);
    (pr && pr.state !== 'offline' ? online : offline).push(p);
  }
  online.sort((a, b) => a.username.localeCompare(b.username));
  offline.sort((a, b) => a.username.localeCompare(b.username));
  document.getElementById('online-title')?.replaceChildren(`Online — ${online.length}`);
  document.getElementById('offline-title')?.replaceChildren(`Offline — ${offline.length}`);
  for (const p of online) memberOnlineEl.append(memberRow(p, true));
  for (const p of offline) memberOfflineEl.append(memberRow(p, false));
}

function memberRow(p, isOnline) {
  return el('button', { class: 'member-row', onclick: () => openProfile(p.id) },
    avatar(p, { size: 'sm', showPresence: true }),
    el('span', { class: 'm-name' }, p.display_name),
    badge(p.role),
    el('span', { class: 'm-state' }, isOnline ? '' : relTime(state.presence.get(p.id)?.last_seen || p.created_at)));
}

// ---------- react to state changes ----------
function onStateChange(topic) {
  if (topic === 'presence') renderMemberLists();
  if (topic === 'conn') {
    connPill.className = `conn-pill ${state.connState}`;
    connPill.querySelector('.cp-text').textContent =
      state.connState === 'online' ? 'connected' : state.connState === 'offline' ? 'connection lost' : 'reconnecting…';
  }
  if (topic === 'unread') {
    notifBadgeEl.classList.toggle('hidden', state.unreadNotifs === 0);
    notifBadgeEl.textContent = state.unreadNotifs > 99 ? '99+' : String(state.unreadNotifs);
  }
}

function openFriendsInline() { openFriends(); renderChat(mainEl); }
