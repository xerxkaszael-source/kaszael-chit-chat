// composer.js — message input: send, reply, edit, uploads, typing, @mentions
import { rpc, from, uploadToStorage, GENERAL_ROOM } from '../lib/db.js';
import { state, me } from '../lib/state.js';
import { el, ic, toast, uuid, debounce } from '../lib/util.js';
import { announceTyping } from '../lib/realtime.js';

const IMG_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];
const FILE_TYPES = ['application/pdf', 'text/plain', 'application/zip'];
const MAX_MB = 8;

export function renderComposer() {
  const wrap = el('div', { class: 'composer' });

  // reply bar
  const replyBar = el('div', { class: 'reply-bar' });
  const replyText = el('span', { class: 'rb-text' });
  replyBar.append(ic('auto-reply'), replyText, el('button', { 'aria-label': 'Cancel reply', onclick: () => setReply(null) }, ic('cross-small')));

  // attachment previews
  const attachPrev = el('div', { class: 'attach-preview' });

  // input
  const input = el('textarea', { class: 'composer-input', rows: 1, placeholder: state.isGuest ? 'Say something…' : 'Message General…', 'aria-label': 'Message input' });
  const emojiBtn = el('button', { class: 'icon-btn', 'aria-label': 'Emoji', title: 'Emoji' }, ic('smile-beam'));
  emojiBtn.addEventListener('click', () => openEmoji(input));

  let fileBtn = null;
  const fileInput = el('input', { type: 'file', class: 'hidden', multiple: '' });
  if (!state.isGuest) {
    fileBtn = el('button', { class: 'icon-btn', 'aria-label': 'Attach image or file', title: 'Attach' }, ic('paperclip-vertical'));
    fileBtn.addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => handleFiles([...fileInput.files]));
  }

  const sendBtn = el('button', { class: 'send-btn', 'aria-label': 'Send', disabled: '' }, ic('paper-plane-top'));
  sendBtn.addEventListener('click', () => send());

  const inputWrap = el('div', { class: 'composer-input-wrap' },
    fileBtn, input, emojiBtn);

  wrap.append(replyBar, attachPrev,
    el('div', { class: 'composer-row' }, inputWrap, sendBtn));

  // ---- behaviors ----
  input.addEventListener('input', () => {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    updateSendState();
    announceTyping();
    mentionAutocomplete(input);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && state.settings?.enter_to_send !== false) {
      e.preventDefault(); send();
    } else if (e.key === 'Escape') {
      setReply(null); cancelEdit();
    }
  });

  function updateSendState() {
    sendBtn.disabled = !input.value.trim() && state.pendingUploads.length === 0;
  }

  // ---- reply/edit hooks from message actions ----
  window.addEventListener('chc:reply', () => {
    cancelEdit();
    setReply(state.replyTo);
    input.focus();
  });
  window.addEventListener('chc:edit', () => {
    setReply(null);
    if (!state.editing) return;
    input.value = state.editing.content;
    input.style.height = 'auto';
    input.style.height = input.scrollHeight + 'px';
    wrap.classList.add('editing');
    sendBtn.innerHTML = ''; sendBtn.append(ic('check'));
    input.focus();
    updateSendState();
  });

  function setReply(msg) {
    state.replyTo = msg;
    replyBar.classList.toggle('on', !!msg);
    if (msg) replyText.textContent = `Replying to ${state.profiles.get(msg.sender_id)?.display_name || 'user'}: ${msg.content?.slice(0, 80) || '(attachment)'}`;
  }
  function cancelEdit() {
    if (!state.editing) return;
    state.editing = null;
    wrap.classList.remove('editing');
    input.value = '';
    sendBtn.innerHTML = ''; sendBtn.append(ic('paper-plane-top'));
    updateSendState();
  }

  // ---- uploads ----
  async function handleFiles(files) {
    fileInput.value = '';
    if (state.isGuest) { toast('Guests cannot upload files.', 'warn'); return; }
    for (const f of files) {
      if (state.pendingUploads.length >= 3) { toast('Max 3 attachments per message.', 'warn'); break; }
      const isImg = IMG_TYPES.includes(f.type);
      const isFile = FILE_TYPES.includes(f.type);
      if (!isImg && !isFile) { toast(`${f.name}: file type not allowed.`, 'error'); continue; }
      if (f.size > MAX_MB * 1048576) { toast(`${f.name}: exceeds ${MAX_MB} MB limit.`, 'error'); continue; }
      const path = `${me().id}/${uuid()}-${f.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      try {
        toast(`Uploading ${f.name}…`, 'info', 1800);
        await uploadToStorage(isImg ? 'chat-images' : 'chat-files', path, f);
        state.pendingUploads.push({
          file: f, path, bucket: isImg ? 'chat-images' : 'chat-files',
          kind: isImg ? 'image' : 'file', preview: isImg ? URL.createObjectURL(f) : null
        });
        drawPreviews(); updateSendState();
      } catch (e) {
        toast(e.chc?.text || `Upload failed for ${f.name}`, 'error');
      }
    }
  }

  function drawPreviews() {
    attachPrev.innerHTML = '';
    attachPrev.classList.toggle('on', state.pendingUploads.length > 0);
    state.pendingUploads.forEach((u, i) => {
      const item = el('div', { class: 'ap-item' });
      if (u.preview) item.append(el('img', { src: u.preview, alt: u.file.name }));
      else item.append(el('div', { class: 'msg-file', style: 'margin:0' }, ic('file'), el('span', { class: 'mf-name' }, u.file.name)));
      item.append(el('button', { class: 'ap-remove', 'aria-label': 'Remove', onclick: () => { state.pendingUploads.splice(i, 1); drawPreviews(); updateSendState(); } }, ic('cross-small')));
      attachPrev.append(item);
    });
  }

  // ---- send ----
  async function send() {
    const content = input.value.trim();
    if (!content && state.pendingUploads.length === 0) return;

    // edit mode
    if (state.editing) {
      const id = state.editing.id;
      cancelEdit();
      try {
        const updated = await rpc('message_edit', { message_id: id, new_content: content });
        Object.assign(state.messages.find(m => m.id === id) || {}, updated);
        window.dispatchEvent(new CustomEvent('chc:message-updated', { detail: id }));
      } catch (e) { toast(e.chc?.text || 'Edit failed', 'error'); input.value = content; }
      return;
    }

    const clientMsgId = uuid();
    sendBtn.disabled = true;
    try {
      // register attachments first (message_id null), then attach on send
      const attIds = [];
      for (const u of state.pendingUploads) {
        const { id } = await rpc('attachment_register', {
          message_id: null,
          bucket_name: u.bucket,
          storage_path: u.path,
          filename_input: u.file.name,
          mime_input: u.file.type,
          size_bytes_input: u.file.size,
          kind_input: u.kind
        });
        attIds.push(id);
      }
      const msg = await rpc('message_send', {
        room_id: GENERAL_ROOM,
        content,
        client_msg_id: clientMsgId,
        reply_to: state.replyTo?.id || null,
        attachment_ids: attIds.length ? attIds : null
      });
      input.value = ''; input.style.height = 'auto';
      state.replyTo = null; replyBar.classList.remove('on');
      state.pendingUploads = []; drawPreviews();
      updateSendState();
      input.focus();
      // realtime INSERT will dedupe via client_msg_id; insert now for snappy UX
      if (!state.messages.some(m => m.id === msg.id)) state.messages.push(msg);
      if (attIds.length) {
        const { data: atts } = await from('message_attachments').select('*').in('id', attIds);
        state.attachments.set(msg.id, atts || []);
      }
      window.dispatchEvent(new CustomEvent('chc:message-updated'));
    } catch (e) {
      sendBtn.disabled = false;
      toast(e.chc?.text || 'Message failed to send', 'error');
    }
  }

  return wrap;
}

// ---- emoji quick picker ----
const QUICK_EMOJI = ['😀','😂','😊','😍','🤔','👍','🙏','🔥','🎉','❤️','😢','😮'];
function openEmoji(input) {
  const pop = document.createElement('div');
  pop.className = 'modal-backdrop';
  const panel = el('div', { class: 'modal', style: 'max-width:320px' },
    el('div', { class: 'modal-body', style: 'display:flex;flex-wrap:wrap;gap:6px;font-size:1.5rem' },
      QUICK_EMOJI.map(e => el('button', { style: 'padding:6px;border-radius:8px;font-size:1.4rem', onclick: () => {
        input.value += e; input.dispatchEvent(new Event('input')); pop.remove(); input.focus();
      } }, e))));
  pop.addEventListener('click', (ev) => { if (ev.target === pop) pop.remove(); });
  pop.append(panel);
  document.getElementById('modals').append(pop);
}

// ---- @mention autocomplete ----
function mentionAutocomplete(input) {
  const val = input.value.slice(0, input.selectionStart);
  const m = val.match(/@([a-z0-9_]*)$/i);
  document.querySelector('.mention-pop')?.remove();
  if (!m || m[1].length < 1) return;
  const q = m[1].toLowerCase();
  const matches = [...state.profiles.values()]
    .filter(p => !p.is_guest && p.username.startsWith(q))
    .slice(0, 6);
  if (!matches.length) return;
  const pop = el('div', { class: 'mention-pop', style: 'position:absolute;z-index:50;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;box-shadow:var(--shadow-2);overflow:hidden' },
    matches.map(p => el('button', { class: 'list-row', onclick: () => {
      input.value = val.slice(0, val.length - m[1].length) + p.username + ' ' + input.value.slice(input.selectionStart);
      input.dispatchEvent(new Event('input')); pop.remove(); input.focus();
    } }, el('span', { class: 'lr-title' }, '@' + p.username), el('span', { class: 'muted' }, p.display_name))));
  const wrap = input.closest('.composer');
  wrap.style.position = 'relative';
  pop.style.bottom = (input.offsetHeight + 56) + 'px';
  pop.style.left = '14px';
  wrap.append(pop);
  setTimeout(() => pop.remove(), 4000);
}
