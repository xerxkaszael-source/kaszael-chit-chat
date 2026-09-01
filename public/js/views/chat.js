// chat.js — timeline: pagination, day dividers, broadcasts, typing line, autoscroll
import { rpc, from, GENERAL_ROOM } from '../lib/db.js';
import { state, subscribe, me } from '../lib/state.js';
import { el, ic, fmtDay } from '../lib/util.js';
import { renderMessageRow, scrollToMessage } from './message.js';
import { renderComposer } from './composer.js';
import { refreshReactionsForVisible } from '../lib/realtime.js';

let scrollEl = null, listEl = null, typingEl = null;
let loadingOlder = false, noMore = false, initialized = false;
const PAGE = 40;

export async function renderChat(mainEl) {
  mainEl.innerHTML = '';
  scrollEl = el('div', { class: 'chat-scroll', id: 'chat-scroll' });
  listEl = el('div', {});
  typingEl = el('div', { class: 'typing-line', 'aria-live': 'polite' });
  scrollEl.append(listEl);
  mainEl.append(scrollEl, renderComposer(), typingEl);

  subscribe(onChatState);

  if (!initialized) {
    initialized = true;
    await loadInitial();
  } else {
    redraw();
  }
}

async function loadInitial() {
  try {
    const { messages } = await rpc('message_list', { room_id: GENERAL_ROOM, limit_n: PAGE });
    state.messages = (messages || []).reverse(); // rpc returns desc
    const { data: atts } = await from('message_attachments').select('*').in('message_id', state.messages.map(m => m.id));
    state.attachments.clear();
    for (const a of atts || []) {
      if (!state.attachments.has(a.message_id)) state.attachments.set(a.message_id, []);
      state.attachments.get(a.message_id).push(a);
    }
    await refreshReactionsForVisible();
    try { state.pins = (await rpc('pins_list', { room_id: GENERAL_ROOM })).pins; } catch {}
    await loadBroadcastsIntoTimeline();
    redraw();
    scrollBottom(true);
  } catch (e) {
    console.error('[chc] initial load failed', e);
    listEl.append(el('div', { class: 'msg-system' }, el('div', { class: 'sys-card' }, 'Could not load messages. Retrying…')));
    setTimeout(loadInitial, 2500);
  }
}

async function loadBroadcastsIntoTimeline() {
  try {
    const { broadcasts } = await rpc('broadcasts_list', { limit_n: 10 });
    state.broadcasts = broadcasts || [];
  } catch { state.broadcasts = []; }
}

// ---------- drawing ----------
function redraw() {
  listEl.innerHTML = '';
  let lastDay = '';
  const merged = timelineItems();
  for (const item of merged) {
    if (item.kind === 'msg') {
      const day = fmtDay(item.msg.created_at);
      if (day !== lastDay) { listEl.append(el('div', { class: 'day-divider' }, day)); lastDay = day; }
      listEl.append(renderMessageRow(item.msg));
    } else if (item.kind === 'broadcast') {
      listEl.append(renderBroadcast(item.bc));
    }
  }
}

// interleave broadcasts with messages by created_at
function timelineItems() {
  const items = [
    ...state.messages.map(m => ({ kind: 'msg', msg: m, at: m.created_at })),
    ...(state.broadcasts || []).map(b => ({ kind: 'broadcast', bc: b, at: b.created_at })),
  ];
  items.sort((a, b) => a.at.localeCompare(b.at));
  return items;
}

function renderBroadcast(bc) {
  return el('div', { class: `broadcast-card kind-${bc.kind}` },
    el('div', { class: 'bc-head' }, ic('megaphone'), el('span', {}, `System · ${bc.kind}`)),
    el('div', { class: 'bc-title' }, bc.title),
    el('div', { class: 'bc-body' }, bc.body),
    el('div', { class: 'bc-meta' }, `by ${bc.author_display_name || bc.author_username || 'staff'} · ${new Date(bc.created_at).toLocaleString()}`));
}

// ---------- pagination ----------
async function loadOlder() {
  if (loadingOlder || noMore) return;
  loadingOlder = true;
  const oldest = state.messages[0];
  if (!oldest) { loadingOlder = false; return; }
  const anchor = scrollEl.scrollHeight;
  try {
    const { messages } = await rpc('message_list', { room_id: GENERAL_ROOM, before_ts: oldest.created_at, limit_n: PAGE });
    const older = (messages || []).reverse();
    if (older.length < PAGE) noMore = true;
    if (older.length) {
      const ids = older.map(m => m.id);
      const { data: atts } = await from('message_attachments').select('*').in('message_id', ids);
      for (const a of atts || []) {
        if (!state.attachments.has(a.message_id)) state.attachments.set(a.message_id, []);
        state.attachments.get(a.message_id).push(a);
      }
      state.messages = [...older, ...state.messages];
      await refreshReactionsForVisible();
      redraw();
      scrollEl.scrollTop = scrollEl.scrollHeight - anchor;
    }
  } catch (e) { console.error('[chc] loadOlder', e); }
  loadingOlder = false;
}

function onScroll() {
  if (scrollEl && scrollEl.scrollTop < 200) loadOlder();
}

// ---------- state reactions ----------
let lastCount = 0;
function onChatState(topic) {
  if (!scrollEl) return;
  if (topic === 'message') {
    const nearBottom = scrollEl.scrollHeight - scrollEl.scrollTop - scrollEl.clientHeight < 240;
    const grew = state.messages.length !== lastCount;
    redraw();
    lastCount = state.messages.length;
    if (nearBottom && grew) scrollBottom();
  } else if (topic === 'reactions') {
    redraw();
  } else if (topic === 'typing') {
    drawTyping();
  } else if (topic === 'broadcast') {
    loadBroadcastsIntoTimeline().then(() => { redraw(); scrollBottom(); });
  }
}

function drawTyping() {
  const names = [...state.typing.values()].map(t => t.name);
  if (names.length === 0) typingEl.textContent = '';
  else if (names.length === 1) typingEl.textContent = `${names[0]} is typing…`;
  else if (names.length === 2) typingEl.textContent = `${names[0]} and ${names[1]} are typing…`;
  else typingEl.textContent = `${names.length} people are typing…`;
}

function scrollBottom(instant = false) {
  requestAnimationFrame(() => {
    scrollEl.scrollTo({ top: scrollEl.scrollHeight, behavior: instant ? 'auto' : 'smooth' });
  });
}

// attach scroll listener after element exists
const io = new MutationObserver(() => {
  const s = document.getElementById('chat-scroll');
  if (s && s !== scrollEl) { scrollEl = s; }
  if (scrollEl && !scrollEl._bound) { scrollEl._bound = true; scrollEl.addEventListener('scroll', onScroll); }
});
io.observe(document.body, { childList: true, subtree: true });

window.addEventListener('chc:scroll-to', (e) => scrollToMessage(e.detail.id));
window.addEventListener('chc:message-updated', () => onChatState('message'));
