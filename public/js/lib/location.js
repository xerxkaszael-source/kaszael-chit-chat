// lib/location.js — privacy-first user location manager.
// Per brief §30-35:
//   - Never auto-access GPS. Only after explicit user click in settings.
//   - Two storage layers: technical coords (owner-only) + admin display
//     (controlled by user's chosen granularity).
//   - Reverse-geocode via OpenStreetMap Nominatim (free, no key, 1 req/s
//     rate limit, requires User-Agent). Cached in memory + localStorage.
//   - Failures: never fabricate. Surface error to UI.
//   - One-time/occasional update — no background tracking.
import { rpc } from './db.js';
import { state, notify } from './state.js';
import { toast } from './util.js';

const CACHE_KEY = 'chc:location:reverse-cache';
const LAST_REQUEST_KEY = 'chc:location:last-request';
const MIN_INTERVAL_MS = 1100; // Nominatim: max 1 req/s

// ---- reverse-geocode cache ----
function getCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}'); } catch { return {}; }
}
function setCache(c) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify(c)); } catch {}
}
function cacheKey(lat, lng) {
  // round to 3 decimals (~100m) so nearby requests hit cache
  return `${lat.toFixed(3)},${lng.toFixed(3)}`;
}

export const GRANULARITIES = [
  { value: 'hidden',   label: 'Hidden',     desc: 'No location shared' },
  { value: 'country',  label: 'Country',    desc: 'Show only your country' },
  { value: 'province', label: 'Province',   desc: 'Show country + state/province' },
  { value: 'city',     label: 'City',       desc: 'Show country + province + city' },
  { value: 'district', label: 'District',   desc: 'Show full admin path (most detailed)' }
];

// ---- public API ----
export async function getOwn() {
  try {
    return await rpc('location_get_own');
  } catch (e) {
    return { set: false, error: e.message };
  }
}

export async function getFor(userId) {
  try {
    return await rpc('location_get_for', { target_id: userId });
  } catch (e) {
    return { granularity: 'hidden', error: e.message };
  }
}

export async function setGranularity(g) {
  try {
    const r = await rpc('location_set_granularity', { v_granularity: g });
    notify('location');
    return r;
  } catch (e) {
    toast(`Could not change location setting: ${e.message}`, 'error');
    return { ok: false, error: e.message };
  }
}

// ---- GPS acquire + reverse-geocode + persist ----
export async function enableLocation() {
  // 1. Check browser support + secure context
  if (!('geolocation' in navigator)) {
    return { ok: false, error: 'Geolocation is not supported by this browser.' };
  }
  if (window.isSecureContext === false) {
    return { ok: false, error: 'Geolocation requires a secure context (HTTPS or localhost).' };
  }
  // 2. Acquire coords (promise-wrapped, error-normalized)
  let coords;
  try {
    coords = await new Promise((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: p.coords.accuracy }),
        err => reject(new Error(geoErrorMessage(err))),
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });
  } catch (e) {
    return { ok: false, error: e.message };
  }
  // 3. Reverse-geocode (with rate limit + cache)
  const admin = await reverseGeocode(coords.lat, coords.lng);
  // 4. Persist via RPC
  try {
    const r = await rpc('location_update', {
      v_lat: coords.lat,
      v_lng: coords.lng,
      v_accuracy: coords.accuracy,
      v_country: admin.country || '',
      v_province: admin.province || '',
      v_city: admin.city || '',
      v_district: admin.district || '',
      v_village: admin.village || '',
      v_formatted: admin.formatted || ''
    });
    state.profile = state.profile || {};
    state.profile.location_country = admin.country || '';
    state.profile.location_formatted = admin.formatted || '';
    state.profile.location_updated_at = new Date().toISOString();
    notify('location');
    return { ok: true, formatted: admin.formatted };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export async function clearLocation() {
  try {
    await rpc('location_clear');
    if (state.profile) {
      state.profile.location_country = '';
      state.profile.location_formatted = '';
      state.profile.location_granularity = 'hidden';
    }
    notify('location');
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

// ---- reverse geocode (OpenStreetMap Nominatim) ----
// Throttled to 1 req/s with localStorage cache.
export async function reverseGeocode(lat, lng) {
  const key = cacheKey(lat, lng);
  const cache = getCache();
  if (cache[key]) return cache[key];
  // Rate-limit: if a request was made <1.1s ago, wait
  const lastReq = parseInt(localStorage.getItem(LAST_REQUEST_KEY) || '0', 10);
  const wait = Math.max(0, MIN_INTERVAL_MS - (Date.now() - lastReq));
  if (wait > 0) await new Promise(r => setTimeout(r, wait));
  localStorage.setItem(LAST_REQUEST_KEY, String(Date.now()));
  // Build query URL — Nominatim reverse endpoint
  const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${encodeURIComponent(lat)}&lon=${encodeURIComponent(lng)}&accept-language=en&zoom=14`;
  let data;
  try {
    const r = await fetch(url, { headers: { 'Accept': 'application/json' } });
    if (!r.ok) throw new Error(`Geocoder returned HTTP ${r.status}`);
    data = await r.json();
  } catch (e) {
    // Fail gracefully: do NOT fabricate, return empty
    return { formatted: '', country: '', province: '', city: '', district: '', village: '' };
  }
  const a = data.address || {};
  const admin = {
    country: a.country || '',
    province: a.state || a.region || a.county || '',
    city: a.city || a.town || a.municipality || a.county || '',
    district: a.suburb || a.city_district || a.county || a.state_district || '',
    village: a.village || a.hamlet || a.neighbourhood || '',
    formatted: data.display_name || ''
  };
  cache[key] = admin;
  setCache(cache);
  return admin;
}

// ---- errors ----
function geoErrorMessage(err) {
  if (!err) return 'Unknown geolocation error';
  switch (err.code) {
    case 1: return 'Location permission denied. You can enable it from browser settings.';
    case 2: return 'Location unavailable. Make sure location services are on.';
    case 3: return 'Location request timed out. Try again.';
    default: return err.message || 'Geolocation error';
  }
}