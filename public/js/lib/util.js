// util.js — DOM helpers, escaping, formatting, toasts, debounce
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v; // ONLY for trusted pre-escaped markup
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (v === true) node.setAttribute(k, '');
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// linkify + @mention highlight on ESCAPED text (safe: runs after esc)
export function richText(raw) {
  let s = esc(raw);
  s = s.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  s = s.replace(/@([a-z0-9_]{3,20})/gi, '<span class="mention">@$1</span>');
  return s;
}

export function fmtTime(iso, use24h = true) {
  const d = new Date(iso);
  if (isNaN(d)) return '';
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: !use24h });
}
export function fmtDay(iso) {
  const d = new Date(iso), now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  if (sameDay) return 'Today';
  const y = new Date(now); y.setDate(now.getDate() - 1);
  if (d.toDateString() === y.toDateString()) return 'Yesterday';
  return d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
}
export function relTime(iso) {
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
export function fmtBytes(n) {
  if (n < 1024) return n + ' B';
  if (n < 1048576) return (n / 1024).toFixed(1) + ' KB';
  return (n / 1048576).toFixed(1) + ' MB';
}
export function initials(name) {
  return String(name || '?').trim().split(/\s+/).slice(0, 2).map(w => w[0]).join('').toUpperCase() || '?';
}
export function debounce(fn, ms) {
  let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}
export function throttle(fn, ms) {
  let last = 0;
  return (...a) => { const n = Date.now(); if (n - last >= ms) { last = n; fn(...a); } };
}

// ---- toasts ----
export function toast(msg, kind = 'info', ms = 3200) {
  const box = document.getElementById('toasts');
  const t = el('div', { class: `toast ${kind === 'error' ? 'err' : kind}`, role: 'status' }, msg);
  box.append(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity .3s'; setTimeout(() => t.remove(), 320); }, ms);
}

// ---- modals ----
export function modal({ title, body, foot, wide = false, onClose }) {
  const root = document.getElementById('modals');
  const backdrop = el('div', { class: 'modal-backdrop', onclick: e => { if (e.target === backdrop) close(); } },
    el('div', { class: `modal${wide ? ' wide' : ''}`, role: 'dialog', 'aria-modal': 'true' },
      el('div', { class: 'modal-head' },
        el('h2', {}, title),
        el('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: close }, ic('cross'))),
      el('div', { class: 'modal-body' }, body || ''),
      foot ? el('div', { class: 'modal-foot' }, foot) : null));
  function close() { backdrop.remove(); onClose && onClose(); document.removeEventListener('keydown', key); }
  function key(e) { if (e.key === 'Escape') close(); }
  document.addEventListener('keydown', key);
  root.append(backdrop);
  backdrop.querySelector('.modal-head button').focus();
  return { close, node: backdrop };
}

export function confirmModal({ title, text, confirmLabel = 'Confirm', danger = false, requirePhrase = null }) {
  return new Promise(resolve => {
    const body = el('div', {},
      el('p', { style: 'margin-bottom:12px' }, text),
      requirePhrase ? el('div', { class: 'field' },
        el('label', {}, `Type "${requirePhrase}" to confirm`),
        el('input', { id: 'cfm-phrase', autocomplete: 'off' })) : null);
    const ok = el('button', { class: `btn ${danger ? 'danger' : 'primary'}`, disabled: !!requirePhrase || null }, confirmLabel);
    const m = modal({
      title, body,
      foot: [el('button', { class: 'btn ghost' }, 'Cancel'), ok],
      onClose: () => resolve(false)
    });
    if (requirePhrase) {
      $('#cfm-phrase', m.node).addEventListener('input', e => { ok.disabled = e.target.value.trim() !== requirePhrase; });
    }
    ok.addEventListener('click', () => { m.close(); resolve(true); });
    m.node.querySelectorAll('.modal-foot .btn')[0].addEventListener('click', () => m.close());
  });
}

// ---- misc ----
export function copyText(t) {
  return navigator.clipboard?.writeText(t).catch(() => {});
}
export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() :
  'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0; return (c === 'x' ? r : (r & 3 | 8)).toString(16);
  }));

// icons helper (flaticon uicons). name = uicons name without prefix.
export function ic(name, cls = '') {
  return el('i', { class: `fi fi-rs-${name}${cls ? ' ' + cls : ''}`, 'aria-hidden': 'true' });
}
export function icBtn(name, label, onClick, extra = {}) {
  return el('button', { class: 'icon-btn', 'aria-label': label, title: label, onclick: onClick, ...extra }, ic(name));
}
