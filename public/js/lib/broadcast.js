// broadcast.js — floating announcement bubbles (auto-dismiss + inline-SVG close)
import { el } from './util.js';

const MAX_STACK = 3;

let stack = null;
function ensureStack() {
  if (stack && document.body.contains(stack)) return stack;
  stack = el('div', { class: 'broadcast-stack', 'aria-live': 'polite' });
  document.body.append(stack);
  return stack;
}

export function showBroadcastBubble(bc, { ttl = 10000 } = {}) {
  if (!bc || !bc.id) return;
  const s = ensureStack();
  // dedupe by broadcast id
  if (s.querySelector(`[data-bc-id="${bc.id}"]`)) return;

  const bubble = el('div', {
    class: `broadcast-bubble kind-${bc.kind || 'info'}`,
    'data-bc-id': bc.id,
    role: 'status'
  },
    el('div', { class: 'bb-head' },
      closeIconSvg(),
      el('span', { class: 'bb-kicker' }, bc.kind === 'system' ? 'System' : (bc.kind || 'Announcement')),
      el('button', { class: 'bb-close', 'aria-label': 'Dismiss', onclick: () => dismiss(bubble) }, closeIconSvg())),
    el('div', { class: 'bb-title' }, bc.title || bc.body || 'Announcement'),
    bc.title && bc.body ? el('div', { class: 'bb-body' }, bc.body) : null,
    bc.author_display_name || bc.author_username ? el('div', { class: 'bb-meta' }, `by ${bc.author_display_name || bc.author_username}`) : null);

  s.append(bubble);
  while (s.children.length > MAX_STACK) s.firstChild.remove();

  bubble._timer = setTimeout(() => dismiss(bubble), ttl);
  return bubble;
}

function dismiss(bubble) {
  if (!bubble || bubble._gone) return;
  bubble._gone = true;
  clearTimeout(bubble._timer);
  bubble.classList.add('leaving');
  setTimeout(() => bubble.remove(), 280);
}

// inline SVG so the close button never depends on the icon-font CDN
function closeIconSvg() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24');
  s.setAttribute('width', '16'); s.setAttribute('height', '16');
  s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '2.5'); s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('aria-hidden', 'true');
  const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  p.setAttribute('d', 'M18 6 6 18M6 6l12 12');
  s.append(p);
  return s;
}