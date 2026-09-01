// db.js — Supabase client + typed RPC wrappers. ALL mutations go through RPCs.
const { createClient } = window.supabase;

const cfg = window.SUPABASE_CONFIG;
if (!cfg || !cfg.url || cfg.url.startsWith('__SUPABASE')) {
  console.warn('[chc] Supabase config not injected — run scripts/deploy.sh');
}

export const sb = createClient(cfg.url, cfg.anonKey, {
  auth: { persistSession: true, autoRefreshToken: true, storage: localStorage }
});

// ---- error normalization ----
// Supabase RPC errors arrive as { message: "..." } with embedded 'CHC:code:human'
export function parseChcError(err) {
  const msg = err?.message || String(err);
  const m = msg.match(/CHC:([a-z_]+):(.*)$/);
  if (m) return { code: m[1], text: m[2] };
  if (/jwt|token|expired/i.test(msg)) return { code: 'session', text: 'Session expired — please sign in again.' };
  if (/rate limit|429/i.test(msg)) return { code: 'rate_limit', text: 'Too many requests — slow down a moment.' };
  return { code: 'unknown', text: msg.split('\n')[0].slice(0, 140) };
}

export async function rpc(name, args = {}) {
  const { data, error } = await sb.rpc(name, args);
  if (error) throw Object.assign(new Error(error.message), { chc: parseChcError(error) });
  return data;
}

// read-only queries (RLS SELECT policies)
export const from = (t) => sb.from(t);

// ---- presence channel (typing + connection state) ----
export const GENERAL_ROOM = '00000000-0000-0000-0000-000000000001';

export function storagePublicUrl(bucket, path) {
  return `${cfg.url}/storage/v1/object/public/${bucket}/${path}`;
}

export async function uploadToStorage(bucket, path, file) {
  const { error } = await sb.storage.from(bucket).upload(path, file, { upsert: true });
  if (error) throw Object.assign(new Error(error.message), { chc: parseChcError(error) });
}

export async function deleteFromStorage(bucket, path) {
  await sb.storage.from(bucket).remove([path]).catch(() => {});
}
