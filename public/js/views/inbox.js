// views/inbox.js — DM inbox view (conversation list).
// Mounted into mainEl when route is 'inbox'.
import { loadInbox } from '../lib/dm.js';
import { state, me } from '../lib/state.js';
import { el, ic, esc, relTime, initials } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';
import { openDm } from './dm.js';
import { toast } from '../lib/util.js';

let inboxEl = null;

export async function renderInbox(mainEl) {
  inboxEl = el('div', { class: 'inbox-view' },
    el('div', { class: 'view-head' },
      el('h2', {}, 'Inbox'),
      el('p', { class: 'view-sub' }, 'Your private conversations')),
    el('div', { class: 'inbox-body', id: 'inbox-body' },
      el('div', { class: 'skeleton-row' }, 'Loading…')));
  mainEl.append(inboxEl);
  try {
    const convs = await loadInbox();
    drawInbox(convs);
  } catch (e) {
    console.error('[chc] inbox load failed', e);
    const body = document.getElementById('inbox-body');
    if (body) {
      body.innerHTML = '';
      body.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, ic('envelope')),
        el('h3', {}, 'Could not load inbox'),
        el('p', {}, 'Try refreshing the page.')));
    }
    toast('Failed to load inbox', 'error');
  }
}

function drawInbox(convs) {
  const body = document.getElementById('inbox-body');
  if (!body) return;
  body.innerHTML = '';

  if (!convs || convs.length === 0) {
    body.append(el('div', { class: 'empty-state' },
      el('div', { class: 'empty-icon' }, ic('envelope')),
      el('h3', {}, 'No conversations yet'),
      el('p', {}, 'Open a friend\'s profile and tap "Message" to start a chat.')));
    return;
  }

  // pinned first
  convs.sort((a, b) => {
    if (a.pinned && !b.pinned) return -1;
    if (b.pinned && !a.pinned) return 1;
    const ta = new Date(a.last_message_at || 0).getTime();
    const tb = new Date(b.last_message_at || 0).getTime();
    return tb - ta;
  });

  for (const c of convs) body.append(inboxRow(c));
}

function inboxRow(c) {
  const preview = c.last_message_preview || '(no messages yet)';
  const unread = c.unread_count || 0;
  const muted = c.muted;
  const archived = c.archived;
  const lastAt = c.last_message_at ? relTime(c.last_message_at) : '';
  // Other member data may be missing if they left/were deleted; migration 023
  // now returns user info even for left members, but we still defend.
  const otherId = c.other_user_id || null;
  const otherName = c.other_display_name || c.other_username || (otherId ? '(unknown)' : '(deleted)');
  const otherLeft = !!c.other_left;
  // Visual hint when the other side has left — chat is read-only on their end.
  // dm_send already enforces this server-side (returns 'not_member'/'invalid_conversation').
  const leftTag = otherLeft ? el('span', { class: 'inbox-left-tag', title: 'This person left the chat' }, '(left)') : null;

  const row = el('button', {
    class: `inbox-row${unread > 0 ? ' unread' : ''}${muted ? ' muted' : ''}${archived ? ' archived' : ''}${otherLeft ? ' left' : ''}`,
    // Disable click if we have no other_user_id at all (member row was hard-deleted)
    onclick: otherId ? () => openDm(c.conversation_id, otherId) : null
  },
    avatar({ id: otherId, username: c.other_username, display_name: c.other_display_name, avatar_color: c.other_avatar_color }, { size: 'md', showPresence: !otherLeft }),
    el('div', { class: 'inbox-meta' },
      el('div', { class: 'inbox-line1' },
        el('span', { class: 'inbox-name' }, otherName),
        leftTag,
        el('span', { class: 'inbox-time' }, lastAt)),
      el('div', { class: 'inbox-line2' },
        el('span', { class: 'inbox-preview' }, preview),
        unread > 0 ? el('span', { class: 'inbox-unun' }, String(unread > 99 ? '99+' : unread)) : null,
        muted ? ic('volume-mute', 'inbox-mute-icon') : null,
        c.pinned ? ic('thumbtack', 'inbox-pin-icon') : null)));

  return row;
}