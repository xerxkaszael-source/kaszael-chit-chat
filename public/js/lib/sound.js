// sound.js — Web Audio notification sounds (no assets needed)
let ctx = null;
let enabled = true;

function ac() {
  if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}

function tone(freq, t0, dur, type = 'sine', gain = 0.08) {
  const a = ac();
  const o = a.createOscillator(), g = a.createGain();
  o.type = type; o.frequency.value = freq;
  g.gain.setValueAtTime(0, a.currentTime + t0);
  g.gain.linearRampToValueAtTime(gain, a.currentTime + t0 + 0.015);
  g.gain.exponentialRampToValueAtTime(0.0001, a.currentTime + t0 + dur);
  o.connect(g).connect(a.destination);
  o.start(a.currentTime + t0);
  o.stop(a.currentTime + t0 + dur + 0.05);
}

export function setSoundEnabled(v) { enabled = !!v; }
export function soundEnabled() { return enabled; }

// pleasant two-tone "pop" for incoming chat messages
export function playMessageSound() {
  if (!enabled) return;
  try {
    tone(880, 0, 0.12, 'sine', 0.06);
    tone(1318.5, 0.07, 0.16, 'sine', 0.045);
  } catch { /* audio blocked until first gesture — ignore */ }
}

// Distinct three-tone "knock" for incoming private DMs (so user knows it's DM,
// not a general chat message). Higher pitch than mention so it's not confused.
export function playDmSound() {
  if (!enabled) return;
  try {
    tone(987.77, 0, 0.10, 'sine', 0.06);
    tone(1318.5, 0.08, 0.12, 'sine', 0.05);
    tone(1567.98, 0.18, 0.18, 'sine', 0.045);
  } catch {}
}

export function playMentionSound() {
  if (!enabled) return;
  try {
    tone(659.25, 0, 0.12, 'triangle', 0.07);
    tone(987.77, 0.08, 0.14, 'triangle', 0.06);
    tone(1318.5, 0.16, 0.18, 'triangle', 0.05);
  } catch {}
}

export function playBroadcastSound() {
  if (!enabled) return;
  try {
    tone(523.25, 0, 0.16, 'triangle', 0.08);
    tone(659.25, 0.12, 0.16, 'triangle', 0.08);
    tone(783.99, 0.24, 0.24, 'triangle', 0.08);
  } catch {}
}

// unlock audio on first user gesture (mobile autoplay policy)
export function installAudioUnlock() {
  const unlock = () => { try { ac(); } catch {} };
  document.addEventListener('pointerdown', unlock, { once: true });
  document.addEventListener('keydown', unlock, { once: true });
}
