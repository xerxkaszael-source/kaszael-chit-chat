// lib/notifications.js — notification center data layer.
// Wraps the EXISTING RPCs in the project (from earlier sessions): notifications_list
// takes `limit_n` (not v_limit), notifications_mark_read takes an array `ids`
// (not single p_id). notifications_unread_count returns {count: N}.
import { rpc } from './db.js';
import { state, notify } from './state.js';

let _listeners = new Set();

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

export async function load(limit = 30) {
  const r = await rpc('notifications_list', { limit_n: Math.min(limit, 50) });
  if (!r?.ok && !r?.notifications) return r?.notifications || [];
  return r.notifications || [];
}

export async function markRead(ids) {
  const arr = Array.isArray(ids) ? ids : [ids];
  if (!arr.length) return { ok: true };
  return rpc('notifications_mark_read', { ids: arr });
}

export async function markAllRead() {
  return rpc('notifications_mark_read', { ids: null });
}

export async function unreadCount() {
  try {
    const r = await rpc('notifications_unread_count');
    return r?.count || 0;
  } catch {
    return 0;
  }
}

// ---- DM unread tracking (for inbox green-dot + count badge) ----
export async function refreshDmUnread() {
  try {
    const r = await rpc('inbox_list');
    const convs = r?.conversations || [];
    const total = convs.reduce((s, c) => s + (c.unread_count || 0), 0);
    state.dmUnreadTotal = total;
    state.dmInbox = convs;
    notify('inbox');
    return total;
  } catch {
    return state.dmUnreadTotal || 0;
  }
}

export function bumpUnreadDm() {
  state.dmUnreadTotal = (state.dmUnreadTotal || 0) + 1;
  notify('inbox');
}

// ---- unread count tracking ----
export function computeUnread(rows) {
  return (rows || []).filter(r => !r.read).length;
}

export async function refreshUnread() {
  try {
    state.unreadNotifs = await unreadCount();
    notify('notifications');
    return state.unreadNotifs;
  } catch {
    return 0;
  }
}

export function bumpUnread() {
  state.unreadNotifs = (state.unreadNotifs || 0) + 1;
  notify('notifications');
}