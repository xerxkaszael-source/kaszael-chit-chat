// panels.js — right panel + modals: friends, notifications, pins, search, profile, report
import { rpc, from } from '../lib/db.js';
import { state, me, myLevel, roleLevel, isMemberPlus } from '../lib/state.js';
import { el, ic, toast, modal, confirmModal, relTime, fmtTime } from '../lib/util.js';
import { avatar, badge } from '../lib/avatar.js';

function rightPanel(title, bodyEl) {
  document.querySelector('.right-panel')?.remove();
  document.querySelector('.panel-overlay')?.remove();
  const overlay = el('div', { class: 'panel-overlay on', onclick: close });
  const panel = el('div', { class: 'right-panel on', role: 'dialog', 'aria-label': title },
    el('div', { class: 'rp-head' }, el('h3', {}, title), el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, ic('cross'))),
    el('div', { class: 'rp-body' }, bodyEl));
  function close() { panel.classList.remove('on'); overlay.classList.remove('on'); setTimeout(() => { panel.remove(); overlay.remove(); }, 240); }
  document.body.append(overlay, panel);
  return { panel, close, body: panel.querySelector('.rp-body') };
}

// ---------- FRIENDS ----------
export async function openFriends() {
  if (!isMemberPlus()) { toast('Guests cannot use the friend system.', 'warn'); return; }
  const body = el('div', {});
  const rp = rightPanel('Friends', body);
  await refreshFriends(body);
}

async function refreshFriends(body) {
  body.innerHTML = '<p class="muted">Loading…</p>';
  try {
    const data = await rpc('friends_list');
    state.friends = data;
    body.innerHTML = '';

    const addRow = el('div', { style: 'display:flex;gap:8px;margin-bottom:16px' },
      el('input', { id: 'friend-add-input', placeholder: 'username…', style: 'flex:1;padding:9px 12px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' }),
      el('button', { class: 'btn primary sm', onclick: async (e) => {
        const inp = document.getElementById('friend-add-input');
        try { await rpc('friend_request', { target_username: inp.value.trim() }); toast('Friend request sent', 'ok'); inp.value=''; refreshFriends(body); }
        catch (err) { toast(err.chc?.text || 'Request failed', 'error'); }
      } }, ic('user-add'), 'Add'));
    body.append(addRow);

    section('Requests', data.pending_in.map(f => listRow(
      { display_name: f.display_name, avatar_color: f.avatar_color, avatar_path: f.avatar_path, role: 'member' },
      `@${f.username}`,
      [btn('check', 'Accept', async () => { await rpc('friend_respond', { friendship_id: f.friendship_id, accept: true }); refreshFriends(body); }),
       btn('cross', 'Decline', async () => { await rpc('friend_respond', { friendship_id: f.friendship_id, accept: false }); refreshFriends(body); })]
    )));
    section('Online & friends', data.accepted.map(f => listRow(
      { ...f }, state.presence.get(f.id)?.state === 'online' ? 'online' : `last seen ${relTime(state.presence.get(f.id)?.last_seen || f.joined_at)}`,
      [btn('cross', 'Remove', async () => { if (confirm(`Remove ${f.display_name} from friends?`)) { await rpc('friend_remove', { other_id: f.id }); refreshFriends(body); } }),
       btn('ban', 'Block', async () => { await rpc('friend_block', { other_id: f.id }); toast('Blocked', 'ok'); refreshFriends(body); })]
    ), () => openProfile(f.id)));
    section('Sent requests', data.pending_out.map(f => listRow(
      f, `pending since ${relTime(f.created_at)}`,
      [btn('cross', 'Cancel', async () => { await rpc('friend_remove', { other_id: f.id }); refreshFriends(body); })]
    )));

    function section(title, rows) {
      if (!rows.length) return;
      body.append(el('div', { class: 'side-section-title', style: 'padding-left:0' }, `${title} — ${rows.length}`), ...rows);
    }
    if (!data.pending_in.length && !data.accepted.length && !data.pending_out.length) {
      body.append(el('p', { class: 'muted' }, 'No friends yet. Add someone by username above.'));
    }
  } catch (e) { body.innerHTML = ''; body.append(el('p', { class: 'muted' }, e.chc?.text || 'Failed to load friends.')); }
}

function listRow(profile, sub, actions = [], onClick = null) {
  return el('div', { class: 'list-row', onclick: onClick },
    avatar(profile, { size: 'sm', showPresence: true }),
    el('div', { class: 'lr-main' },
      el('div', { class: 'lr-title' }, profile.display_name || profile.username),
      el('div', { class: 'lr-sub' }, sub)),
    el('div', { class: 'lr-actions' }, ...actions));
}
function btn(iconName, label, onclick) {
  return el('button', { class: 'icon-btn', style: 'width:30px;height:30px;font-size:13px', 'aria-label': label, title: label, onclick: (e) => { e.stopPropagation(); onclick(); } }, ic(iconName));
}

// ---------- NOTIFICATIONS ----------
export async function openNotifications() {
  if (!isMemberPlus()) { toast('Guests have no notifications.', 'warn'); return; }
  const body = el('div', {});
  rightPanel('Notifications', body);
  try {
    const { notifications } = await rpc('notifications_list', { limit_n: 30 });
    body.innerHTML = '';
    if (!notifications.length) { body.append(el('p', { class: 'muted' }, 'Nothing here yet.')); return; }
    const kindIcon = { friend_request: 'user-add', friend_accepted: 'badge-check', mention: 'at', moderation: 'gavel', broadcast: 'megaphone', system: 'info' };
    for (const n of notifications) {
      body.append(el('div', { class: 'list-row', style: n.read ? 'opacity:.55' : '' },
        el('span', { style: 'font-size:18px;color:var(--accent)' }, ic(kindIcon[n.kind] || 'bell')),
        el('div', { class: 'lr-main' },
          el('div', { class: 'lr-title' }, notifTitle(n)),
          el('div', { class: 'lr-sub' }, relTime(n.created_at)))));
    }
    await rpc('notifications_mark_read', { ids: null });
    state.unreadNotifs = 0;
    window.dispatchEvent(new CustomEvent('chc:unread'));
  } catch (e) { body.append(el('p', { class: 'muted' }, 'Failed to load notifications.')); }
}

function notifTitle(n) {
  const who = n.payload?.username ? `@${n.payload.username}` : 'Someone';
  switch (n.kind) {
    case 'friend_request': return `${who} sent you a friend request`;
    case 'friend_accepted': return `${who} accepted your friend request`;
    case 'mention': return `${who} mentioned you`;
    case 'moderation': return `Moderation: ${n.payload?.action || 'action'} ${n.payload?.reason ? '— ' + n.payload.reason : ''}`;
    case 'broadcast': return 'New announcement';
    default: return 'System notification';
  }
}

// ---------- PINS ----------
export async function openPins() {
  const body = el('div', {});
  rightPanel('Pinned messages', body);
  try {
    const { pins } = await rpc('pins_list', { room_id: '00000000-0000-0000-0000-000000000001' });
    body.innerHTML = '';
    if (!pins.length) { body.append(el('p', { class: 'muted' }, 'No pinned messages.')); return; }
    for (const p of pins) {
      body.append(el('div', { class: 'list-row' },
        el('span', { style: 'color:var(--accent)' }, ic('thumbtack')),
        el('div', { class: 'lr-main', onclick: () => window.dispatchEvent(new CustomEvent('chc:scroll-to', { detail: { id: p.message.id } })) },
          el('div', { class: 'lr-title' }, state.profiles.get(p.message.sender_id)?.display_name || 'User'),
          el('div', { class: 'lr-sub' }, p.message.content?.slice(0, 100) || '(attachment)')),
        myLevel() >= 40 ? btn('cross', 'Unpin', async () => { try { await rpc('message_unpin', { message_id: p.message.id }); openPins(); } catch (e) { toast(e.chc?.text || 'Unpin failed', 'error'); } }) : null));
    }
  } catch { body.append(el('p', { class: 'muted' }, 'Failed to load pins.')); }
}

// ---------- SEARCH ----------
export function openSearch() {
  const input = el('input', { placeholder: 'Search messages…', style: 'width:100%;padding:10px 13px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' });
  const results = el('div', { style: 'margin-top:12px' });
  const rp = rightPanel('Search', el('div', {}, input, results));
  let timer;
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = input.value.trim();
      if (q.length < 2) { results.innerHTML = ''; return; }
      results.innerHTML = '<p class="muted">Searching…</p>';
      try {
        const { messages } = await rpc('search_messages', { q, limit_n: 20 });
        results.innerHTML = '';
        if (!messages.length) { results.append(el('p', { class: 'muted' }, 'No results.')); return; }
        for (const m of messages) {
          results.append(el('div', { class: 'list-row', onclick: () => window.dispatchEvent(new CustomEvent('chc:scroll-to', { detail: { id: m.id } })) },
            avatar({ display_name: m.sender_display_name, avatar_color: '#6c8cff' }, { size: 'sm' }),
            el('div', { class: 'lr-main' },
              el('div', { class: 'lr-title' }, m.sender_display_name),
              el('div', { class: 'lr-sub' }, m.content?.slice(0, 120)))));
        }
      } catch (e) { results.innerHTML = ''; results.append(el('p', { class: 'muted' }, e.chc?.text || 'Search failed.')); }
    }, 400);
  });
  setTimeout(() => input.focus(), 250);
}

// ---------- PROFILE (self or other) ----------
export async function openProfile(userId) {
  const self = userId === me().id;
  let prof = state.profiles.get(userId);
  const body = el('div', {});
  const rp = rightPanel(self ? 'My profile' : 'Profile', body);
  try {
    prof = (await rpc('user_public', { target_id: userId }));
    if (!prof?.id) { body.append(el('p', { class: 'muted' }, 'User not found.')); return; }
    state.profiles.set(userId, prof);
    const pres = state.presence.get(userId);
    body.append(
      el('div', { style: 'display:flex;flex-direction:column;align-items:center;gap:8px;margin-bottom:14px' },
        avatar(prof, { size: 'lg', showPresence: true }),
        el('div', { style: 'font-size:1.15rem;font-weight:800' }, prof.display_name),
        el('div', { class: 'muted' }, '@' + prof.username),
        badge(prof.role),
        el('div', { class: 'muted', style: 'font-size:.75rem' },
          pres?.state === 'online' ? 'Online now' : pres?.last_seen ? `Last seen ${relTime(pres.last_seen)}` : '',
          ' · joined ' + new Date(prof.created_at).toLocaleDateString())));
    if (prof.bio) body.append(el('p', { style: 'font-size:.88rem;color:var(--text-2);margin-bottom:14px' }, prof.bio));

    if (self) {
      body.append(editProfileForm(prof, rp));
    } else if (isMemberPlus() && !prof.is_guest) {
      // Hide user-action buttons when viewing staff (owner/admin).
      // Server-side already rejects (migration 009), but UI shouldn't even show them.
      const isStaff = prof.role === 'owner' || prof.role === 'admin';
      // Friend-status aware action row (migration 022 added friend_status to user_public).
      // 'none'      → Add friend
      // 'pending_out' → Cancel request
      // 'pending_in'  → Accept / Decline
      // 'accepted'    → Message + Unfriend
      // 'blocked_by_me' / 'blocks_me' → no friend actions
      const fs = prof.friend_status || 'none';
      const fId = prof.friendship_id;
      const actionRow = el('div', { style: 'display:flex;gap:8px;flex-wrap:wrap' });
      // helper that re-renders this profile without closing the panel
      const rebuild = async () => {
        const fresh = await rpc('user_public', { target_id: userId });
        const pres2 = state.presence.get(userId);
        rp.panel.querySelector('.rp-body').innerHTML = '';
        const newBody = renderProfileBody(fresh, pres2);
        rp.panel.querySelector('.rp-body').append(newBody);
      };

      if (fs === 'none') {
        actionRow.append(el('button', { class: 'btn sm primary', onclick: async () => {
          try { await rpc('friend_request', { target_username: prof.username }); toast('Friend request sent', 'ok'); await rebuild(); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('user-add'), 'Add friend'));
      } else if (fs === 'pending_out') {
        // Cancel pending request I sent — no dedicated RPC; treat as friend_remove while pending.
        actionRow.append(el('button', { class: 'btn sm ghost', onclick: async () => {
          if (!fId) return;
          try {
            // No "friend_cancel" RPC; use friend_remove (works on pending too) via direct delete via service is forbidden — instead, surface a hint.
            await rpc('friend_remove', { other_id: prof.id });
            toast('Friend request cancelled', 'ok');
            await rebuild();
          } catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('cross'), 'Cancel request'));
      } else if (fs === 'pending_in') {
        actionRow.append(el('button', { class: 'btn sm primary', onclick: async () => {
          if (!fId) return;
          try { await rpc('friend_respond', { friendship_id: fId, accept: true }); toast('Friend request accepted', 'ok'); await rebuild(); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('check'), 'Accept'));
        actionRow.append(el('button', { class: 'btn sm ghost', onclick: async () => {
          if (!fId) return;
          try { await rpc('friend_respond', { friendship_id: fId, accept: false }); toast('Friend request declined', 'ok'); await rebuild(); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('cross'), 'Decline'));
      } else if (fs === 'accepted') {
        actionRow.append(el('button', { class: 'btn sm primary', onclick: async () => {
          rp.close();
          // openDm is in dm.js — use hash navigation; dm.js auto-opens from route
          location.hash = '/dm/' + prof.id;
        } }, ic('envelope'), 'Message'));
        actionRow.append(el('button', { class: 'btn sm ghost', onclick: async () => {
          if (!await confirmModal({ title: 'Unfriend ' + prof.display_name + '?', text: 'They will be removed from your friends list. You can send a new request later.', confirmLabel: 'Unfriend', danger: true })) return;
          try { await rpc('friend_remove', { other_id: prof.id }); toast('Unfriended', 'ok'); await rebuild(); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('user-times'), 'Unfriend'));
      }
      // If blocked, no friend actions — Block/Report row below still available.

      if (!isStaff) {
        actionRow.append(el('button', { class: 'btn sm ghost', onclick: async () => {
          try { await rpc('friend_block', { other_id: prof.id }); toast('Blocked', 'ok'); rp.close(); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, ic('ban'), 'Block'));
        actionRow.append(el('button', { class: 'btn sm ghost', onclick: () => openReportModal({ target_user_id: prof.id }) }, ic('triangle-warning'), 'Report'));
      }
      body.append(actionRow);
    }
  } catch (e) { body.append(el('p', { class: 'muted' }, 'Failed to load profile.')); }
}

function editProfileForm(prof, rp) {
  const dn = el('input', { value: prof.display_name, maxlength: 40 });
  const bio = el('textarea', { rows: 3, maxlength: 300 }, prof.bio || '');
  const fileIn = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', class: 'hidden' });
  const prev = el('img', { style: 'max-width:96px;max-height:96px;border-radius:12px;display:none', alt: 'avatar preview' });
  let pickedFile = null;
  fileIn.addEventListener('change', () => {
    const f = fileIn.files[0];
    if (!f) return;
    if (!['image/png', 'image/jpeg', 'image/webp'].includes(f.type)) { toast('PNG, JPG or WebP only.', 'error'); return; }
    if (f.size > 5242880) { toast('Avatar max 5 MB.', 'error'); return; }
    pickedFile = f;
    prev.src = URL.createObjectURL(f);
    prev.style.display = 'block';
  });
  const save = el('button', { class: 'btn primary full', onclick: async () => {
    save.disabled = true;
    try {
      let avatarPath = null;
      if (pickedFile) {
        const { uploadToStorage } = await import('../lib/db.js');
        const path = `${prof.id}/avatar-${Date.now()}`;
        await uploadToStorage('avatars', path, pickedFile);
        avatarPath = path;
      }
      await rpc('profile_update', {
        display_name_input: dn.value.trim() || null,
        bio_input: bio.value,
        avatar_path_input: avatarPath
      });
      toast('Profile saved', 'ok');
      rp.close();
      setTimeout(() => location.reload(), 600); // refresh avatar everywhere
    } catch (e) { toast(e.chc?.text || 'Save failed', 'error'); save.disabled = false; }
  } }, 'Save changes');
  return el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Display name'), dn),
    el('div', { class: 'field' }, el('label', {}, 'Bio'), bio),
    el('div', { class: 'field' }, el('label', {}, 'Avatar (PNG/JPG/WebP, ≤5MB)'),
      el('button', { class: 'btn sm ghost', onclick: () => fileIn.click() }, ic('image-slash'), 'Choose image'), fileIn,
      el('div', { style: 'margin-top:8px' }, prev)),
    save);
}

// ---------- SETTINGS ----------
export async function openSettings() {
  if (!isMemberPlus()) { toast('Guests have no settings.', 'warn'); return; }
  let s = state.settings || { appearance: 'system', enter_to_send: true, compact_mode: false, timestamps_24h: true, notify_friend: true, notify_mention: true, notify_moderation: true, sound_enabled: true };
  const { setMode, getStoredMode } = await import('../lib/themes.js');
  const { setSoundEnabled } = await import('../lib/sound.js');
  const sel = (val, opts) => { const e = el('select', {}, opts.map(o => el('option', { value: o, selected: val === o || null }, o))); e.value = val; return e; };
  const chk = (label, val) => el('label', { style: 'display:flex;align-items:center;gap:10px;padding:8px 0;font-size:.9rem' },
    el('input', { type: 'checkbox', checked: val || null, style: 'width:auto' }), el('span', {}, label));

  const appearance = sel(s.appearance, ['system', 'dark', 'light']);
  const enterToSend = chk('Enter to send (Shift+Enter = newline)', s.enter_to_send);
  const compact = chk('Compact mode', s.compact_mode);
  const ts24 = chk('24-hour timestamps', s.timestamps_24h);
  const nFriend = chk('Notify: friend requests', s.notify_friend);
  const nMention = chk('Notify: mentions', s.notify_mention);
  const nMod = chk('Notify: moderation actions', s.notify_moderation);
  const nSound = chk('Sound on new message', s.sound_enabled !== false);

  const save = el('button', { class: 'btn primary full', onclick: async () => {
    save.disabled = true;
    try {
      const upd = await rpc('settings_update', {
        appearance_input: appearance.value,
        enter_to_send_input: enterToSend.querySelector('input').checked,
        compact_input: compact.querySelector('input').checked,
        ts24_input: ts24.querySelector('input').checked,
        notify_friend_input: nFriend.querySelector('input').checked,
        notify_mention_input: nMention.querySelector('input').checked,
        notify_moderation_input: nMod.querySelector('input').checked,
        sound_enabled_input: nSound.querySelector('input').checked
      });
      state.settings = upd;
      setMode(appearance.value);
      setSoundEnabled(nSound.querySelector('input').checked);
      document.documentElement.classList.toggle('compact', upd.compact_mode);
      toast('Settings saved', 'ok');
      m.close();
    } catch (e) { toast(e.chc?.text || 'Save failed', 'error'); save.disabled = false; }
  } }, 'Save settings');

  const m = modal({
    title: 'Settings',
    body: el('div', {},
      el('div', { class: 'side-section-title', style: 'padding-left:0' }, 'Appearance'),
      el('div', { class: 'field' }, el('label', {}, 'Theme mode'), appearance,
        el('div', { class: 'hint' }, 'Pick colors in the Theme panel (top bar).')),
      el('div', { class: 'side-section-title', style: 'padding-left:0' }, 'Chat'),
      enterToSend, compact, ts24,
      el('div', { class: 'side-section-title', style: 'padding-left:0' }, 'Notifications'),
      nFriend, nMention, nMod, nSound),
    foot: [el('button', { class: 'btn ghost' }, 'Cancel'), save]
  });
  m.node.querySelectorAll('.modal-foot .btn')[0].addEventListener('click', () => m.close());
}

// ---------- THEME PICKER (30 themes) ----------
export async function openThemePicker() {
  const { THEMES, setTheme, getStoredTheme, setMode, getStoredMode } = await import('../lib/themes.js');
  const grid = el('div', { class: 'theme-grid' });
  for (const [id, name, base, a, a2] of THEMES) {
    grid.append(el('button', {
      class: `theme-swatch${id === getStoredTheme() ? ' active' : ''}`,
      'data-theme-id': id,
      onclick: () => {
        setTheme(id);
        grid.querySelectorAll('.theme-swatch').forEach(s => s.classList.toggle('active', s.dataset.themeId === id));
      }
    },
      el('div', { class: 'ts-colors' },
        el('span', { style: `background:${base === 'dark' ? '#12161f' : '#ffffff'};border:1px solid #8884` }),
        el('span', { style: `background:${a}` }),
        el('span', { style: `background:${a2}` })),
      el('div', { class: 'ts-name' }, name),
      el('div', { class: 'muted', style: 'font-size:.6rem' }, base)));
  }
  const modeSel = el('select', { style: 'width:100%;padding:9px 12px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' },
    ['system', 'dark', 'light'].map(o => el('option', { value: o }, o === 'system' ? 'Follow system' : o)));
  modeSel.value = getStoredMode();
  modeSel.addEventListener('change', () => setMode(modeSel.value));

  const body = el('div', {},
    el('div', { class: 'field' }, el('label', {}, 'Mode'), modeSel),
    el('div', { class: 'hint', style: 'margin-bottom:12px' }, 'Every theme recolors the whole interface — including chat bubbles.'),
    grid);
  const rp = rightPanel('Theme — 30 styles', body);
}

// ---------- REPORT ----------
export function openReportModal({ message_id = null, target_user_id = null }) {
  const cats = ['spam', 'harassment', 'abuse', 'inappropriate', 'impersonation', 'malicious', 'other'];
  const sel = el('select', {}, cats.map(c => el('option', { value: c }, c)));
  const reason = el('textarea', { rows: 3, maxlength: 1000, placeholder: 'Details (optional)' });
  modal({
    title: 'Report',
    body: el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Category'), sel),
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason)),
    foot: [
      el('button', { class: 'btn ghost', onclick: (e) => e.target.closest('.modal-backdrop').remove() }, 'Cancel'),
      el('button', { class: 'btn danger', onclick: async (e) => {
        try {
          await rpc('report_submit', { message_id, target_user_id, category_input: sel.value, reason_input: reason.value });
          toast('Report submitted. Thank you.', 'ok');
          e.target.closest('.modal-backdrop').remove();
        } catch (err) { toast(err.chc?.text || 'Report failed', 'error'); }
      } }, 'Submit report')
    ]
  });
}
