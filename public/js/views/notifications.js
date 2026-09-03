// views/notifications.js — Notification Center view.
// Per brief §20: unread count, mark read, mark all read, realtime updates.
import { load, markRead, markAllRead } from '../lib/notifications.js';
import { state, me } from '../lib/state.js';
import { el, ic, esc, relTime, toast } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';

let viewEl = null;
let items = [];
let loading = false;

const KIND_LABEL = {
  friend_request: 'Friend request',
  friend_accepted: 'Friend accepted',
  mention: 'Mentioned you',
  moderation: 'Moderation',
  broadcast: 'Announcement',
  system: 'System',
  dm: 'Direct message',
  call: 'Call',
  // extended kinds (forward-compat)
  reply: 'Replied to you',
  reaction: 'Reacted',
  missed_call: 'Missed call',
  security: 'Security event'
};

const KIND_ICON = {
  friend_request: 'user-add',
  friend_accepted: 'user-check',
  mention: 'at',
  moderation: 'gavel',
  broadcast: 'bullhorn',
  system: 'info-circle',
  dm: 'envelope',
  call: 'phone',
  reply: 'reply',
  reaction: 'smile',
  missed_call: 'phone-slash',
  security: 'shield'
};

export async function renderNotifications(mainEl) {
  viewEl = el('div', { class: 'notif-view' },
    el('div', { class: 'view-head' },
      el('h2', {}, 'Notifications'),
      el('div', { class: 'head-actions' },
        el('button', { class: 'btn ghost', onclick: handleMarkAllRead }, 'Mark all read'))),
    el('div', { class: 'notif-body', id: 'notif-body' },
      el('div', { class: 'skeleton-row' }, 'Loading…')));
  mainEl.append(viewEl);
  await refresh();
}

export async function refresh() {
  if (loading || !viewEl) return;
  loading = true;
  try {
    items = await load(50);
    draw();
  } catch (e) {
    console.error('[chc] notifications load failed', e);
    const body = document.getElementById('notif-body');
    if (body) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, ic('bell')),
        el('h3', {}, 'Could not load notifications'),
        el('p', {}, 'Try refreshing the page.')));
    }
    toast('Failed to load notifications', 'error');
  } finally {
    loading = false;
  }
}

function draw() {
  const body = document.getElementById('notif-body');
  if (!body) return;
  body.innerHTML = '';
  if (!items.length) {
    body.append(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, ic('bell')),
      el('h3', {}, 'No notifications yet'),
      el('p', {}, 'You\u2019re all caught up.')));
    return;
  }
  for (const n of items) body.append(row(n));
}

function row(n) {
  const kind = n.kind || 'system';
  const label = KIND_LABEL[kind] || kind;
  const iconName = KIND_ICON[kind] || 'info-circle';
  const actor = n.actor || null;
  const body = describe(n, label, actor);
  const wrap = el('button', {
    class: `notif-row${n.read ? '' : ' unread'}`,
    onclick: () => handleRowClick(n)
  },
    el('div', { class: 'notif-icon' }, ic(iconName)),
    el('div', { class: 'notif-meta' },
      el('div', { class: 'notif-line1' }, body),
      el('div', { class: 'notif-time' }, relTime(n.created_at))),
    actor ? avatar(actor, { size: 'sm' }) : null);
  return wrap;
}

function describe(n, label, actor) {
  const who = actor?.display_name || actor?.username || '';
  switch (n.kind) {
    case 'friend_request': return el('span', {}, who, ' sent you a friend request');
    case 'friend_accepted': return el('span', {}, who, ' accepted your friend request');
    case 'mention': return el('span', {}, who, ' mentioned you');
    case 'dm': return el('span', {}, who, ' sent you a message');
    case 'reply': return el('span', {}, who, ' replied to you');
    case 'reaction': return el('span', {}, who, ' reacted to your message');
    case 'call': return el('span', {}, who, ' is calling');
    case 'missed_call': return el('span', {}, 'Missed call from ', who);
    case 'moderation': return el('span', {}, 'Moderation: ', n.payload?.reason || label);
    case 'broadcast': return el('span', {}, n.payload?.title || 'New announcement');
    case 'security': return el('span', {}, n.payload?.text || 'Security event');
    default: return el('span', {}, label, n.payload?.text ? ': ' + n.payload.text : '');
  }
}

async function handleRowClick(n) {
  if (!n.read) {
    try { await markRead(n.id); } catch (e) {}
    n.read = true;
    state.unreadNotifs = Math.max(0, (state.unreadNotifs || 1) - 1);
    draw();
  }
  // navigate to deep-link if payload carries one
  const link = n.payload?.link || n.payload?.href;
  if (link) location.hash = link;
}

async function handleMarkAllRead() {
  try {
    await markAllRead();
    for (const n of items) n.read = true;
    state.unreadNotifs = 0;
    draw();
    toast('All notifications marked as read', 'info', 1500);
  } catch (e) {
    toast(`Failed: ${e.message}`, 'error');
  }
}