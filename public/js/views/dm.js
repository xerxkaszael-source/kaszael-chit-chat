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
  markDmRead,
  toggleDmReaction,
  fetchDmReactions,
  getDraft,
  setDraft
} from '../lib/dm.js';
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
let draftSaveTimer = null;
let replyToMsg = null;
let editingMsg = null;

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

  // fetch other user profile
  const { data: profs } = await sb.from('profiles').select('*').eq('id', otherId).maybeSingle();
  currentOtherProfile = profs || { id: otherId, username: 'unknown', display_name: 'Unknown', avatar_color: '#888' };
  state.profiles.set(otherId, currentOtherProfile);

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
  // mark read
  if (dmMessages.length > 0) {
    markDmRead(currentConvId, dmMessages[dmMessages.length - 1].id).catch(() => {});
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
  const wrap = el('div', { class: `dm-msg ${mine ? 'mine' : 'theirs'}` });
  wrap.append(avatar({ id: m.sender_id, username: m.sender_username, display_name: m.sender_display_name, avatar_color: m.sender_avatar_color }, { size: 'xs' }));
  wrap.append(el('div', { class: 'dm-bubble' },
    el('div', { class: 'dm-text', html: richText(m.content) }),
    el('div', { class: 'dm-meta' },
      el('span', { class: 'dm-time' }, fmtTime(m.created_at)),
      m.edited_at ? el('span', { class: 'dm-edited' }, '(edited)') : null,
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
  drawMessages().then(scrollToBottom);

  try {
    const r = await sendDmMessage(currentConvId, content, clientMsgId, replyToMsg?.id || null);
    replyToMsg = null;
    updateComposerHints();
    // replace optimistic with real
    const idx = dmMessages.findIndex(m => m.id === clientMsgId);
    if (idx >= 0) dmMessages[idx].id = r.message_id;
    drawMessages().then(scrollToBottom);
  } catch (e) {
    // mark failed
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

function subscribeRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
  realtimeChannel = sb.channel(`dm:${currentConvId}`)
    .on('postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'direct_messages', filter: `conversation_id=eq.${currentConvId}` },
      payload => {
        const m = payload.new;
        if (dmMessages.some(x => x.id === m.id)) return; // already have (from optimistic)
        // hydrate
        dmMessages.push({ ...m, sender_username: '?', sender_display_name: '?', sender_avatar_color: '#888' });
        drawMessages().then(scrollToBottom);
        // mark read since user is viewing
        markDmRead(currentConvId, m.id).catch(() => {});
      })
    .subscribe();
}

export function cleanupDmRealtime() {
  if (realtimeChannel) {
    sb.removeChannel(realtimeChannel);
    realtimeChannel = null;
  }
}