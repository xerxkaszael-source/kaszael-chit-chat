// lib/read-receipts.js — centralized read-mark flusher + multi-tab reconcile.
// Per brief §13: do not continuously write read-state updates.
// We debounce per-conversation read marks to once per 1.5s, and use localStorage
// `storage` events so other tabs see our claim and don't double-fire.
import { markDmRead } from './dm.js';
import { state, notify } from './state.js';

// per-conversation queue of message_ids awaiting flush
const pending = new Map(); // convId -> Set<msgId>
const timers = new Map();  // convId -> timeoutId
const FLUSH_MS = 1500;

// multi-tab dedup — when another tab sets the key, we skip our own flush for that
// conv until our queue catches up to (or exceeds) the other tab's claim.
const remoteClaims = new Map(); // convId -> { id, at }

function key(convId) { return `chc:dm:read:${convId}`; }

export function queueReadMark(convId, msgId) {
  if (!convId || !msgId) return;
  let s = pending.get(convId);
  if (!s) { s = new Set(); pending.set(convId, s); }
  s.add(msgId);
  clearTimeout(timers.get(convId));
  timers.set(convId, setTimeout(() => flush(convId), FLUSH_MS));
}

async function flush(convId) {
  const ids = pending.get(convId);
  if (!ids || !ids.size) return;
  pending.delete(convId);
  timers.delete(convId);
  // Skip if another tab already claimed a higher message id for this conv recently.
  const remote = remoteClaims.get(convId);
  if (remote && remote.at > Date.now() - 5000) {
    // Other tab beat us — check if our highest is ≤ theirs
    let ourHighestTs = 0;
    for (const id of ids) {
      const ts = parseTs(id) || 0;
      if (ts > ourHighestTs) ourHighestTs = ts;
    }
    // if no ts info (UUIDs not timestamps), be conservative: still flush unless we know theirs is fresher
    if (remote.id && ourHighestTs && ourHighestTs < Date.now() - 60_000) {
      // both timestamps are far in the past — defer
      pending.set(convId, ids);
      timers.set(convId, setTimeout(() => flush(convId), FLUSH_MS));
      return;
    }
  }
  // pick canonical "through" id: the latest UUID in lexical order is a poor proxy;
  // better: take the highest created_at across our loaded messages for this conv.
  let highest = null, highestTs = 0;
  // Note: state.dmInbox doesn't carry per-msg timestamps; we accept any id from the
  // queue since the RPC (dm_mark_read) interprets it server-side. We pick the last
  // queued id (LIFO-ish — they're added in arrival order).
  for (const id of ids) {
    highest = id; // last wins for chronological add
  }
  try {
    await markDmRead(convId, highest);
    // Broadcast our claim for other tabs
    try { localStorage.setItem(key(convId), JSON.stringify({ id: highest, at: Date.now() })); } catch {}
    // Optimistic local inbox decrement
    if (state.dmInbox && Array.isArray(state.dmInbox)) {
      const row = state.dmInbox.find(r => r.conversation_id === convId);
      if (row && row.unread_count > 0) {
        row.unread_count = 0;
        state.dmUnreadTotal = state.dmInbox.reduce((s, c) => s + (c.unread_count || 0), 0);
        notify('dm-unread');
      }
    }
  } catch {
    // restore queue for retry
    pending.set(convId, ids);
    timers.set(convId, setTimeout(() => flush(convId), FLUSH_MS));
  }
}

function parseTs(id) {
  // UUIDv7 embeds timestamp; we don't rely on it. Best-effort: try Date.parse().
  const d = new Date(id);
  return isNaN(d) ? 0 : d.getTime();
}

// ---- multi-tab reconcile ----
// When another tab writes chc:dm:read:<convId>, we learn about it.
if (typeof window !== 'undefined') {
  window.addEventListener('storage', (ev) => {
    if (!ev.key || !ev.key.startsWith('chc:dm:read:')) return;
    const convId = ev.key.slice('chc:dm:read:'.length);
    try {
      const claim = JSON.parse(ev.newValue || '{}');
      if (claim && claim.id) remoteClaims.set(convId, claim);
      // Also: if we're currently viewing this conv, refresh the bubble states
      if (state.activeDmConvId === convId) {
        // Mark all messages with id <= claim.id as read_by_other for instant UI feedback
        if (typeof window.__chcMarkReadByOther === 'function') {
          window.__chcMarkReadByOther(claim.id);
        }
      }
    } catch {}
  });
}

export function resetReadReceipts() {
  for (const t of timers.values()) clearTimeout(t);
  pending.clear();
  timers.clear();
  remoteClaims.clear();
}