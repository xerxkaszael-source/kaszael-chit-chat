// admin.js — staff area: moderation, broadcast, admin, audit, owner center, system
import { rpc } from '../lib/db.js';
import { state, me, myLevel, canModerate, canAdmin, isOwner } from '../lib/state.js';
import { el, ic, toast, modal, confirmModal, relTime } from '../lib/util.js';
import { avatar, badge } from '../lib/avatar.js';
import { renderShell } from './shell.js';
import { adminView, ownerView, auditView, systemView } from './admin2.js';

const sections = [];

export function renderAdmin(root, view, sub = null) {
  if (state.isGuest) { location.hash = '/chat'; return; }
  if (['owner', 'system', 'audit'].includes(view) && !isOwner()) { location.hash = '/chat'; return; }
  if (view === 'admin' && !canAdmin()) { location.hash = '/chat'; return; }
  if (view === 'moderation' && !canModerate()) { location.hash = '/chat'; return; }

  root.innerHTML = '';
  const side = el('nav', { class: 'admin-side' },
    ...navItems(view));
  const main = el('div', { class: 'admin-main', id: 'admin-main' });
  root.append(el('div', { class: 'app' },
    el('header', { class: 'topbar' },
      el('button', { class: 'icon-btn', 'aria-label': 'Back to chat', onclick: () => { location.hash = '/chat'; } }, ic('arrow-left')),
      el('div', { class: 'brand' }, el('span', { class: 'brand-mark' }, ic('shield-check')), el('span', {}, 'Staff area')),
      el('div', { class: 'topbar-spacer' }),
      el('span', { class: 'muted' }, `${me().display_name} · ${me().role}`)),
    el('div', { class: 'admin-shell' }, side, main)));
  routeAdmin(view, main, sub);
}

function navItems(active) {
  const items = [];
  const add = (v, icon, label) => items.push(
    el('button', { class: `side-item${v === active ? ' active' : ''}`, onclick: () => location.hash = '/' + v }, ic(icon), el('span', {}, label)));
  if (canModerate()) add('moderation', 'gavel', 'Moderation');
  if (canAdmin()) { add('broadcast', 'megaphone', 'Broadcast'); add('admin', 'chart-mixed', 'Admin'); }
  if (isOwner()) { add('owner', 'crown', 'Owner Center'); add('audit', 'list-check', 'Audit'); add('system', 'triangle-warning', 'System'); }
  add('chat', 'comment', 'Back to chat');
  return items;
}

function routeAdmin(view, main, sub = null) {
  main.innerHTML = '';
  if (view === 'moderation') moderationView(main, sub);
  else if (view === 'broadcast') broadcastView(main);
  else if (view === 'admin') adminView(main);
  else if (view === 'owner') ownerView(main, sub);
  else if (view === 'audit') auditView(main);
  else if (view === 'system') systemView(main);
}

// ================= MODERATION =================
async function moderationView(main, sub = null) {
  main.append(el('h2', {}, 'Moderation'));
  // Single content container — every tab swaps its content in place to prevent
  // the "stacked duplicate headers" bug where each click appended a new holder.
  const content = el('div', { class: 'mod-content' });
  main.append(content);

  // Allowed sub-tabs; anything outside this set falls back to 'reports'.
  const validTabs = ['reports', 'states', 'lookup'];
  let active = validTabs.includes(sub) ? sub : 'reports';

  function setActive(name, pushHash = true) {
    active = name;
    [...tabs.querySelectorAll('button')].forEach(b => b.classList.toggle('active', b.dataset.tab === name));
    content.innerHTML = '';
    if (name === 'reports') reportsTab(content);
    else if (name === 'states') statesTab(content);
    else if (name === 'lookup') lookupTab(content);
    // Mirror active tab into the URL so the tab survives re-renders, browser
    // back/forward, and deep-links. No pushHash when called from initial render
    // to avoid a spurious hashchange that loops back through the router.
    if (pushHash && location.hash !== '#/moderation/' + name) {
      location.hash = '/moderation/' + name;
    }
  }
  const tabs = el('div', { style: 'display:flex;gap:8px;margin-bottom:14px' },
    tabBtn('Reports', 'reports', setActive),
    tabBtn('Active mutes & bans', 'states', setActive),
    tabBtn('User lookup', 'lookup', setActive));
  main.insertBefore(tabs, content);
  setActive(active, false);
}

function tabBtn(label, name, setActive) {
  return el('button', { class: 'btn sm', 'data-tab': name, onclick: () => setActive(name) }, label);
}

async function reportsTab(host) {
  try {
    const { reports } = await rpc('mod_reports_list', { status_filter: 'open' });
    if (!reports.length) { host.append(el('p', { class: 'muted' }, 'No open reports.')); return; }
    const rows = reports.map(r => el('tr', {},
      el('td', {}, '@' + (r.reporter_username || '?')),
      el('td', {}, r.target_username ? '@' + r.target_username : r.message_id ? 'message' : '—'),
      el('td', {}, r.category),
      el('td', {}, (r.reason || '').slice(0, 60)),
      el('td', {}, relTime(r.created_at)),
      el('td', {},
        el('button', { class: 'btn sm', onclick: async () => { await rpc('mod_report_resolve', { report_id: r.id, new_status: 'resolved' }); toast('Resolved', 'ok'); setActive('reports'); } }, 'Resolve'),
        el('button', { class: 'btn sm ghost', onclick: async () => { await rpc('mod_report_resolve', { report_id: r.id, new_status: 'dismissed' }); setActive('reports'); } }, 'Dismiss'))));
    const table = el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
      el('thead', {}, el('tr', {},
        el('th', {}, 'Reporter'), el('th', {}, 'Target'), el('th', {}, 'Category'), el('th', {}, 'Reason'), el('th', {}, 'Age'), el('th', {}, 'Actions'))),
      el('tbody', {}, rows)));
    host.append(table);
  } catch (e) { host.append(el('p', { class: 'muted' }, e.chc?.text || 'Failed to load reports.')); }
}

async function statesTab(host) {
  try {
    const { mutes, bans } = await rpc('mod_moderation_state_list');
    host.append(el('h3', { style: 'margin:10px 0' }, 'Active mutes'));
    if (mutes.length) {
      host.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
        el('tbody', {}, mutes.map(m => {
          const row = el('tr', {},
            el('td', {}, '@' + m.username),
            el('td', {}, m.expires_at ? 'until ' + new Date(m.expires_at).toLocaleString() : 'permanent'),
            el('td', {}, m.reason || ''),
            el('td', {}, el('button', { class: 'btn sm', onclick: async (ev) => {
              ev.target.disabled = true;
              // optimistic UI: hide the row immediately
              row.style.opacity = '0.4';
              try {
                await rpc('mod_unmute', { target_id: m.target_id });
                toast('Unmuted', 'ok');
                setActive('states');
              } catch (e) {
                row.style.opacity = '';
                ev.target.disabled = false;
                toast(e.chc?.text || e.message || 'Unmute failed', 'error');
              }
            } }, 'Unmute')));
          return row;
        })))));
    } else { host.append(el('p', { class: 'muted' }, 'None.')); }
    host.append(el('h3', { style: 'margin:10px 0' }, 'Active bans'));
    if (bans.length) {
      host.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
        el('tbody', {}, bans.map(b => {
          const row = el('tr', {},
            el('td', {}, '@' + b.username),
            el('td', {}, b.expires_at ? 'until ' + new Date(b.expires_at).toLocaleString() : 'permanent'),
            el('td', {}, b.reason || ''),
            el('td', {}, canAdmin() ? el('button', { class: 'btn sm', onclick: async (ev) => {
              ev.target.disabled = true;
              row.style.opacity = '0.4';
              try {
                await rpc('mod_unban', { target_id: b.target_id });
                toast('Unbanned', 'ok');
                setActive('states');
              } catch (e) {
                row.style.opacity = '';
                ev.target.disabled = false;
                toast(e.chc?.text || e.message || 'Unban failed', 'error');
              }
            } }, 'Unban') : null));
          return row;
        })))));
    } else { host.append(el('p', { class: 'muted' }, 'None.')); }
  } catch (e) { host.append(el('p', { class: 'muted' }, e.chc?.text || 'Failed.')); }
}

async function lookupTab(host) {
  const input = el('input', { placeholder: 'Search username…', style: 'width:260px;padding:9px 12px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' });
  const results = el('div', { style: 'margin-top:10px' });
  host.append(el('h3', {}, 'User lookup'), input, results);
  input.addEventListener('input', async () => {
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ''; return; }
    try {
      const { users } = await rpc('owner_users_list', { q }).catch(async () => ({ users: [] }));
      results.innerHTML = '';
      for (const u of (users || []).slice(0, 10)) results.append(userActionsRow(u, () => { /* lookup is live, no full refresh needed */ }));
    } catch {}
  });
}

// one row with all moderation actions (permissions enforced server-side too)
export function userActionsRow(u, refresh) {
  const canAct = myLevel() > ({ owner: 50, admin: 40, moderator: 30, helper: 20, member: 10, guest: 0 }[u.role] ?? 0) && !u.is_guest;
  const mkBtn = (label, fn, danger = false) => el('button', { class: `btn sm ${danger ? 'danger' : 'ghost'}`, disabled: !canAct || null, onclick: fn }, label);
  return el('div', { class: 'list-row', style: 'border-bottom:1px solid var(--line-1)' },
    avatar({ display_name: u.display_name, avatar_color: '#6c8cff' }, { size: 'sm' }),
    el('div', { class: 'lr-main' },
      // Pass display_name (string), guest label (string), badge (DOM node) as SEPARATE
      // children — never via template literal. Template literals coerce badge(u.role)
      // (an HTMLSpanElement) to "[object HTMLSpanElement]" because of String(s).
      el('div', { class: 'lr-title' }, u.display_name, u.is_guest ? '(guest)' : '', badge(u.role)),
      el('div', { class: 'lr-sub' }, `@${u.username} · joined ${new Date(u.created_at).toLocaleDateString()} · ${u.banned ? 'BANNED' : u.muted ? 'MUTED' : u.presence_state === 'online' ? 'online' : 'offline'}`)),
    el('div', { class: 'lr-actions', style: 'flex-wrap:wrap' },
      mkBtn('Warn', () => modDialog('warn', u, refresh)),
      mkBtn('Mute', () => modDialog('mute', u, refresh)),
      mkBtn('Kick', () => modDialog('kick', u, refresh), true),
      mkBtn(u.banned ? 'Unban' : 'Ban', () => u.banned ? doUnban(u, refresh) : modDialog('ban', u, refresh), true)));
}

function modDialog(action, u, refresh) {
  const needsDuration = action === 'mute' || action === 'ban';
  const duration = el('input', { type: 'number', min: 1, value: action === 'mute' ? 60 : 24, style: 'width:110px' });
  const unit = el('select', {}, action === 'mute'
    ? [el('option', { value: 'min' }, 'minutes'), el('option', { value: 'h' }, 'hours')]
    : [el('option', { value: 'h' }, 'hours')]);
  const permanent = action === 'ban' ? el('label', { style: 'display:flex;gap:8px;align-items:center;font-size:.85rem' }, el('input', { type: 'checkbox', style: 'width:auto' }), 'Permanent') : null;
  const reason = el('input', { placeholder: 'Reason (required)' });
  const ok = el('button', { class: 'btn danger', onclick: async () => {
    if (!reason.value.trim()) { toast('Reason is required.', 'error'); return; }
    try {
      if (action === 'warn') await rpc('mod_warn', { target_id: u.id, reason: reason.value });
      else if (action === 'kick') await rpc('mod_kick', { target_id: u.id, reason: reason.value });
      else if (action === 'mute') {
        const mins = unit.value === 'h' ? Number(duration.value) * 60 : Number(duration.value);
        await rpc('mod_mute', { target_id: u.id, duration_min: mins, reason: reason.value });
      } else if (action === 'ban') {
        const perm = permanent?.querySelector('input').checked;
        await rpc('mod_ban', { target_id: u.id, duration_hours: perm ? null : Number(duration.value), reason: reason.value });
      }
      toast('Done', 'ok'); m.close(); refresh?.();
    } catch (e) { toast(e.chc?.text || 'Action failed', 'error'); }
  } }, action.toUpperCase());
  const m = modal({
    title: `${action.toUpperCase()} — @${u.username}`,
    body: el('div', {},
      el('div', { class: 'field' }, el('label', {}, 'Reason'), reason),
      needsDuration ? el('div', { class: 'field' }, el('label', {}, 'Duration'),
        el('div', { style: 'display:flex;gap:8px' }, duration, unit)) : null,
      permanent,
      el('p', { class: 'hint', style: 'margin-top:10px' }, 'This action is recorded in the audit log.')),
    foot: [el('button', { class: 'btn ghost' }, 'Cancel'), ok]
  });
  m.node.querySelectorAll('.modal-foot .btn')[0].addEventListener('click', () => m.close());
}

async function doUnban(u, refresh) {
  if (!await confirmModal({ title: `Unban @${u.username}?`, text: 'The user will be able to sign in again.', confirmLabel: 'Unban', danger: false })) return;
  try { await rpc('mod_unban', { target_id: u.id }); toast('Unbanned', 'ok'); refresh?.(); }
  catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
}

// ================= BROADCAST =================
function broadcastView(main) {
  if (!canAdmin()) { main.append(el('p', { class: 'muted' }, 'Forbidden.')); return; }
  main.append(el('h2', {}, ic('bell'), ' Broadcast'));
  const kind = el('select', {}, ['info', 'announcement', 'warning', 'maintenance', 'system'].map(k => el('option', { value: k }, k)));
  const title = el('input', { maxlength: 120, placeholder: 'Title' });
  const bodyIn = el('textarea', { rows: 5, maxlength: 2000, placeholder: 'Message to everyone…' });
  const send = el('button', { class: 'btn primary', onclick: async () => {
    if (!title.value.trim() || !bodyIn.value.trim()) { toast('Title and body required.', 'error'); return; }
    if (!await confirmModal({ title: 'Send broadcast?', text: `Everyone will see: "${title.value.trim()}"`, confirmLabel: 'Send' })) return;
    send.disabled = true;
    try {
      await rpc('broadcast_send', { kind_input: kind.value, title_input: title.value.trim(), body_input: bodyIn.value.trim() });
      toast('Broadcast sent', 'ok');
      title.value = ''; bodyIn.value = '';
      await history();
    } catch (e) {
      toast(e.chc?.text || e.message || 'Send failed', 'error');
    } finally {
      send.disabled = false;
    }
  } }, ic('paper-plane-top'), ' Send broadcast');
  const histEl = el('div', { style: 'margin-top:18px' });
  main.append(
    el('div', { class: 'field' }, el('label', {}, 'Type'), kind),
    el('div', { class: 'field' }, el('label', {}, 'Title'), title),
    el('div', { class: 'field' }, el('label', {}, 'Body'), bodyIn),
    send, histEl);
  async function history() {
    histEl.innerHTML = '';
    histEl.append(el('h3', { style: 'margin:10px 0' }, 'History'), el('p', { class: 'muted' }, 'Loading…'));
    try {
      const res = await rpc('broadcasts_list', { limit_n: 20 });
      const broadcasts = res?.broadcasts || res || [];
      histEl.innerHTML = '';
      if (!broadcasts.length) { histEl.append(el('p', { class: 'muted' }, 'No broadcasts yet.')); return; }
      for (const b of broadcasts) {
        histEl.append(broadcastCard(b, history));
      }
    } catch (e) {
      histEl.innerHTML = '';
      histEl.append(el('p', { class: 'muted' }, e.chc?.text || e.message || 'Failed to load history.'));
    }
  }
  history();
}

function broadcastCard(b, refresh) {
  const card = el('div', { class: `broadcast-card kind-${b.kind}` },
    el('div', { class: 'bc-head' }, ic('bell'), el('span', {}, b.kind)),
    el('div', { class: 'bc-title' }, b.title || '(untitled)'),
    el('div', { class: 'bc-body' }, b.body || ''),
    el('div', { class: 'bc-meta' }, `${b.author_display_name || 'system'} · ${new Date(b.created_at).toLocaleString()}`),
    isOwner() ? el('button', { class: 'btn sm danger', style: 'margin-top:8px', onclick: async (ev) => {
      ev.target.disabled = true;
      try {
        if (!await confirmModal({ title: 'Delete broadcast?', text: b.title || '(untitled)', danger: true, confirmLabel: 'Delete' })) { ev.target.disabled = false; return; }
        await rpc('broadcast_delete', { broadcast_id: b.id });
        toast('Broadcast deleted', 'ok');
        await refresh();
      } catch (e) {
        toast(e.chc?.text || e.message || 'Delete failed', 'error');
        ev.target.disabled = false;
      }
    } }, ic('trash'), ' Delete') : null);
  return card;
}
