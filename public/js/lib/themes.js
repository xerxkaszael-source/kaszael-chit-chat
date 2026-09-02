// themes.js — 30-theme engine. Persists theme id + mode (light/dark/system).
// Each theme has an inherent base (dark/light). If user forces a mode that
// differs from the theme's base, we pick the nearest theme of that base.

export const THEMES = [
  // [id, name, base, accent, accent2]
  ['midnight',     'Midnight',        'dark',  '#6c8cff', '#8f6cff'],
  ['honey-bee',    'Honey Bee',       'dark',  '#ffd60a', '#ffb703'],
  ['carbon-gold',  'Carbon Gold',     'dark',  '#e8c468', '#b8860b'],
  ['ember',        'Ember',           'dark',  '#ff6b35', '#ff9d6c'],
  ['sakura',       'Sakura',          'dark',  '#ff6c9d', '#ffa5c5'],
  ['matrix',       'Matrix Green',    'dark',  '#3ddc84', '#00b86b'],
  ['forest',       'Deep Forest',     'dark',  '#5fbf7f', '#2e8b57'],
  ['ocean',        'Ocean',           'dark',  '#2ec4b6', '#0ea5e9'],
  ['arctic',       'Arctic',          'dark',  '#7dd3fc', '#38bdf8'],
  ['violet-noir',  'Violet Noir',     'dark',  '#a78bfa', '#7c3aed'],
  ['crimson',      'Crimson',         'dark',  '#f43f5e', '#e11d48'],
  ['cyber-yellow', 'Cyber Yellow',    'dark',  '#facc15', '#a3e635'],
  ['coffee',       'Coffee House',    'dark',  '#c8a27a', '#8b5a2b'],
  ['graphite',     'Graphite Mono',   'dark',  '#9ca3af', '#e5e7eb'],
  ['neon-grape',   'Neon Grape',      'dark',  '#e879f9', '#c026d3'],
  ['paper',        'Clean Paper',     'light', '#4f6ef7', '#7c3aed'],
  ['sunny-side',   'Sunny Side',      'light', '#f59e0b', '#d97706'],
  ['rose-quartz',  'Rose Quartz',     'light', '#ec4899', '#f472b6'],
  ['mint',         'Fresh Mint',      'light', '#10b981', '#059669'],
  ['sky',          'Day Sky',         'light', '#0ea5e9', '#0284c7'],
  ['lavender',     'Lavender Field',  'light', '#8b5cf6', '#7c3aed'],
  ['coral',        'Coral Reef',      'light', '#fb7185', '#f43f5e'],
  ['fern',         'Fern',            'light', '#16a34a', '#15803d'],
  ['sand',         'Desert Sand',     'light', '#d4a373', '#a97142'],
  ['slate-blue',   'Slate Blue',      'light', '#475569', '#334155'],
  ['cherry',       'Cherry Soda',     'light', '#e11d48', '#be123c'],
  ['lime',         'Lime Zest',       'light', '#65a30d', '#4d7c0f'],
  ['lagoon',       'Lagoon',          'light', '#0d9488', '#0f766e'],
  ['orchid',       'Orchid',          'light', '#d946ef', '#c026d3'],
  ['steel',        'Blue Steel',      'light', '#3b82f6', '#2563eb'],
];

const LS_THEME = 'chc.theme';
const LS_MODE = 'chc.mode'; // light | dark | system

export function getStoredTheme() { return localStorage.getItem(LS_THEME) || 'midnight'; }
export function getStoredMode() { return localStorage.getItem(LS_MODE) || 'system'; }

function systemDark() { return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? true; }

function nearestTheme(base) {
  const t = THEMES.find(t => t[2] === base);
  return t ? t[0] : 'midnight';
}

export function applyTheme(themeId = getStoredTheme(), mode = getStoredMode()) {
  // Explicit selection always WINS: clicking a theme applies exactly that theme.
  const want = THEMES.find(t => t[0] === themeId);
  let theme = want || THEMES[0];
  // If the theme comes from a forced light/dark mode (not an explicit "system"
  // follow), keep it as-is — no silent swapping that ignores the user's click.
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.content = theme[2] === 'dark' ? '#0b0e14' : '#f4f5f8';
  document.documentElement.setAttribute('data-chc-theme', theme[0]);
  document.documentElement.setAttribute('data-theme', theme[2]);
}

export function setTheme(themeId) {
  localStorage.setItem(LS_THEME, themeId);
  // apply the chosen theme verbatim regardless of mode base
  applyTheme(themeId, 'system');
}

export function setMode(mode) {
  localStorage.setItem(LS_MODE, mode);
  // "Follow system" resolves the OS base; explicit light/dark just persists.
  applyTheme(getStoredTheme(), mode);
}

// follow OS when mode=system
export function watchSystemTheme() {
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', () => {
    if (getStoredMode() === 'system') applyTheme();
  });
}
