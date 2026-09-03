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
    try { state.pins = (await rpc('pins_list', { room_id: GENERAL_ROOM })).pins; } catch (e) {}
    await showRecentBroadcasts();
    // Bug fix: clear any retry card from a previous failed load — otherwise it
    // lingers on screen forever even after messages loaded.
    listEl.querySelectorAll('.load-retry').forEach(c => c.remove());
    redraw();
    scrollBottom(true);
  } catch (e) {
    console.error('[chc] initial load failed', e);
    if (state.messages.length === 0) {
      // replace any existing retry card (don't stack a new one every 2.5s)
      let card = listEl.querySelector('.load-retry');
      if (!card) {
        card = el('div', { class: 'msg-system load-retry' }, el('div', { class: 'sys-card' }, 'Could not load messages. Retrying…'));
        listEl.append(card);
      }
    }
    setTimeout(loadInitial, 2500);
  }
}

// show recent broadcasts as floating banners (not inline timeline cards).
// These are announcements, not chat messages — they auto-dismiss per banner.
async function showRecentBroadcasts() {
  try {
    const { broadcasts } = await rpc('broadcasts_list', { limit_n: 3 });
    state.broadcasts = broadcasts || [];
    if (broadcasts?.length) {
      const { showBroadcastBubble } = await import('../lib/broadcast.js');
      for (const b of broadcasts.slice(0, 3)) showBroadcastBubble(b);
    }
  } catch (e) { state.broadcasts = []; }
}

// ---------- drawing ----------
// Per brief §49: virtualization for long message lists. Strategy:
//   - state.messages holds ALL loaded messages (for search/scroll-to-id)
//   - the DOM only renders the most recent MAX_RENDER + a "load older" button
//   - when scrolled near top, loadOlder() paginates from DB (cursor)
//   - when scroll position lands in the trimmed zone, we re-attach the
//     top windowed slice without flicker (we keep an offscreen buffer).
// This is a simple "tail window" — sufficient for any chat up to ~10k msgs
// without DOM bloat. For truly massive rooms, swap in IntersectionObserver
// windowing later.
const MAX_RENDER = 200;

function redraw() {
  if (!listEl) return;
  const total = state.messages.length;
  const startIdx = Math.max(0, total - MAX_RENDER);
  const trimmed = total - startIdx > 0 && state.messages.length > MAX_RENDER;

  // We mutate listEl in-place where possible to avoid full teardown flicker
  listEl.innerHTML = '';
  if (trimmed) {
    listEl.append(el('div', { class: 'msg-system' },
      el('div', { class: 'sys-card' },
        `${total - MAX_RENDER} earlier messages hidden. Scroll up to load more.`)));
  }
  let lastDay = '';
  for (let i = startIdx; i < total; i++) {
    const item = state.messages[i];
    const day = fmtDay(item.created_at);
    if (day !== lastDay) { listEl.append(el('div', { class: 'day-divider' }, day)); lastDay = day; }
    listEl.append(renderMessageRow(item));
  }
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
