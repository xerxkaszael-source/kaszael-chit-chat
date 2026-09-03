// lib/call.js — WebRTC peer manager for 1-on-1 voice/video calls.
// Per brief §22-26: WebRTC P2P media, Supabase Realtime for signaling only,
// STUN/TURN external. No media ever touches Supabase.
//
// Lifecycle: initiate → ringing → accepted → connecting → connected → ended
//
// Architecture:
//   - signalingChannel: Supabase Realtime broadcast channel per call_id
//     carries JSON: {type: 'offer'|'answer'|'ice'|'bye'|'renegotiate', payload}
//   - DB: calls table + call_ice_candidates (fallback) + RPCs (state machine)
//   - Media: RTCPeerConnection + getUserMedia, both for caller and callee
//
// Authorization (HARDENED v2): signaling authorization is enforced server-side
// via SECURITY DEFINER RPCs (call_initiate/end/ice) and RLS on `calls` +
// `call_ice_candidates`. The Realtime broadcast channel itself is "public" in
// the Supabase sense (any authenticated user could in theory listen on
// `call:<uuid>`), but the JS handler (1) checks `payload.from` against the
// caller/callee ids, (2) drops anything whose `from` is not a participant.
// Plus the postgres_changes subscription on `calls` is RLS-filtered (callers/
// callees only see their own rows). The 'audio'/'voice' route alias was
// removed at the router; the DB column is `kind in ('voice','video')`.
import { rpc, sb } from './db.js';
import { state, notify } from './state.js';
import { toast } from './util.js';

// ICE servers — STUN only by default (free, no auth). Production TURN should
// be provisioned via env vars or a credential-fetch RPC; see comments below.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
  // TURN intentionally omitted — requires auth credentials. Architecture is
  // TURN-ready: pass `iceTransportPolicy: 'relay'` and an array of TURN
  // entries from `window.SUPABASE_CONFIG.iceServers || []` once provisioned.
];
// Optional override (used by tests; never expose in prod logs).
const EXTRA_ICE = (typeof window !== 'undefined' && window.SUPABASE_CONFIG && Array.isArray(window.SUPABASE_CONFIG.iceServers))
  ? window.SUPABASE_CONFIG.iceServers : [];
if (EXTRA_ICE.length) ICE_SERVERS.push(...EXTRA_ICE);

let activeCall = null; // { callId, peer, localStream, remoteStream, kind, role, signaling, state, minimized, position }
const _listeners = new Set();

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit(ev) { for (const fn of _listeners) fn(ev); notify('call'); }

// ---- helpers ----
function getUserId() { return state.profile && state.profile.id; }
function isParticipant(callId) {
  // activeCall tracks current session. Plus the DB calls row enforces it.
  return activeCall && activeCall.callId === callId;
}
// True iff a payload's `from` uid is one of the call's two participants.
function isFromParticipant(payload) {
  if (!payload || !payload.from || !activeCall) return false;
  if (payload.from === activeCall.otherId) return true;
  if (state.profile && payload.from === state.profile.id) return true; // self
  return false;
}

// 60s caller-side timeout. The DB-side miss_sweep handles server-side cleanup
// after 60s, but the caller UI should give up and cancel before then so the
// caller doesn't stare at a ringing screen.
const CALL_TIMEOUT_MS = 50_000;
let _callerTimeoutTimer = null;

// ---- initiate (caller) ----
// In-flight call UUIDs — guards against clicking the caller button twice
// (or while a previous RPC is still in flight). Without this, the second
// click passes the `if (activeCall)` guard (still null) and races a
// second `call_initiate` RPC that may collide with the first row.
const _initInFlight = new Set();
export async function initiate(calleeId, kind = 'voice') {
  if (activeCall) {
    toast(`You're already in a ${activeCall.kind} call`, 'error');
    return null;
  }
  if (_initInFlight.size > 0) {
    toast('Already starting a call…', 'info', 1500);
    return null;
  }
  const inflightKey = `${calleeId}:${kind}`;
  _initInFlight.add(inflightKey);
  try {
    const r = await rpc('call_initiate', { v_callee_id: calleeId, v_kind: kind });
    if (!r?.ok) throw new Error(r?.error || 'initiate_failed');
    activeCall = {
      callId: r.call_id,
      peer: null,
      localStream: null,
      remoteStream: new MediaStream(),
      kind, role: 'caller', state: 'calling',
      otherId: calleeId,
      minimized: false,
      position: null,
      startedAt: Date.now(),
      connectedAt: null
    };
    setupSignaling();
    emit({ type: 'state', call: activeCall });
    // Auto-miss timeout: if no accept within 50s, cancel.
    clearTimeout(_callerTimeoutTimer);
    _callerTimeoutTimer = setTimeout(() => {
      if (activeCall && activeCall.callId === r.call_id && activeCall.state !== 'connected') {
        toast('No answer', 'info');
        cancel();
      }
    }, CALL_TIMEOUT_MS);
    return r.call_id;
  } catch (e) {
    // Auto-self-recover if server says we're already in a call. This handles
    // the case where a stale row from a dropped session is blocking us. We
    // retry ONCE after running the bulk self-recover. If the second attempt
    // also fails (e.g. genuine concurrent call), we surface the error.
    const msg = (e && (e.message || String(e))) || '';
    if (/CHC:busy/i.test(msg)) {
      try {
        const recovered = await rpc('call_self_recover_all', {});
        if (recovered > 0) {
          toast('Cleared a stale call — retrying…', 'info', 2000);
          // Brief delay so the RPC settles + DB triggers update.
          await new Promise(r => setTimeout(r, 300));
          const r2 = await rpc('call_initiate', { v_callee_id: calleeId, v_kind: kind });
          if (!r2?.ok) throw new Error(r2?.error || 'initiate_failed_retry');
          activeCall = {
            callId: r2.call_id,
            peer: null,
            localStream: null,
            remoteStream: new MediaStream(),
            kind, role: 'caller', state: 'calling',
            otherId: calleeId,
            minimized: false,
            position: null,
            startedAt: Date.now(),
            connectedAt: null
          };
          setupSignaling();
          emit({ type: 'state', call: activeCall });
          clearTimeout(_callerTimeoutTimer);
          _callerTimeoutTimer = setTimeout(() => {
            if (activeCall && activeCall.callId === r2.call_id && activeCall.state !== 'connected') {
              toast('No answer', 'info');
              cancel();
            }
          }, CALL_TIMEOUT_MS);
          return r2.call_id;
        }
      } catch (innerErr) {
        // fall through to the error toast below
      }
    }
    toast(`Call failed: ${msg}`, 'error');
    return null;
  } finally {
    _initInFlight.delete(inflightKey);
  }
}

// ---- handle incoming call (callee) ----
export async function handleIncoming(callId, callerId, kind) {
  if (activeCall) {
    // Auto-decline the new one (we're already in a call)
    rpc('call_decline', { v_call_id: callId, v_reason: 'busy' }).catch(() => {});
    return;
  }
  // Reject if we have this user blocked (defense in depth; server also checks
  // in call_initiate, but if the block was added between then and now, this
  // protects us client-side too).
  try {
    const blocks = state.blocks || [];
    if (blocks.includes(callerId)) {
      rpc('call_decline', { v_call_id: callId, v_reason: 'blocked' }).catch(() => {});
      return;
    }
  } catch {}
  activeCall = {
    callId, kind, role: 'callee', state: 'ringing',
    peer: null, localStream: null,
    remoteStream: new MediaStream(),
    otherId: callerId,
    minimized: false,
    position: null,
    startedAt: Date.now(),
    connectedAt: null
  };
  // Tell the caller we got the notification (informational; not strictly required)
  rpc('call_ringing', { v_call_id: callId }).catch(() => {});
  setupSignaling();
  emit({ type: 'incoming', call: activeCall });
  // The DB miss_sweep RPC marks unanswered calls after 60s.
}

// ---- accept (callee) ----
export async function accept() {
  if (!activeCall || activeCall.role !== 'callee') return;
  try {
    // Acquire media BEFORE the RPC so we can answer with media ready
    const stream = await acquireMedia(activeCall.kind);
    activeCall.localStream = stream;
    activeCall.connectedAt = Date.now();
    clearTimeout(_callerTimeoutTimer);
    await rpc('call_accept', { v_call_id: activeCall.callId });
    // Caller will then create the offer; we listen for it on signaling.
    activeCall.state = 'accepted';
    emit({ type: 'state', call: activeCall });
  } catch (e) {
    toast(`Cannot start media: ${friendlyMediaError(e)}`, 'error');
    await decline('media_failed');
  }
}

export async function decline(reason = 'declined') {
  if (!activeCall) return;
  try { await rpc('call_decline', { v_call_id: activeCall.callId, v_reason: reason }); } catch {}
  teardown('declined');
}

export async function cancel() {
  if (!activeCall || activeCall.role !== 'caller') return;
  try { await rpc('call_cancel', { v_call_id: activeCall.callId }); } catch {}
  teardown('cancelled');
}

export async function hangup(reason = 'ended') {
  if (!activeCall) return;
  try { await rpc('call_end', { v_call_id: activeCall.callId, v_reason: reason }); } catch {}
  teardown('ended');
}

// ---- media ----
async function acquireMedia(kind) {
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video' ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' } : false
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

// Translate the most common getUserMedia errors into a useful toast message.
function friendlyMediaError(e) {
  const msg = (e && (e.message || String(e))) || '';
  const name = e && e.name;
  if (name === 'NotAllowedError' || /denied|permission/i.test(msg)) {
    return kind => kind === 'video' ? 'Camera/mic permission denied.' : 'Microphone permission denied.';
  }
  if (name === 'NotFoundError' || /NotFound|not found/i.test(msg)) {
    return 'No microphone/camera found on this device.';
  }
  if (name === 'NotReadableError') {
    return 'Microphone/camera is busy in another app.';
  }
  if (name === 'OverconstrainedError') {
    return 'Camera does not support the requested settings.';
  }
  return msg || 'Could not start media.';
}

function releaseMedia(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch {}
  }
}

function buildPeerConnection() {
  const pc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    iceCandidatePoolSize: 10
  });
  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate && activeCall) {
      // Send via Realtime broadcast (low latency) + persist to DB (fallback).
      // Wrap as JSON for compatibility.
      try {
        sendSignal({ type: 'ice', payload: candidate.toJSON ? candidate.toJSON() : candidate });
      } catch {}
      // DB fallback — server enforces participant + call_id membership.
      rpc('call_ice_candidate', { v_call_id: activeCall.callId, v_candidate: candidate.toJSON() }).catch(() => {});
    }
  });
  pc.addEventListener('track', (ev) => {
    if (!activeCall) return;
    try {
      for (const track of ev.streams[0].getTracks()) {
        activeCall.remoteStream.addTrack(track);
      }
      emit({ type: 'remote-track', call: activeCall });
    } catch (e) {
      console.error('[chc] track handler error', e);
    }
  });
  pc.addEventListener('connectionstatechange', () => {
    if (!activeCall) return;
    const cs = pc.connectionState;
    if (cs === 'connected') {
      activeCall.state = 'connected';
      activeCall.connectedAt = activeCall.connectedAt || Date.now();
      emit({ type: 'state', call: activeCall });
    } else if (cs === 'failed') {
      // ICE failure — attempt ICE restart once before giving up.
      tryIceRestart(pc);
    } else if (cs === 'disconnected') {
      activeCall.state = 'reconnecting';
      emit({ type: 'state', call: activeCall });
      // If we don't recover in 10s, declare failed.
      setTimeout(() => {
        if (activeCall && activeCall.peer === pc && pc.connectionState !== 'connected') {
          tryIceRestart(pc);
        }
      }, 10_000);
    }
  });
  pc.addEventListener('iceconnectionstatechange', () => {
    if (!activeCall) return;
    if (pc.iceConnectionState === 'failed') tryIceRestart(pc);
  });
  return pc;
}

// ICE restart: ask for fresh candidates with new ufrag/pwd.
function tryIceRestart(pc) {
  if (!activeCall || activeCall.peer !== pc) return;
  if (activeCall._iceRestartInFlight) return;
  activeCall._iceRestartInFlight = true;
  try {
    const offer = pc.createOffer({ iceRestart: true });
    offer.then(o => pc.setLocalDescription(o)).then(() => {
      if (activeCall && activeCall.peer === pc) {
        sendSignal({ type: 'offer', payload: pc.localDescription });
      }
    }).catch(() => {});
    // Give the restart ~12s, then declare failed.
    setTimeout(() => {
      if (activeCall && activeCall.peer === pc && pc.connectionState !== 'connected') {
        activeCall.state = 'failed';
        emit({ type: 'state', call: activeCall });
        toast('Call connection failed', 'error');
        hangup('failed');
      }
      activeCall._iceRestartInFlight = false;
    }, 12_000);
  } catch (e) {
    activeCall._iceRestartInFlight = false;
    activeCall.state = 'failed';
    emit({ type: 'state', call: activeCall });
    toast('Call connection failed', 'error');
    hangup('failed');
  }
}

// ---- signaling ----
let signalingChannel = null;
function setupSignaling() {
  if (signalingChannel) { try { sb.removeChannel(signalingChannel); } catch {} }
  signalingChannel = sb.channel(`call:${activeCall.callId}`, { config: { broadcast: { self: false } } });
  signalingChannel
    .on('broadcast', { event: 'signal' }, async ({ payload }) => {
      if (!payload) return;
      if (!isParticipant(activeCall && activeCall.callId)) return;
      if (payload.from === getUserId()) return; // ignore self (server echo)
      if (!isFromParticipant(payload)) {
        console.warn('[chc] dropped signal from non-participant', payload.from);
        return;
      }
      try { await onSignal(payload); }
      catch (e) { console.error('[chc] signal handler error', e); }
    })
    .subscribe();
}

async function onSignal(msg) {
  if (!activeCall) return;
  try {
    if (msg.type === 'answer') {
      if (!activeCall.peer) activeCall.peer = buildPeerConnection();
      if (activeCall.localStream) {
        // Idempotent — only add tracks we don't already have on the sender.
        const existing = activeCall.peer.getSenders().map(s => s.track && s.track.kind);
        for (const track of activeCall.localStream.getTracks()) {
          if (!existing.includes(track.kind)) activeCall.peer.addTrack(track, activeCall.localStream);
        }
      }
      await activeCall.peer.setRemoteDescription(new RTCSessionDescription(msg.payload));
      activeCall.state = 'connected';
      activeCall.connectedAt = activeCall.connectedAt || Date.now();
      clearTimeout(_callerTimeoutTimer);
      emit({ type: 'state', call: activeCall });
    } else if (msg.type === 'offer') {
      if (!activeCall.peer) activeCall.peer = buildPeerConnection();
      if (activeCall.localStream) {
        const existing = activeCall.peer.getSenders().map(s => s.track && s.track.kind);
        for (const track of activeCall.localStream.getTracks()) {
          if (!existing.includes(track.kind)) activeCall.peer.addTrack(track, activeCall.localStream);
        }
      }
      await activeCall.peer.setRemoteDescription(new RTCSessionDescription(msg.payload));
      const answer = await activeCall.peer.createAnswer();
      await activeCall.peer.setLocalDescription(answer);
      sendSignal({ type: 'answer', payload: answer });
    } else if (msg.type === 'ice') {
      if (!activeCall.peer) activeCall.peer = buildPeerConnection();
      try { await activeCall.peer.addIceCandidate(new RTCIceCandidate(msg.payload)); } catch { /* late candidate */ }
    } else if (msg.type === 'bye') {
      teardown(msg.reason || 'ended');
    } else if (msg.type === 'renegotiate') {
      // video <-> voice switch mid-call (out of scope for v1; ignore)
    }
  } catch (e) {
    console.error('[chc] signal handler error', e);
  }
}

function sendSignal(msg) {
  if (!signalingChannel || !activeCall) return;
  signalingChannel.send({
    type: 'broadcast',
    event: 'signal',
    payload: { ...msg, from: getUserId(), call_id: activeCall.callId }
  }).catch(() => {});
}

// Caller starts the WebRTC negotiation after seeing 'accepted' state
// (via realtime subscription on calls table — handled by views/call.js).
export async function startNegotiation() {
  if (!activeCall || activeCall.role !== 'caller') return;
  if (!activeCall.peer) activeCall.peer = buildPeerConnection();
  if (!activeCall.localStream) {
    activeCall.localStream = await acquireMedia(activeCall.kind);
    emit({ type: 'local-stream', call: activeCall });
  }
  // Idempotent track add — don't double-add the same track kind.
  const existing = activeCall.peer.getSenders().map(s => s.track && s.track.kind);
  for (const track of activeCall.localStream.getTracks()) {
    if (!existing.includes(track.kind)) activeCall.peer.addTrack(track, activeCall.localStream);
  }
  const offer = await activeCall.peer.createOffer();
  await activeCall.peer.setLocalDescription(offer);
  sendSignal({ type: 'offer', payload: offer });
  activeCall.state = 'connecting';
  emit({ type: 'state', call: activeCall });
}

// Direct wrapper for call_self_recover (server RPC). Pass the call_id
// and an optional reason; the row gets marked 'failed' server-side.
export async function callSelfRecover(callId, reason = 'user_recovered') {
  try {
    return await rpc('call_self_recover', { v_call_id: callId, v_reason: reason });
  } catch (e) {
    console.error('[chc] callSelfRecover failed', e);
    return null;
  }
}

// ---- local media controls ----
export function toggleMic() {
  if (!activeCall || !activeCall.localStream) return false;
  const track = activeCall.localStream.getAudioTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  emit({ type: 'state', call: activeCall });
  return track.enabled;
}
export function toggleCam() {
  if (!activeCall || !activeCall.localStream) return false;
  const track = activeCall.localStream.getVideoTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  emit({ type: 'state', call: activeCall });
  return track.enabled;
}
export function isMicOn() {
  const t = activeCall && activeCall.localStream && activeCall.localStream.getAudioTracks()[0];
  return !!(t && t.enabled);
}
export function isCamOn() {
  const t = activeCall && activeCall.localStream && activeCall.localStream.getVideoTracks()[0];
  return !!(t && t.enabled);
}

// ---- teardown ----
function teardown(reason) {
  // Best-effort 'bye' broadcast so the other side can drop their channel.
  if (signalingChannel && activeCall) {
    try { signalingChannel.send({
      type: 'broadcast', event: 'signal',
      payload: { type: 'bye', from: getUserId(), call_id: activeCall.callId, reason }
    }); } catch {}
  }
  if (signalingChannel) { try { sb.removeChannel(signalingChannel); } catch {} signalingChannel = null; }
  if (activeCall) {
    releaseMedia(activeCall.localStream);
    // release remote tracks too (belt-and-braces — they should be GC'd anyway)
    if (activeCall.remoteStream) {
      for (const t of activeCall.remoteStream.getTracks()) { try { t.stop(); } catch {} }
    }
    if (activeCall.peer) { try { activeCall.peer.close(); } catch {} }
    const final = Object.assign({}, activeCall, { state: reason });
    activeCall = null;
    emit({ type: 'ended', call: final, reason });
  }
  clearTimeout(_callerTimeoutTimer);
}

// ---- minimize / restore (floating bubble) ----
export function setMinimized(min) {
  if (!activeCall) return;
  activeCall.minimized = !!min;
  emit({ type: 'state', call: activeCall });
}
export function toggleMinimize() {
  if (!activeCall) return null;
  setMinimized(!activeCall.minimized);
  return activeCall.minimized;
}
export function isMinimized() { return !!(activeCall && activeCall.minimized); }

// Set absolute panel position (used by drag in the view layer).
export function setPanelPosition(x, y) {
  if (!activeCall) return;
  activeCall.position = { x, y };
}

// Force-end: cleans up without server RPC. Used on logout / hard reset.
export function forceHangup() {
  if (!activeCall) return;
  teardown('client_reset');
}

// ---- history ----
export async function history(limit = 30, beforeId = null) {
  return rpc('call_history_list', { v_limit: limit, v_before_id: beforeId });
}

// ---- active poll (used on app boot) ----
// Returns the active call row + a flag telling the view layer whether
// the row is "stale" (>60s old in calling/ringing or >120s in reconnecting).
// The view layer uses this to show a "looks abandoned — hang up?" banner.
export async function pollActive() {
  try {
    const r = await rpc('call_active');
    if (r && r.call) {
      // We have an active call but lost local state (refresh?). Restore minimally.
      if (!activeCall) {
        // We can't fully restore the WebRTC session, but at least surface the
        // call row so the user can decide to rejoin or hangup. The view layer
        // (views/call.js) renders an "abandoned call" banner when stale=true.
        const ageMs = Date.now() - new Date(r.call.started_at).getTime();
        const stale = (r.call.state === 'calling' && ageMs > 60_000)
                    || (r.call.state === 'ringing' && ageMs > 60_000)
                    || (r.call.state === 'reconnecting' && ageMs > 120_000);
        emit({ type: 'rehydrate', call: r.call, stale });
      }
    }
  } catch {}
}

// Same as pollActive but proactively cleans up OUR stale rows BEFORE the
// busy-check fires. Called on app boot, after sign-in, and whenever we
// suspect the user might be stuck.
export async function selfRecoverStale() {
  try {
    const n = await rpc('call_self_recover_all', {});
    return n;
  } catch { return 0; }
}

// Hard cleanup on tab close / refresh during an active call.
// What we CAN reliably do during unload:
//   1. Stop all local media tracks (releases camera/mic LED)
//   2. Close the RTCPeerConnection
//   3. Tear down the signaling channel
// What we CANNOT do (and rely on DB safety nets for):
//   - Call `call_end` RPC: it requires the user's auth JWT, but
//     getSession() / fetch / sendBeacon with custom headers don't survive
//     unload reliably. sendBeacon can't carry auth headers at all.
//     pg_cron (1-min schedule) + caller-side 50s timeout are the real
//     safety nets for "row stays because client crashed mid-call".
export function installUnloadCleanup() {
  if (typeof window === 'undefined') return;
  // Guard for non-browser envs (Node tests, SSR): window may not have
  // addEventListener (Node global doesn't).
  if (typeof window.addEventListener !== 'function') return;
  if (typeof window.removeEventListener !== 'function') return;
  const cleanup = () => {
    if (!activeCall) return;
    // Force-teardown local resources synchronously. DB row cleanup is the
    // pg_cron job's responsibility.
    try {
      releaseMedia(activeCall.localStream);
      if (activeCall.peer) activeCall.peer.close();
      if (signalingChannel) sb.removeChannel(signalingChannel);
    } catch {}
  };
  window.addEventListener('beforeunload', cleanup);
  window.addEventListener('pagehide', cleanup);
}

export function getActive() { return activeCall; }

// Elapsed seconds since connected (for the duration display).
export function getElapsedSec() {
  if (!activeCall || !activeCall.connectedAt) return 0;
  return Math.max(0, Math.floor((Date.now() - activeCall.connectedAt) / 1000));
}