// avatar.js — avatar element (image or initials with deterministic color) + presence dot
import { el, initials } from './util.js';
import { storagePublicUrl } from './db.js';
import { state } from './state.js';

export function avatar(profile, { size = '', showPresence = false } = {}) {
  const wrap = el('div', {
    class: `avatar${size ? ' ' + size : ''}`,
    style: `--avatar-bg:${profile?.avatar_color || '#6c8cff'}`
  });
  if (profile?.avatar_path) {
    const img = el('img', {
      src: storagePublicUrl('avatars', profile.avatar_path),
      alt: profile.display_name, loading: 'lazy',
      onerror: () => { img.remove(); wrap.append(document.createTextNode(initials(profile.display_name))); }
    });
    wrap.append(img);
  } else {
    wrap.append(initials(profile?.display_name));
  }
  if (showPresence) {
    const p = state.presence.get(profile?.id);
    const dot = el('span', { class: `pres-dot ${p?.state === 'online' ? 'online' : p?.state === 'idle' ? 'idle' : ''}` });
    wrap.append(dot);
  }
  return wrap;
}

export function badge(role) {
  return el('span', { class: `badge ${role}` }, role);
}
