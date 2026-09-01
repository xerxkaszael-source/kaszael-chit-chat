// message.js — render one message row (bubbles, attachments, reactions, actions)
import { state, me, canModerate, canAdmin, profileOf } from '../lib/state.js';
import { el, ic, esc, richText, fmtTime, fmtBytes, copyText, toast, uuid } from '../lib/util.js';
import { avatar, badge } from '../lib/avatar.js';
import { rpc, storagePublicUrl } from '../lib/db.js';
import { modal } from '../lib/util.js';
import { openProfile } from './panels.js';

const REACTION_SET = ['👍', '❤️', '😂', '😮', '😢', '🔥', '👏', '🎉'];

export function renderMessageRow(msg) {
  const own = msg.sender_id === me()?.id;
  const sender = profileOf(msg.sender_id) || { display_name: 'Unknown', role: 'member', avatar_color: '#555' };
  const row = el('div', { class: `msg-row${own ? ' own' : ''}`, id: `msg-${msg.id}` });

  const av = avatar(sender, {});
  av.style.cursor = 'pointer';
  av.addEventListener('click', () => openProfile(sender.id));

  const body = el('div', { class: 'msg-body' });

  // head: name + badge + time
  const head = el('div', { class: 'msg-head' },
    el('span', { class: 'msg-name' }, sender.display_name),
    badge(sender.role),
    el('span', { class: 'msg-time', title: new Date(msg.created_at).toLocaleString() }, fmtTime(msg.created_at, state.settings?.timestamps_24h !== false)),
    msg.edited_at ? el('span', { class: 'msg-edited' }, 'edited') : null);

  // reply quote
  if (msg.reply_to) {
    const orig = state.messages.find(m => m.id === msg.reply_to);
    const q = orig
      ? el('div', { class: 'reply-quote', onclick: () => scrollToMessage(orig.id) },
          el('span', { class: 'rq-name' }, profileOf(orig.sender_id)?.display_name || 'User'),
          el('span', { class: 'rq-text' }, orig.content?.slice(0, 90) || '(attachment)'))
      : el('div', { class: 'reply-quote' }, el('span', { class: 'rq-text' }, 'Original message unavailable'));
    body.append(q);
  }

  body.append(head, renderBubble(msg));

  // attachments
  const atts = state.attachments.get(msg.id) || [];
  for (const a of atts) body.append(renderAttachment(a));

  // reactions row
  body.append(renderReactions(msg));

  row.append(...(own ? [body, av] : [av, body]));

  row.append(renderActions(msg, own));
  return row;
}

function renderBubble(msg) {
  if (msg.moderation_state === 'recalled') {
    return el('div', { class: 'bubble recalled' }, 'This message was recalled by a moderator.');
  }
  if (msg.moderation_state === 'deleted') {
    return el('div', { class: 'bubble deleted' }, 'This message was deleted.');
  }
  const b = el('div', { class: 'bubble' });
  b.innerHTML = richText(msg.content); // richText escapes first
  return b;
}

function renderAttachment(a) {
  const url = storagePublicUrl(a.bucket, a.storage_path);
  if (a.kind === 'image') {
    const img = el('img', { class: 'msg-img', src: url, alt: a.filename, loading: 'lazy',
      onclick: () => openLightbox(url, a.filename) });
    return img;
  }
  return el('a', { class: 'msg-file', href: url, target: '_blank', rel: 'noopener', download: a.filename },
    ic('file'),
    el('span', { class: 'mf-name' }, a.filename),
    el('span', { class: 'mf-size' }, fmtBytes(Number(a.size_bytes))));
}

function openLightbox(url, name) {
  modal({
    title: name || 'Image',
    wide: true,
    body: el('div', {}, el('img', { src: url, style: 'max-width:100%;border-radius:10px', alt: name })),
  });
}

function renderReactions(msg) {
  const wrap = el('div', { class: 'reactions-row' });
  const rs = state.reactions.get(msg.id) || [];
  const byEmoji = new Map();
  for (const r of rs) {
    if (!byEmoji.has(r.emoji)) byEmoji.set(r.emoji, []);
    byEmoji.get(r.emoji).push(r.user_id);
  }
  for (const [emoji, users] of byEmoji) {
    const mine = users.includes(me()?.id);
    wrap.append(el('button', {
      class: `reaction-chip${mine ? ' mine' : ''}`,
      title: users.map(u => profileOf(u)?.display_name || '?').join(', '),
      onclick: () => toggleReaction(msg.id, emoji)
    }, el('span', {}, emoji), el('span', { class: 'rc-count' }, String(users.length))));
  }
  return wrap;
}

export async function toggleReaction(msgId, emoji) {
  try { await rpc('reaction_toggle', { message_id: msgId, emoji }); }
  catch (e) { toast(e.chc?.text || 'Reaction failed', 'error'); }
}

// ---------- hover actions ----------
function renderActions(msg, own) {
  if (msg.moderation_state !== 'visible') return el('div', { class: 'msg-actions hidden' });
  const acts = el('div', { class: 'msg-actions', role: 'toolbar', 'aria-label': 'Message actions' });

  acts.append(actBtn('smile-beam', 'React', () => openReactionPicker(msg)));
  acts.append(actBtn('auto-reply', 'Reply', () => { state.replyTo = msg; window.dispatchEvent(new CustomEvent('chc:reply')); }));
  if (!state.isGuest) acts.append(actBtn('copy', 'Copy', () => { copyText(msg.content); toast('Copied', 'ok', 1400); }));
  if (own && !state.isGuest) {
    acts.append(actBtn('pencil-paintbrush', 'Edit', () => { state.editing = msg; window.dispatchEvent(new CustomEvent('chc:edit')); }));
    acts.append(actBtn('trash', 'Delete', () => deleteOwn(msg)));
  }
  acts.append(actBtn('triangle-warning', 'Report', () => openReport(msg)));
  if (canModerate()) acts.append(actBtn('rotate-left', 'Recall', () => recallMsg(msg)));
  if (canAdmin()) {
    acts.append(actBtn('thumbtack', 'Pin', async () => {
      try { await rpc('message_pin', { message_id: msg.id }); toast('Pinned', 'ok', 1400); }
      catch (e) { toast(e.chc?.text || 'Pin failed', 'error'); }
    }));
  }
  return acts;
}

function actBtn(iconName, label, onclick) {
  return el('button', { 'aria-label': label, title: label, onclick }, ic(iconName));
}

function openReactionPicker(msg) {
  const m = modal({
    title: 'Add reaction',
    body: el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap;font-size:1.6rem' },
      REACTION_SET.map(e => el('button', {
        style: 'font-size:1.6rem;padding:6px;border-radius:10px',
        'aria-label': `react ${e}`,
        onclick: async () => { m.close(); await toggleReaction(msg.id, e); }
      }, e)))
  });
}

async function deleteOwn(msg) {
  try {
    await rpc('message_delete_own', { message_id: msg.id });
  } catch (e) { toast(e.chc?.text || 'Delete failed', 'error'); }
}

async function recallMsg(msg) {
  const reason = window.prompt('Recall reason (optional):') || '';
  try {
    await rpc('message_recall', { message_id: msg.id, reason });
    toast('Message recalled', 'ok', 1500);
  } catch (e) { toast(e.chc?.text || 'Recall failed', 'error'); }
}

function openReport(msg) {
  import('./panels.js').then(({ openReportModal }) => openReportModal({ message_id: msg.id, target_user_id: msg.sender_id }));
}

export function scrollToMessage(id) {
  const node = document.getElementById(`msg-${id}`);
  if (node) {
    node.scrollIntoView({ behavior: 'smooth', block: 'center' });
    node.style.outline = '2px solid var(--accent)';
    setTimeout(() => node.style.outline = '', 1200);
  }
}
