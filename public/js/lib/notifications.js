// lib/notifications.js — notification center data layer.
// Wraps the new RPCs (migration 018): notifications_list, notifications_mark_read,
// notifications_mark_all_read. Also includes lib/realtime.js hooks for live
// unread-count badge updates on the bell icon in the shell.
import { rpc } from './db.js';
import { state, notify } from './state.js';

let _listeners = new Set();

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }

export async function load(limit = 50, beforeId = null) {
  const r = await rpc('notifications_list', { v_limit: limit, v_before_id: beforeId });
  if (!r?.ok) throw new Error(r?.error || 'load_failed');
  return r.notifications || [];
}

export async function markRead(id) {
  return rpc('notifications_mark_read', { p_id: id });
}

export async function markAllRead() {
  return rpc('notifications_mark_all_read');
}

// ---- unread count tracking ----
// Used by main.js / shell.js to drive the bell badge.
// Strategy: count rows in the latest page where read=false, plus delta from realtime.
export function computeUnread(rows) {
  return (rows || []).filter(r => !r.read).length;
}

export async function refreshUnread() {
  try {
    const rows = await load(100);
    state.unreadNotifs = computeUnread(rows);
    notify('notifications');
    return rows;
  } catch {
    return [];
  }
}

// Hook called from realtime.js when an INSERT into notifications arrives for self.
export function bumpUnread() {
  state.unreadNotifs = (state.unreadNotifs || 0) + 1;
  notify('notifications');
}