// realtime.js — subscription lifecycle, typing broadcast, presence heartbeat.
// One subscription per channel; explicit cleanup on logout; reconnect-safe.
import { sb, GENERAL_ROOM, rpc } from './db.js';
import { state, notify, profileOf, insertMessage, patchMessage } from './state.js';
import { playMessageSound, playMentionSound, playBroadcastSound } from './sound.js';

let subMessages = null, subReactions = null, subPins = null, subBroadcasts = null;
let presenceChannel = null, typingChannel = null;
let heartbeatTimer = null, typingTimer = null, typingExpireTimer = null;
let lastTypingSent = 0;
let destroyed = false;

export function setConnState(s) {
  if (state.connState === s) return;
  state.connState = s;
  notify('conn');
}

function dedupeInsert(msg) {
  // realtime INSERT can race with the RPC return — dedupe by id and client_msg_id
  if (state.messages.some(m => m.id === msg.id)) return false;
  if (msg.client_msg_id && state.messages.some(m => m.client_msg_id === msg.client_msg_id)) return false;
  return insertMessage(msg);
}

// ---- message realtime ----
function onMessageEvent(payload) {
  if (destroyed) return;
  const { eventType, new: n, old: o } = payload;
  if (eventType === 'INSERT') {
    if (!dedupeInsert(n)) return;
    notify('message');
    if (n.sender_id !== state.profile?.id) {
      const mine = state.profile?.username;
      const mentioned = mine && n.content?.toLowerCase().includes('@' + mine);
      mentioned ? playMentionSound() : playMessageSound();
      if (document.hidden && mine) {
        try { if (typeof Notification !== 'undefined') new Notification(`New message — ${profileOf(n.sender_id)?.display_name || 'Someone'}`, { body: n.content?.slice(0, 100) }); } catch {}
      }
    }
  } else if (eventType === 'UPDATE') {
    patchMessage(n.id, n);
    notify('message');
  } else if (eventType === 'DELETE') {
    const i = state.messages.findIndex(m => m.id === (n?.id || o?.id));
    if (i >= 0) state.messages.splice(i, 1);
    notify('message');
  }
}

// ---- presence heartbeat (DB-backed; sweep lives inside RPC) ----
async function beat() {
  if (destroyed || !state.session) return;
  try {
    await rpc('presence_heartbeat', { session_id: state.session.access_token.slice(0, 12) });
    setConnState('online');
  } catch (e) {
    const code = e.chc?.code;
    if (code === 'banned') { notify('kicked-banned'); return; }
    if (code === 'kicked') { notify('kicked-banned'); return; }
    setConnState('reconnecting');
  }
}

// ---- typing via Realtime Broadcast (no DB writes) ----
export function announceTyping() {
  if (!typingChannel || !state.profile) return;
  const now = Date.now();
  if (now - lastTypingSent < 1500) return;
  lastTypingSent = now;
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { uid: state.profile.id, name: state.profile.display_name } }).catch(() => {});
  clearTimeout(typingTimer);
  typingTimer = setTimeout(() => {
    typingChannel?.send({ type: 'broadcast', event: 'typing_stop', payload: { uid: state.profile.id } }).catch(() => {});
  }, 2500);
}

function onTypingEvent(payload) {
  const { event, payload: p } = payload;
  if (!p?.uid || p.uid === state.profile?.id) return;
  if (event === 'typing') state.typing.set(p.uid, { name: p.name, ts: Date.now() });
  else state.typing.delete(p.uid);
  scheduleTypingExpiry();
  notify('typing');
}

function scheduleTypingExpiry() {
  clearTimeout(typingExpireTimer);
  typingExpireTimer = setTimeout(() => {
    const now = Date.now();
    let changed = false;
    for (const [uid, t] of state.typing) if (now - t.ts > 5000) { state.typing.delete(uid); changed = true; }
    if (changed) notify('typing');
    if (state.typing.size) scheduleTypingExpiry();
  }, 2000);
}

// ---- subscriptions ----
export async function startRealtime() {
  destroyed = false;

  // Start the presence heartbeat FIRST so the "connected" state resolves even
  // if a realtime subscription below throws (was leaving it at "connecting").
  try { await beat(); } catch {}
  heartbeatTimer = setInterval(beat, 30000);

  try {
    subMessages = sb.channel('db-messages')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'messages', filter: `room_id=eq.${GENERAL_ROOM}` }, onMessageEvent)
      .subscribe();
  } catch (e) { console.error('[chc] messages channel failed', e); }

  try {
    subReactions = sb.channel('db-reactions')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, async () => {
        await refreshReactionsForVisible();
        notify('reactions');
      }).subscribe();
  } catch (e) { console.error('[chc] reactions channel failed', e); }

  try {
    subPins = sb.channel('db-pins')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'message_pins' }, async () => {
        try { state.pins = (await rpc('pins_list', { room_id: GENERAL_ROOM })).pins; notify('pins'); } catch {}
      }).subscribe();
  } catch (e) { console.error('[chc] pins channel failed', e); }

  try {
    subBroadcasts = sb.channel('db-broadcasts')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'broadcasts' }, (payload) => {
        notify('broadcast');
        playBroadcastSound();
        void payload;
      }).subscribe();
  } catch (e) { console.error('[chc] broadcasts channel failed', e); }

  try {
    presenceChannel = sb.channel('presence-room', { config: { presence: { key: state.profile?.id || 'anon' } } })
      .on('presence', { event: 'sync' }, () => {
        state.presenceFromRealtime = presenceChannel.presenceState();
        notify('presence');
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          try { await presenceChannel.track({ uid: state.profile?.id, at: Date.now() }); } catch {}
        }
      });
  } catch (e) { console.error('[chc] presence channel failed', e); }

  try {
    typingChannel = sb.channel('typing-room')
      .on('broadcast', { event: 'typing' }, onTypingEvent)
      .on('broadcast', { event: 'typing_stop' }, onTypingEvent)
      .subscribe();
  } catch (e) { console.error('[chc] typing channel failed', e); }

  // connection lifecycle
  sb.realtime.onStateChange((s) => {
    if (s === 'closed' || s === 'errored') setConnState('reconnecting');
    else if (s === 'open') setConnState('online');
  });
  window.addEventListener('online', () => setConnState('reconnecting'));
  window.addEventListener('offline', () => setConnState('offline'));
}

export async function refreshReactionsForVisible() {
  const ids = state.messages.slice(-80).map(m => m.id);
  if (!ids.length) { state.reactions.clear(); return; }
  const { reactions } = await rpc('reactions_for', { message_ids: ids });
  state.reactions.clear();
  for (const r of reactions) {
    if (!state.reactions.has(r.message_id)) state.reactions.set(r.message_id, []);
    state.reactions.get(r.message_id).push(r);
  }
}

export function stopRealtime() {
  destroyed = true;
  clearInterval(heartbeatTimer);
  clearTimeout(typingTimer);
  clearTimeout(typingExpireTimer);
  for (const c of [subMessages, subReactions, subPins, subBroadcasts, presenceChannel, typingChannel]) {
    try { c && sb.removeChannel(c); } catch {}
  }
  subMessages = subReactions = subPins = subBroadcasts = presenceChannel = typingChannel = null;
  rpc('presence_leave', {}).catch(() => {});
}
