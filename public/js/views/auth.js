// auth.js — landing/login/register/guest screens
import { sb, rpc } from '../lib/db.js';
import { el, ic, toast, esc } from '../lib/util.js';
import { applyTheme, getStoredTheme, getStoredMode } from '../lib/themes.js';

export function renderAuth(root, onDone) {
  let tab = 'login';
  root.innerHTML = '';

  const card = el('div', { class: 'auth-card' });
  const screen = el('div', { class: 'auth-screen' }, card);
  root.append(screen);

  function draw() {
    card.innerHTML = '';
    card.append(
      el('div', { class: 'brand-lg' },
        el('div', { class: 'brand-mark-lg' }, ic('comment')),
        el('h1', {}, 'Kaszael Ngobrol'),
        el('p', { class: 'sub' }, 'A comfortable place to talk with friends.')),
      el('div', { class: 'auth-tabs' },
        tabBtn('login', 'Sign in'),
        tabBtn('register', 'Register'),
        tabBtn('guest', 'Guest')));

    if (tab === 'login') card.append(loginForm());
    else if (tab === 'register') card.append(registerForm());
    else card.append(guestForm());
  }

  function tabBtn(t, label) {
    return el('button', { class: tab === t ? 'active' : '', onclick: () => { tab = t; draw(); } }, label);
  }

  function loginForm() {
    const email = el('input', { type: 'email', autocomplete: 'username', placeholder: 'you@example.com', required: '' });
    const pass = el('input', { type: 'password', autocomplete: 'current-password', placeholder: 'Password', required: '' });
    const btn = el('button', { class: 'btn primary full', type: 'submit' }, ic('arrow-right-to-bracket'), 'Sign in');
    const form = el('form', { onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const { error } = await sb.auth.signInWithPassword({ email: email.value.trim(), password: pass.value });
        if (error) throw error;
        onDone();
      } catch (err) {
        toast(err.chc?.text || err.message || 'Sign-in failed', 'error');
        btn.disabled = false;
      }
    }},
      el('div', { class: 'field' }, el('label', {}, 'Email'), email),
      el('div', { class: 'field' }, el('label', {}, 'Password'), pass),
      btn);
    return form;
  }

  function registerForm() {
    const uname = el('input', { autocomplete: 'off', placeholder: 'username (a-z, 0-9, _)', maxlength: 20 });
    const dname = el('input', { placeholder: 'Display name', maxlength: 40 });
    const email = el('input', { type: 'email', autocomplete: 'email', placeholder: 'you@example.com' });
    const pass = el('input', { type: 'password', autocomplete: 'new-password', placeholder: 'Min 8 characters' });
    const btn = el('button', { class: 'btn primary full', type: 'submit' }, ic('user-add'), 'Create account');
    return el('form', { onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const { data, error } = await sb.auth.signUp({
          email: email.value.trim(), password: pass.value,
          options: { data: { username: uname.value.trim().toLowerCase(), display_name: dname.value.trim() } }
        });
        if (error) throw error;
        if (!data.session) {
          toast('Check your email to confirm, then sign in.', 'ok', 5000);
          tab = 'login'; draw(); return;
        }
        // create profile row server-side
        await rpc('profile_init', {
          uid: data.user.id,
          uname_input: uname.value.trim().toLowerCase(),
          dname_input: dname.value.trim() || uname.value.trim()
        });
        onDone();
      } catch (err) {
        toast(err.chc?.text || err.message || 'Registration failed', 'error', 5000);
        btn.disabled = false;
      }
    }},
      el('div', { class: 'field' }, el('label', {}, 'Username'), uname,
        el('div', { class: 'hint' }, 'Unique. Cannot impersonate staff or the owner.')),
      el('div', { class: 'field' }, el('label', {}, 'Display name'), dname),
      el('div', { class: 'field' }, el('label', {}, 'Email'), email),
      el('div', { class: 'field' }, el('label', {}, 'Password'), pass,
        el('div', { class: 'hint' }, 'Stored as a secure hash — never in plaintext.')),
      btn);
  }

  function guestForm() {
    const name = el('input', { placeholder: 'Pick a display name', maxlength: 40 });
    const btn = el('button', { class: 'btn primary full', type: 'submit' }, ic('ghost'), 'Enter as guest');
    return el('form', { onsubmit: async (e) => {
      e.preventDefault();
      btn.disabled = true;
      try {
        const { data, error } = await sb.auth.signInAnonymously();
        if (error) throw error;
        await rpc('guest_enter', { display_name_input: name.value.trim() });
        onDone();
      } catch (err) {
        toast(err.chc?.text || err.message || 'Guest entry failed', 'error');
        btn.disabled = false;
      }
    }},
      el('p', { class: 'sub', style: 'margin-bottom:14px' },
        'No account needed. Guest identity is temporary — when you leave, your messages and data are removed.'),
      el('div', { class: 'field' }, el('label', {}, 'Display name'), name),
      btn);
  }

  draw();
}
