// views/dm.js — private 1-on-1 chat view. Mirrors chat.js pattern but for DM.
// Loads conversation_id, fetches messages, supports reply/edit/delete/reactions,
// draft auto-save, mark-read on view.
import { sb } from '../lib/db.js';
import {
  openOrCreateConversation,
  loadDmMessages,
  sendDmMessage,
  editDmMessage,
  deleteDmMessage,
  toggleDmReaction,
  fetchDmReactions,
  getDraft,
  setDraft
} from '../lib/dm.js';
import { queueReadMark as _rr_queueReadMark } from '../lib/read-receipts.js';
import { state, me } from '../lib/state.js';
import { el, ic, icBtn, esc, richText, fmtTime, fmtDay, relTime, debounce, uuid, toast, confirmModal } from '../lib/util.js';
import { avatar } from '../lib/avatar.js';

let dmViewEl = null;
let currentConvId = null;
let currentOtherId = null;
let currentOtherProfile = null;
let dmMessages = [];
let dmReactions = new Map(); // msgId -> [{emoji, count, by_me}]
let realtimeChannel = null;
let typingDmChannel = null;     // per-conversation typing broadcast
let reactionsChannel = null;   // postgres_changes for message_reactions_dm (visible-window filtered)
let readsChannel = null;       // postgres_changes for message_reads (own messages from other side)
let draftSaveTimer = null;
let replyToMsg = null;
let editingMsg = null;
let visibleMsgIds = [];        // for reaction subscription filter
let ownMsgIds = new Set();     // for read-receipt subscription filter
let pendingReadMarks = new Set(); // debounced read-mark queue (legacy in-file state; primary queue lives in lib/read-receipts.js)
let readMarkTimer = null;

// Short text reaction tokens (Flaticon UIcons policy: no emoji as UI icons).
// Token choices mirror common Slack/Discord quick reactions for muscle memory.
const EMOJI_OPTIONS = [
  { label: '+1', token: ':+1:' },
  { label: 'love', token: ':heart:' },
  { label: 'haha', token: ':joy:' },
  { label: 'wow', token: ':open:' },
  { label: 'sad', token: ':cry:' },
  { label: 'fire', token: ':fire:' },
  { label: 'party', token: ':tada:' },
  { label: 'clap', token: ':clap:' }
];

// Map token -> label for rendering. Falls back to the token itself.
const TOKEN_LABEL = Object.fromEntries(EMOJI_OPTIONS.map(o => [o.token, o.label]));
function tokenToLabel(token) { return TOKEN_LABEL[token] || token; }

export async function openDm(otherId, convId = null) {
  currentOtherId = otherId;
  try {
    if (!convId) {
      convId = await openOrCreateConversation(otherId);
    }
    currentConvId = convId;
  } catch (e) {
    toast(`Cannot open chat: ${e.message}`, 'error');
    return;
  }

  // fetch other user profile (cached in state.profiles, hydrate sender on realtime too)
  await ensureProfile(otherId);
  currentOtherProfile = state.profiles.get(otherId) || { id: otherId, username: 'unknown', display_name: 'Unknown', avatar_color: '#888' };

  await renderDmView();
}

export async function renderDmView() {
  // Mount in mainEl
  const mainEl = document.querySelector('.main');
  if (!mainEl) return;
  mainEl.innerHTML = '';
  dmViewEl = el('div', { class: 'dm-view' });
  mainEl.append(dmViewEl);
  drawShell();
  await loadMessages();
  subscribeRealtime();
  subscribeTyping();
  subscribeReactionsRealtime();
  subscribeReadsRealtime();
  // Queue initial read mark; will be flushed by debounced flusher.
  if (dmMessages.length > 0) {
    queueReadMark(dmMessages[dmMessages.length - 1].id);
  }
}

function drawShell() {
  const other = currentOtherProfile;
  dmViewEl.innerHTML = '';
  dmViewEl.append(
    el('div', { class: 'view-head dm-head' },
      icBtn('arrow-left', 'Back', () => { location.hash = '/inbox'; }),
      avatar(other, { size: 'sm', showPresence: true }),
      el('div', { class: 'dm-title' },
        el('div', { class: 'dm-name' }, other.display_name || other.username),
        el('div', { class: 'dm-sub' }, `@${other.username}`)),
      el('div', { class: 'topbar-spacer' })),
    el('div', { class: 'dm-body', id: 'dm-body' },
      el('div', { class: 'skeleton-row' }, 'Loading messages…')),
    el('div', { class: 'dm-composer', id: 'dm-composer' }));
  drawComposer();
}

async function loadMessages() {
  const body = document.getElementById('dm-body');
  if (!body) return;
  try {
    dmMessages = await loadDmMessages(currentConvId, null, 50);
    body.innerHTML = '';
    if (dmMessages.length === 0) {
      body.append(el('div', { class: 'empty-state' },
        el('div', { class: 'empty-icon' }, ic('comment')),
        el('p', {}, 'No messages yet — say hi!')));
    } else {
      await drawMessages();
    }
    body.scrollTop = body.scrollHeight;
    // load reactions for all messages
    const ids = dmMessages.map(m => m.id);
    if (ids.length) {
      const rxs = await fetchDmReactions(ids).catch(() => []);
      dmReactions.clear();
      for (const r of rxs) {
        if (!dmReactions.has(r.message_id)) dmReactions.set(r.message_id, []);
        dmReactions.get(r.message_id).push(r);
      }
    }
    // load draft
    const draft = await getDraft(currentConvId).catch(() => '');
    const input = document.getElementById('dm-input');
    if (input && draft) input.value = draft;
  } catch (e) {
    console.error('[chc] dm load failed', e);
    toast(`Failed to load messages: ${e.message}`, 'error');
  }
}

async function drawMessages() {
  const body = document.getElementById('dm-body');
  if (!body) return;
  body.innerHTML = '';
  let lastDay = null;
  for (const m of dmMessages) {
    const day = fmtDay(m.created_at);
    if (day !== lastDay) {
      body.append(el('div', { class: 'day-sep' }, day));
      lastDay = day;
    }
    body.append(renderMessage(m));
  }
}

function renderMessage(m) {
  const mine = m.sender_id === me().id;
  const wrap = el('div', { class: `dm-msg ${mine ? 'mine' : 'theirs'}${m._failed ? ' failed' : ''}` });
  wrap.append(avatar({ id: m.sender_id, username: m.sender_username, display_name: m.sender_display_name, avatar_color: m.sender_avatar_color }, { size: 'xs' }));
  wrap.append(el('div', { class: 'dm-bubble' },
    el('div', { class: 'dm-text', html: richText(m.content) }),
    el('div', { class: 'dm-meta' },
      el('span', { class: 'dm-time' }, fmtTime(m.created_at)),
      m.edited_at ? el('span', { class: 'dm-edited' }, '(edited)') : null,
      mine && m.id ? el('span', { class: `dm-read${m.read_by_other ? ' read' : ''}`, title: m.read_by_other ? 'Read' : 'Sent' }, m.read_by_other ? '✓✓' : '✓') : null,
      m._failed ? el('span', { class: 'dm-failed-icon' }, '!') : null,
      reactionRow(m.id))));
  wrap.append(messageActions(m, mine));
  return wrap;
}

function reactionRow(msgId) {
  const rxs = dmReactions.get(msgId) || [];
  if (rxs.length === 0) return null;
  return el('div', { class: 'dm-reactions' },
    ...rxs.map(r => el('button', {
      class: `dm-reaction${r.by_me ? ' mine' : ''}`,
      title: tokenToLabel(r.emoji),
      'aria-label': `${tokenToLabel(r.emoji)}, ${r.count}`,
      onclick: () => doToggleReaction(msgId, r.emoji)
    }, el('span', { class: 'dm-rx-label' }, tokenToLabel(r.emoji)), el('span', { class: 'dm-rx-count' }, String(r.count)))));
}

function messageActions(m, mine) {
  const wrap = el('div', { class: 'dm-actions' });
  // reactions
  const reactBtn = el('button', { class: 'dm-act', onclick: e => showReactionPicker(e, m.id) }, ic('smile'));
  wrap.append(reactBtn);
  wrap.append(el('button', { class: 'dm-act', onclick: () => setReplyTo(m) }, ic('reply')));
  if (mine) {
    wrap.append(el('button', { class: 'dm-act', onclick: () => setEdit(m) }, ic('edit')));
    wrap.append(el('button', { class: 'dm-act danger', onclick: () => doDelete(m) }, ic('trash')));
  }
  return wrap;
}

function showReactionPicker(ev, msgId) {
  // popover with text-label quick reactions (Flaticon UIcons policy: no emoji icons).
  // Stored as :token: in DB for backward compat with chat.js reaction columns.
  const pop = el('div', { class: 'reaction-picker' });
  for (const e of EMOJI_OPTIONS) {
    pop.append(el('button', {
      class: 'reaction-pick',
      title: e.label,
      'aria-label': `React with ${e.label}`,
      onclick: () => { pop.remove(); doToggleReaction(msgId, e.token); }
    }, e.label));
  }
  pop.style.position = 'absolute';
  pop.style.left = (ev.clientX - 110) + 'px';
  pop.style.top = (ev.clientY - 44) + 'px';
  document.body.append(pop);
  setTimeout(() => document.addEventListener('click', function h() { pop.remove(); document.removeEventListener('click', h); }, { once: true }), 0);
}

async function doToggleReaction(msgId, emoji) {
  try {
    await toggleDmReaction(msgId, emoji);
    const rxs = await fetchDmReactions(dmMessages.map(m => m.id)).catch(() => []);
    dmReactions.clear();
    for (const r of rxs) {
      if (!dmReactions.has(r.message_id)) dmReactions.set(r.message_id, []);
      dmReactions.get(r.message_id).push(r);
    }
    await drawMessages();
    scrollToBottom();
  } catch (e) { toast(`Reaction failed: ${e.message}`, 'error'); }
}

function setReplyTo(m) {
  replyToMsg = m;
  editingMsg = null;
  const input = document.getElementById('dm-input');
  if (input) input.focus();
  updateComposerHints();
}

function setEdit(m) {
  editingMsg = m;
  replyToMsg = null;
  const input = document.getElementById('dm-input');
  if (input) {
    input.value = m.content;
    input.focus();
  }
  updateComposerHints();
}

function updateComposerHints() {
  const bar = document.getElementById('composer-hint');
  if (!bar) return;
  bar.innerHTML = '';
  if (replyToMsg) {
    bar.append(el('div', { class: 'composer-hint reply' },
      ic('reply'),
      el('span', {}, `Replying to: ${replyToMsg.content.slice(0, 50)}${replyToMsg.content.length > 50 ? '…' : ''}`),
      el('button', { onclick: () => { replyToMsg = null; updateComposerHints(); }, class: 'icon-btn' }, ic('cross'))));
  }
  if (editingMsg) {
    bar.append(el('div', { class: 'composer-hint edit' },
      ic('edit'),
      el('span', {}, 'Editing message'),
      el('button', { onclick: () => { editingMsg = null; const i = document.getElementById('dm-input'); if (i) i.value = ''; updateComposerHints(); }, class: 'icon-btn' }, ic('cross'))));
  }
}

async function doDelete(m) {
  const ok = await confirmModal({ title: 'Delete message?', text: 'This will permanently remove the message for both sides.', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  try {
    await deleteDmMessage(m.id);
    dmMessages = dmMessages.filter(x => x.id !== m.id);
    await drawMessages();
    toast('Message deleted', 'info', 1500);
  } catch (e) { toast(`Delete failed: ${e.message}`, 'error'); }
}

function drawComposer() {
  const composerEl = document.getElementById('dm-composer');
  if (!composerEl) return;
  composerEl.innerHTML = '';
  composerEl.append(el('div', { id: 'composer-hint' }));
  const input = el('textarea', {
    id: 'dm-input',
    class: 'dm-input',
    placeholder: 'Message…',
    rows: '1',
    onkeydown: handleKey,
    oninput: handleInput
  });
  composerEl.append(input);
  composerEl.append(el('button', { class: 'btn primary dm-send', onclick: send }, ic('paper-plane-top')));
}

function handleKey(e) {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    send();
  }
}

function handleInput(e) {
  // autosize
  e.target.style.height = 'auto';
  e.target.style.height = Math.min(e.target.scrollHeight, 160) + 'px';
  // debounce draft save
  if (draftSaveTimer) clearTimeout(draftSaveTimer);
  draftSaveTimer = setTimeout(() => {
    setDraft(currentConvId, e.target.value).catch(() => {});
  }, 600);
  // typing broadcast — only if we're connected to a DM with someone
  announceOwnTyping();
}

// ---- typing broadcast (own → other side) ----
let ownTypingLastSent = 0;
let ownTypingStopTimer = null;
function announceOwnTyping() {
  if (!typingDmChannel || !me()) return;
  const now = Date.now();
  if (now - ownTypingLastSent < 1500) return;
  ownTypingLastSent = now;
  typingDmChannel.send({
    type: 'broadcast',
    event: 'typing',
    payload: { uid: me().id, name: me().display_name || me().username }
  }).catch(() => {});
  clearTimeout(ownTypingStopTimer);
  ownTypingStopTimer = setTimeout(() => {
    typingDmChannel?.send({ type: 'broadcast', event: 'typing_stop', payload: { uid: me().id } }).catch(() => {});
  }, 2500);
}

async function send() {
  const input = document.getElementById('dm-input');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  const clientMsgId = uuid();

  if (editingMsg) {
    try {
      await editDmMessage(editingMsg.id, content);
      editingMsg = null;
      input.value = '';
      await loadMessages();
      return;
    } catch (e) { toast(`Edit failed: ${e.message}`, 'error'); return; }
  }

  // optimistic
  input.value = '';
  input.style.height = 'auto';
  const optMsg = {
    id: clientMsgId, // temp ID until server returns real
    conversation_id: currentConvId,
    sender_id: me().id,
    sender_username: me().username,
    sender_display_name: me().display_name,
    sender_avatar_color: me().avatar_color,
    content,
    reply_to: replyToMsg?.id || null,
    moderation_state: 'visible',
    created_at: new Date().toISOString(),
    edited_at: null,
    _pending: true
  };
  dmMessages.push(optMsg);
  ownMsgIds.add(clientMsgId);
  drawMessages().then(scrollToBottom);

  try {
    const r = await sendDmMessage(currentConvId, content, clientMsgId, replyToMsg?.id || null);
    replyToMsg = null;
    updateComposerHints();
    // replace optimistic with real — server returns the canonical message_id
    const idx = dmMessages.findIndex(m => m.id === clientMsgId);
    if (idx >= 0) {
      dmMessages[idx].id = r.message_id;
      ownMsgIds.delete(clientMsgId);
      ownMsgIds.add(r.message_id);
    }
    drawMessages().then(scrollToBottom);
  } catch (e) {
    const idx = dmMessages.findIndex(m => m.id === clientMsgId);
    if (idx >= 0) dmMessages[idx]._failed = true;
    drawMessages();
    toast(`Send failed: ${e.message}`, 'error');
  }
}

function scrollToBottom() {
  const body = document.getElementById('dm-body');
  if (body) body.scrollTop = body.scrollHeight;
}

// ---- ensure profile in state.profiles (used by sender-hydrate in realtime handlers) ----
async function ensureProfile(uid) {
  if (!uid) return null;
  const cached = state.profiles.get(uid);
  if (cached && cached.username) return cached;
  try {
    const { data } = await sb.from('profiles').select('*').eq('id', uid).maybeSingle();
    if (data) {
      state.profiles.set(uid, data);
      return data;
    }
  } catch {}
  return cached || null;
}

// ---- private channel: direct_messages (server-side filter by conversation_id) ----
// Authorization enforced by RLS on direct_messages + the postgres_changes filter. Only
// members of the conversation can SELECT it; the realtime publication respects RLS.
function subscribeRealtime() {
  if (realtimeChannel) {
    try { sb.removeChannel(realtimeChannel); } catch {}
    realtimeChannel = null;
  }
  realtimeChannel = sb.channel(`dm:${currentConvId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${currentConvId}` },
      async (payload) => {
        const m = payload.new;
        if (!m || dmMessages.some(x => x.id === m.id)) return; // already have (from optimistic)
        // Hydrate sender profile — required because direct_messages has no FK join
        const sender = await ensureProfile(m.sender_id);
        const hydrated = {
          ...m,
          sender_username: sender?.username || '?',
          sender_display_name: sender?.display_name || sender?.username || 'Unknown',
          sender_avatar_color: sender?.avatar_color || '#888'
        };
        dmMessages.push(hydrated);
        if (sender) state.profiles.set(m.sender_id, sender);
        // ownMsgIds refreshed after push so reads subscription picks up the new msg
        if (m.sender_id === me().id) ownMsgIds.add(m.id);
        drawMessages().then(scrollToBottom);
        // Queue read mark if message is visible and not from us
        if (m.sender_id !== me().id) queueReadMark(m.id);
      })
    .on('postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${currentConvId}` },
      (payload) => {
        const m = payload.new;
        const i = dmMessages.findIndex(x => x.id === m.id);
        if (i >= 0) {
          // Preserve hydrated sender fields
          dmMessages[i] = { ...dmMessages[i], ...m, sender_username: dmMessages[i].sender_username,
                            sender_display_name: dmMessages[i].sender_display_name,
                            sender_avatar_color: dmMessages[i].sender_avatar_color };
          drawMessages();
        }
      })
    .subscribe();
}

// ---- per-conversation typing broadcast ----
// Each open DM gets its own broadcast channel so typing events don't leak between
// conversations. Channel is public broadcast, scope enforced client-side — but typing
// payloads carry no content, only "X is typing".
function subscribeTyping() {
  if (typingDmChannel) {
    try { sb.removeChannel(typingDmChannel); } catch {}
    typingDmChannel = null;
  }
  typingDmChannel = sb.channel(`typing-dm:${currentConvId}`, { config: { broadcast: { self: false } } })
    .on('broadcast', { event: 'typing' }, ({ payload }) => {
      if (!payload || payload.uid !== currentOtherId) return;
      showTypingIndicator(payload.name);
    })
    .on('broadcast', { event: 'typing_stop' }, ({ payload }) => {
      if (!payload || payload.uid !== currentOtherId) return;
      hideTypingIndicator();
    })
    .subscribe();
}

// ---- reactions realtime: refresh visible-window reactions on any change ----
// message_reactions_dm has RLS restricting visibility to conversation members, so the
// subscription is safe. We don't filter by message_id (postgres_changes filter on
// message_id would require enumerating all visible IDs which changes on scroll).
function subscribeReactionsRealtime() {
  if (reactionsChannel) {
    try { sb.removeChannel(reactionsChannel); } catch {}
    reactionsChannel = null;
  }
  reactionsChannel = sb.channel('dm-reactions')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions_dm' }, async () => {
      const ids = dmMessages.map(m => m.id);
      if (!ids.length) return;
      try {
        const rxs = await fetchDmReactions(ids);
        dmReactions.clear();
        for (const r of rxs) {
          if (!dmReactions.has(r.message_id)) dmReactions.set(r.message_id, []);
          dmReactions.get(r.message_id).push(r);
        }
        drawMessages();
      } catch {}
    })
    .subscribe();
}

// ---- reads realtime: when the OTHER side marks our messages as read ----
function subscribeReadsRealtime() {
  if (readsChannel) {
    try { sb.removeChannel(readsChannel); } catch {}
    readsChannel = null;
  }
  readsChannel = sb.channel('dm-reads')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'message_reads' }, (payload) => {
      const r = payload.new;
      if (!r || r.user_id !== currentOtherId) return;
      const m = dmMessages.find(x => x.id === r.message_id);
      if (m && m.sender_id === me().id) {
        m.read_by_other = true;
        drawMessages();
      }
    })
    .subscribe();
}

// ---- typing indicator UI ----
let typingIndicatorTimer = null;
function showTypingIndicator(name) {
  const body = document.getElementById('dm-body');
  if (!body) return;
  let ind = document.getElementById('dm-typing-indicator');
  if (!ind) {
    ind = el('div', { id: 'dm-typing-indicator', class: 'dm-typing' },
      el('div', { class: 'typing-dots' }, el('span'), el('span'), el('span')),
      el('span', { class: 'typing-name' }, ''));
    body.append(ind);
  }
  ind.querySelector('.typing-name').textContent = `${name} is typing…`;
  ind.style.display = 'flex';
  scrollToBottom();
  clearTimeout(typingIndicatorTimer);
  typingIndicatorTimer = setTimeout(hideTypingIndicator, 5000);
}
function hideTypingIndicator() {
  const ind = document.getElementById('dm-typing-indicator');
  if (ind) ind.style.display = 'none';
  clearTimeout(typingIndicatorTimer);
}

// ---- debounced batch read-mark ----
// Delegates to lib/read-receipts.js for centralized queue + multi-tab reconcile.
// Wraps the imported version so call sites (which pass only msgId) keep working
// without having to thread currentConvId through every callsite.
function queueReadMark(msgId) {
  if (!currentConvId || !msgId) return;
  _rr_queueReadMark(currentConvId, msgId);
}

export function cleanupDmRealtime() {
  for (const ref of [realtimeChannel, typingDmChannel, reactionsChannel, readsChannel]) {
    if (ref) {
      try { sb.removeChannel(ref); } catch {}
    }
  }
  realtimeChannel = typingDmChannel = reactionsChannel = readsChannel = null;
  hideTypingIndicator();
  clearTimeout(readMarkTimer);
  clearTimeout(typingIndicatorTimer);
  pendingReadMarks.clear();
  visibleMsgIds = [];
  ownMsgIds.clear();
}