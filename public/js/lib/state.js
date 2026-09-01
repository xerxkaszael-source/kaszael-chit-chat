// state.js — app-wide reactive-ish state store + role helpers
export const ROLES = { owner: 50, admin: 40, moderator: 30, helper: 20, member: 10, guest: 0 };
export const roleLevel = (r) => ROLES[r] ?? -1;

export const state = {
  session: null,          // supabase session
  profile: null,          // own profile row
  flags: { muted: false, banned: false, kicked: false }, // from profile_own()
  settings: null,         // user_settings row
  isGuest: false,
  room: null,             // chat_rooms row
  messages: [],           // cached message rows (ascending)
  profiles: new Map(),    // id -> profile
  presence: new Map(),    // id -> presence row
  reactions: new Map(),   // messageId -> [{emoji, user_id}]
  attachments: new Map(), // messageId -> [attachment rows]
  pins: [],
  typing: new Map(),      // id -> {name, ts}
  friends: { accepted: [], pending_in: [], pending_out: [] },
  blocks: [],
  unreadNotifs: 0,
  replyTo: null,
  editing: null,
  pendingUploads: [],
  connState: 'connecting',
};

const listeners = new Set();
export function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
export function notify(topic) { for (const fn of listeners) fn(topic); }

// ---- derived helpers ----
export const me = () => state.profile;
export const myLevel = () => roleLevel(state.profile?.role);
export const canModerate = () => myLevel() >= 30;
export const canAdmin = () => myLevel() >= 40;
export const isOwner = () => myLevel() >= 50;
export const isMemberPlus = () => state.profile && !state.isGuest;

export function profileOf(id) { return state.profiles.get(id); }
export function presenceOf(id) { return state.presence.get(id); }

export function insertMessage(msg) {
  if (state.messages.some(m => m.id === msg.id)) return false; // dedup
  // keep ascending order by created_at
  let lo = 0, hi = state.messages.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (state.messages[mid].created_at < msg.created_at) lo = mid + 1; else hi = mid;
  }
  state.messages.splice(lo, 0, msg);
  return true;
}
export function patchMessage(id, patch) {
  const m = state.messages.find(x => x.id === id);
  if (m) Object.assign(m, patch);
  return m;
}
export function removeMessage(id) {
  const i = state.messages.findIndex(x => x.id === id);
  if (i >= 0) state.messages.splice(i, 1);
}
