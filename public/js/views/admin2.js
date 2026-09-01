// admin2.js — admin dashboard, owner center, audit log, system/danger zone
import { rpc } from '../lib/db.js';
import { state, me, isOwner, canAdmin } from '../lib/state.js';
import { el, ic, toast, modal, confirmModal, relTime } from '../lib/util.js';
import { avatar, badge } from '../lib/avatar.js';
import { userActionsRow } from './admin.js';

// ================= ADMIN (user management, reduced) =================
export async function adminView(main) {
  main.append(el('h2', {}, 'Admin — Users'));
  const input = el('input', { placeholder: 'Filter by username…', style: 'width:280px;padding:9px 12px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' });
  const holder = el('div', { style: 'margin-top:12px' });
  main.append(input, holder);
  const load = async () => {
    holder.innerHTML = '<p class="muted">Loading…</p>';
    try {
      const { users } = await rpc('owner_users_list', { q: input.value.trim() });
      holder.innerHTML = '';
      for (const u of users || []) holder.append(userActionsRow(u, load));
      if (!(users || []).length) holder.append(el('p', { class: 'muted' }, 'No users found.'));
    } catch (e) { holder.innerHTML = ''; holder.append(el('p', { class: 'muted' }, e.chc?.text || 'Failed.')); }
  };
  input.addEventListener('input', () => { clearTimeout(input._t); input._t = setTimeout(load, 400); });
  load();
}

// ================= OWNER CENTER =================
export async function ownerView(main) {
  main.append(el('h2', {}, 'Owner Control Center'));
  const stats = el('div', { class: 'stat-grid' });
  main.append(stats);
  try {
    const s = await rpc('owner_stats');
    const card = (label, value) => el('div', { class: 'stat-card' },
      el('div', { class: 'sv' }, String(value)), el('div', { class: 'sl' }, label));
    stats.append(
      card('Members', s.users_total), card('Guests now', s.guests_total),
      card('Online', s.online), card('Messages total', s.messages_total),
      card('Messages 24h', s.messages_today), card('Muted', s.muted_active),
      card('Banned', s.banned_active), card('Open reports', s.reports_open),
      card('Broadcasts', s.broadcasts_total), card('Audit events', s.audit_total));
  } catch (e) { stats.append(el('p', { class: 'muted' }, e.chc?.text || 'Stats failed.')); }

  // role management
  main.append(el('h3', { style: 'margin:16px 0 8px' }, 'Role management'));
  const roleHolder = el('div', {});
  main.append(roleHolder);
  loadRoleUsers(roleHolder);

  function loadRoleUsers(holder) {
    holder.innerHTML = '<p class="muted">Loading…</p>';
    rpc('owner_users_list', { q: '' }).then(({ users }) => {
      holder.innerHTML = '';
      const assignable = (users || []).filter(u => !u.is_guest && u.id !== me().id);
      if (!assignable.length) { holder.append(el('p', { class: 'muted' }, 'No assignable users.')); return; }
      for (const u of assignable) {
        const sel = el('select', { style: 'padding:6px 10px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:8px;color:var(--text-1)' },
          ['member', 'helper', 'moderator', 'admin'].map(r => el('option', { value: r }, r)));
        sel.value = u.role === 'owner' ? 'admin' : u.role;
        const apply = el('button', { class: 'btn sm primary', onclick: async () => {
          if (!await confirmModal({ title: `Change @${u.username} to ${sel.value}?`, text: 'Role changes are audited.', confirmLabel: 'Apply' })) return;
          try { await rpc('owner_set_role', { target_id: u.id, new_role: sel.value }); toast('Role updated', 'ok'); }
          catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
        } }, 'Apply');
        holder.append(el('div', { class: 'list-row', style: 'border-bottom:1px solid var(--line-1)' },
          avatar({ display_name: u.display_name, avatar_color: '#6c8cff' }, { size: 'sm' }),
          el('div', { class: 'lr-main' },
            el('div', { class: 'lr-title' }, u.display_name),
            el('div', { class: 'lr-sub' }, '@' + u.username)),
          badge(u.role), sel, apply));
      }
    }).catch(e => { holder.innerHTML = ''; holder.append(el('p', { class: 'muted' }, 'Failed to load.')); });
  }
}

// ================= AUDIT =================
export async function auditView(main) {
  main.append(el('h2', {}, 'Audit log'));
  const filter = el('input', { placeholder: 'Filter action (e.g. USER_BANNED)…', style: 'width:300px;padding:9px 12px;background:var(--bg-2);border:1px solid var(--line-1);border-radius:10px;color:var(--text-1)' });
  const holder = el('div', { style: 'margin-top:12px' });
  main.append(filter, holder);
  let offset = 0;
  const load = async () => {
    try {
      const { logs } = await rpc('owner_audit_list', { action_filter: filter.value.trim(), limit_n: 50, offset_n: offset });
      holder.innerHTML = '';
      if (!(logs || []).length) { holder.append(el('p', { class: 'muted' }, 'No audit events.')); return; }
      holder.append(el('div', { class: 'table-wrap' }, el('table', { class: 'data-table' },
        el('thead', {}, el('tr', {}, el('th', {}, 'Time'), el('th', {}, 'Action'), el('th', {}, 'Actor'), el('th', {}, 'Target'), el('th', {}, 'Reason'), el('th', {}, 'Severity'))),
        el('tbody', {}, logs.map(l => el('tr', {},
          el('td', {}, new Date(l.created_at).toLocaleString()),
          el('td', {}, l.action),
          el('td', {}, l.actor_username ? '@' + l.actor_username : 'system'),
          el('td', {}, l.target_username ? '@' + l.target_username : '—'),
          el('td', {}, (l.reason || '').slice(0, 60)),
          el('td', {}, l.severity)))))));
      const pager = el('div', { style: 'display:flex;gap:8px;margin-top:10px' },
        el('button', { class: 'btn sm ghost', disabled: offset === 0 || null, onclick: () => { offset = Math.max(0, offset - 50); load(); } }, 'Newer'),
        el('button', { class: 'btn sm ghost', onclick: () => { offset += 50; load(); } }, 'Older'));
      holder.append(pager);
    } catch (e) { holder.innerHTML = ''; holder.append(el('p', { class: 'muted' }, e.chc?.text || 'Failed.')); }
  };
  filter.addEventListener('input', () => { clearTimeout(filter._t); filter._t = setTimeout(() => { offset = 0; load(); }, 400); });
  load();
}

// ================= SYSTEM / DANGER ZONE =================
export async function systemView(main) {
  main.append(el('h2', {}, 'System'));
  const holder = el('div', {});
  main.append(holder);

  // settings
  const settingsEl = el('div', {});
  holder.append(settingsEl);
  try {
    const { settings } = await rpc('owner_settings_get');
    settingsEl.append(el('h3', { style: 'margin:10px 0' }, 'Application settings'));
    const toggles = [
      ['guests_enabled', 'Allow guest access'],
      ['registration_enabled', 'Allow new registrations'],
      ['maintenance_mode', 'Maintenance mode (banner only)'],
    ];
    for (const [key, label] of toggles) {
      const cb = el('input', { type: 'checkbox', checked: settings[key] === true || null, style: 'width:auto' });
      cb.addEventListener('change', async () => {
        try {
          await rpc('owner_settings_set', { k: key, v: cb.checked });
          toast(`${label}: ${cb.checked ? 'on' : 'off'}`, 'ok');
        } catch (e) { toast(e.chc?.text || 'Failed', 'error'); cb.checked = !cb.checked; }
      });
      settingsEl.append(el('label', { style: 'display:flex;gap:10px;align-items:center;padding:6px 0;font-size:.9rem' }, cb, label));
    }
  } catch (e) { settingsEl.append(el('p', { class: 'muted' }, 'Settings unavailable.')); }

  // danger zone
  const dz = el('div', { class: 'danger-zone' },
    el('h3', {}, ic('triangle-warning'), 'Danger zone'));
  holder.append(dz);
  dzRow(dz, 'Purge stale guest sessions', 'Remove guest identities older than 24h and their messages.', async () => {
    if (!await confirmModal({ title: 'PURGE STALE GUEST DATA', text: 'This deletes guest accounts older than 24 hours and ALL their messages. This cannot be undone.', danger: true, confirmLabel: 'PURGE GUEST DATA', requirePhrase: 'PURGE GUEST DATA' })) return;
    try { const r = await rpc('guest_purge_stale'); toast(`Purged ${r.purged} stale guests`, 'ok'); }
    catch (e) { toast(e.chc?.text || 'Purge failed', 'error'); }
  });
  dzRow(dz, 'Sweep stale presence', 'Mark users offline if no heartbeat for 90s.', async () => {
    try { const r = await rpc('presence_sweep'); toast(`Swept ${r.swept}`, 'ok'); }
    catch (e) { toast(e.chc?.text || 'Failed', 'error'); }
  });

  function dzRow(parent, title, sub, fn) {
    parent.append(el('div', { class: 'dz-row' },
      el('div', { class: 'dz-text' }, el('div', { class: 'dz-title' }, title), el('div', { class: 'dz-sub' }, sub)),
      el('button', { class: 'btn sm danger', onclick: fn }, 'Execute')));
  }

  // deployment info (no secrets)
  holder.append(el('h3', { style: 'margin:18px 0 8px' }, 'Deployment info'),
    el('p', { class: 'muted' }, `App version ${window.SUPABASE_CONFIG.version} · frontend on Netlify · API: ${new URL(window.SUPABASE_CONFIG.url).host}`));
}
