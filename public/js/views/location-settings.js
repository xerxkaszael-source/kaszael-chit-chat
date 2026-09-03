// views/location-settings.js — Location settings panel.
// User controls: enable location, choose granularity, clear data.
import { GRANULARITIES, getOwn, enableLocation, clearLocation, setGranularity } from '../lib/location.js';
import { state, me, notify, subscribe } from '../lib/state.js';
import { el, ic, toast } from '../lib/util.js';

let viewEl = null;
let _sub = null;
let _data = null;

export async function renderLocationSettings(mainEl) {
  viewEl = el('div', { class: 'loc-settings' },
    el('div', { class: 'view-head' },
      el('h2', {}, 'Location'),
      el('p', { class: 'view-sub' }, 'Choose what others can see about where you are.')),
    el('div', { class: 'loc-body', id: 'loc-body' },
      el('div', { class: 'skeleton-row' }, 'Loading…')));
  mainEl.append(viewEl);
  if (!_sub) {
    _sub = subscribe((t) => { if (t === 'location' || t === 'route') render(); });
  }
  await load();
}

async function load() {
  try { _data = await getOwn(); } catch { _data = { set: false, error: 'load_failed' }; }
  render();
}

function render() {
  const body = document.getElementById('loc-body');
  if (!body) return;
  body.innerHTML = '';

  // Status card
  const isSet = !!_data?.set;
  const status = el('div', { class: `loc-status ${isSet ? 'on' : 'off'}` },
    el('div', { class: 'loc-status-icon' }, ic(isSet ? 'map-marker' : 'map-marker-alt-slash')),
    el('div', { class: 'loc-status-meta' },
      el('div', { class: 'loc-status-line1' }, isSet ? 'Location is on' : 'Location is off'),
      el('div', { class: 'loc-status-line2' },
        isSet
          ? (_data.formatted || `${_data.city || ''} ${_data.country || ''}`.trim() || 'Stored, no display label')
          : 'No location data stored')));
  body.append(status);

  // Enable/Update button
  const enableBtn = el('button', { class: 'btn primary', onclick: handleEnable },
    ic('location-crosshairs'), ' ', isSet ? 'Update my location' : 'Enable location');
  body.append(el('div', { class: 'loc-action-row' }, enableBtn));
  if (isSet) {
    body.append(el('div', { class: 'loc-action-row' },
      el('button', { class: 'btn ghost', onclick: handleClear }, ic('trash'), ' Clear my location')));
  }

  // Granularity picker
  const current = _data?.granularity || 'hidden';
  body.append(el('h3', { class: 'loc-h3' }, 'What can others see?'));
  const picker = el('div', { class: 'loc-granularity' });
  for (const g of GRANULARITIES) {
    picker.append(el('label', { class: `loc-gran ${g.value === current ? 'active' : ''}` },
      el('input', { type: 'radio', name: 'gran', value: g.value,
                    checked: g.value === current ? '' : null,
                    onchange: () => handleGranularityChange(g.value) }),
      el('div', {},
        el('div', { class: 'loc-gran-label' }, g.label),
        el('div', { class: 'loc-gran-desc' }, g.desc))));
  }
  body.append(picker);

  // Info / privacy notice
  body.append(el('div', { class: 'loc-notice' },
    el('strong', {}, 'Privacy: '),
    'Your raw GPS coordinates are stored on the server but never shared. Other users see ',
    'only the admin-level fields you choose (country, province, city, district). ',
    'You can clear all location data at any time.'));
}

async function handleEnable() {
  const btn = document.querySelector('.loc-action-row .btn.primary');
  if (btn) { btn.disabled = true; btn.textContent = 'Acquiring…'; }
  const r = await enableLocation();
  if (btn) { btn.disabled = false; }
  if (r.ok) {
    toast(r.formatted ? `Location set: ${r.formatted}` : 'Location updated', 'info', 2500);
    await load();
  } else {
    toast(r.error || 'Failed to enable location', 'error', 5000);
  }
}

async function handleClear() {
  if (!confirm('Clear your location data?')) return;
  const r = await clearLocation();
  if (r.ok) { toast('Location cleared', 'info', 1500); await load(); }
  else toast(`Failed: ${r.error}`, 'error');
}

async function handleGranularityChange(value) {
  const r = await setGranularity(value);
  if (r.ok) {
    await load();
    if (state.profile) state.profile.location_granularity = value;
  }
}