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

// =====================================================================
// CALL STATE MACHINE
// =====================================================================
// The state machine is the single source of truth for call lifecycle.
// `activeCall.state` is the canonical current state; transitions are
// validated by `setCallState()` which no-ops invalid transitions.
//
// Valid states (per spec §2):
//   idle             — no call in progress
//   outgoing_calling — A initiated, awaiting B accept
//   outgoing_ringing — B's side is ringing (informational)
//   incoming_ringing — B is seeing the incoming bubble
//   accepting        — B clicked Accept, requesting media
//   connecting       — B's media acquired, waiting for WebRTC connect
//   connected        — WebRTC PeerConnection state = connected
//   reconnecting     — transient ICE disconnect
//   declining        — Decline RPC in flight
//   declined         — terminal: B declined
//   cancelled        — terminal: A cancelled
//   busy             — terminal: rejected by busy check
//   timeout          — terminal: ring/no-answer timeout
//   failed           — terminal: media or WebRTC failed
//   ending           — Hangup RPC in flight
//   ended            — terminal: clean hangup
//
// All terminal states are kept in the `callHistory` set so that any
// leftover timers/callbacks guarded by `if (activeCall?.callId === X)`
// will correctly see "the call ended, drop the work".
const TERMINAL_STATES = new Set(['declined', 'cancelled', 'busy', 'timeout', 'failed', 'ended']);
// Allowed transitions: from → [...to]
const ALLOWED = {
  idle:             ['outgoing_calling', 'incoming_ringing'],
  outgoing_calling:  ['incoming_ringing', 'outgoing_ringing', 'cancelled', 'busy', 'timeout', 'ended', 'failed'],
  outgoing_ringing:  ['connecting', 'cancelled', 'declined', 'timeout', 'failed', 'ended'],
  incoming_ringing:  ['accepting', 'declining', 'declined', 'cancelled', 'timeout', 'failed', 'ended'],
  accepting:        ['connecting', 'failed', 'ended', 'declining'],     // failed = permission denied
  connecting:       ['connected', 'failed', 'reconnecting', 'ended'],
  connected:        ['reconnecting', 'ending', 'ended', 'failed'],
  reconnecting:     ['connected', 'failed', 'ended'],
  declining:        ['declined', 'ended'],
  ending:           ['ended', 'failed'],
  // terminal:
  declined:         [],
  cancelled:        [],
  busy:             [],
  timeout:          [],
  failed:           [],
  ended:            [],
};
function isTerminal(s) { return TERMINAL_STATES.has(s); }
function canTransition(from, to) {
  if (isTerminal(from)) return false;
  const allowed = ALLOWED[from] || [];
  return allowed.includes(to);
}
function setCallState(callObj, next) {
  if (!callObj) return false;
  if (callObj.state === next) return true; // idempotent
  if (!canTransition(callObj.state, next)) {
    console.warn('[chc-call] invalid transition', callObj.state, '→', next, 'for call', callObj.callId);
    return false;
  }
  callObj.state = next;
  callObj.stateAt = Date.now();
  return true;
}

// Module state.
// `activeCall` is the canonical state for one call. It NEVER disappears
// during valid transitions — only when the call reaches a terminal state
// AND teardown is called. The state machine ensures this invariant.
let activeCall = null;       // { callId, peer, localStream, remoteStream, kind, role, state, minimized, position, kind, ... }
const _listeners = new Set();
const _pendingSignalingByCallId = new Map(); // callId → Array<signal msg> (for offer-arrives-before-accept)

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit(ev) { for (const fn of _listeners) fn(ev); notify('call'); }

// Per-call timer handles so we can cancel them safely without killing other calls.
const _callerTimeoutTimerByCallId = new Map();

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
// caller doesn't stare at a ringing screen. Per-call so each call has its
// own timeout; clearing one doesn't affect others.
const CALL_TIMEOUT_MS = 50_000;

// ---- initiate (caller) ----
// In-flight call UUIDs — guards against clicking the caller button twice
// (or while a previous RPC is still in flight). Without this, the second
// click passes the `if (activeCall)` guard (still null) and races a
// second `call_initiate` RPC that may collide with the first row.
const _initInFlight = new Set();
export async function initiate(calleeId, kind = 'voice') {
  if (activeCall && !isTerminal(activeCall.state)) {
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
    // Build canonical activeCall with state machine.
    activeCall = {
      callId: r.call_id,
      peer: null,
      localStream: null,
      remoteStream: new MediaStream(),
      kind, role: 'caller',
      // State machine: outgoing_calling (we initiated, waiting for callee)
      state: 'outgoing_calling',
      stateAt: Date.now(),
      otherId: calleeId,
      minimized: false,
      position: null,
      startedAt: Date.now(),
      connectedAt: null,
      _acceptInFlight: false,
    };
    setupSignaling();
    emit({ type: 'state', call: activeCall });

    // Per-call-id caller timeout (NOT a module-global timer that could leak).
    armCallerTimeout(activeCall.callId, CALL_TIMEOUT_MS);

    return r.call_id;
  } catch (e) {
    const msg = (e && (e.message || String(e))) || '';
    if (/CHC:busy/i.test(msg)) {
      try {
        const recovered = await rpc('call_self_recover_all', {});
        if (recovered > 0) {
          toast('Cleared a stale call — retrying…', 'info', 2000);
          await new Promise(r => setTimeout(r, 300));
          const r2 = await rpc('call_initiate', { v_callee_id: calleeId, v_kind: kind });
          if (!r2?.ok) throw new Error(r2?.error || 'initiate_failed_retry');
          activeCall = {
            callId: r2.call_id,
            peer: null,
            localStream: null,
            remoteStream: new MediaStream(),
            kind, role: 'caller',
            state: 'outgoing_calling',
            stateAt: Date.now(),
            otherId: calleeId,
            minimized: false,
            position: null,
            startedAt: Date.now(),
            connectedAt: null,
            _acceptInFlight: false,
          };
          setupSignaling();
          emit({ type: 'state', call: activeCall });
          armCallerTimeout(activeCall.callId, CALL_TIMEOUT_MS);
          return r2.call_id;
        }
      } catch (innerErr) {
        // fall through
      }
    }
    toast(`Call failed: ${msg}`, 'error');
    return null;
  } finally {
    _initInFlight.delete(inflightKey);
  }
}

// Arm a caller-side timeout for a specific call_id. Cancels itself if the call
// transitions past `outgoing_calling` or reaches a terminal state, OR if a
// new call with a different id starts (so we don't leak).
function armCallerTimeout(callId, ms) {
  cancelCallerTimeout(callId);
  const t = setTimeout(() => {
    _callerTimeoutTimerByCallId.delete(callId);
    // Only fire if THIS call is still in the right state.
    if (activeCall && activeCall.callId === callId && activeCall.state === 'outgoing_calling') {
      console.info('[chc-call] caller timeout for', callId);
      toast('No answer', 'info');
      cancel().catch(() => {});
    }
  }, ms);
  _callerTimeoutTimerByCallId.set(callId, t);
}
function cancelCallerTimeout(callId) {
  const t = _callerTimeoutTimerByCallId.get(callId);
  if (t) { clearTimeout(t); _callerTimeoutTimerByCallId.delete(callId); }
}

// ---- handle incoming call (callee) ----
export async function handleIncoming(callId, callerId, kind) {
  // If we're already in a non-terminal call, auto-decline (we're busy).
  // Use setCallState so the existing call's state machine is consistent.
  if (activeCall && !isTerminal(activeCall.state)) {
    rpc('call_decline', { v_call_id: callId, v_reason: 'busy' }).catch(() => {});
    return;
  }
  // Reject if caller is blocked (defense in depth; server also checks).
  try {
    const blocks = state.blocks || [];
    if (blocks.includes(callerId)) {
      rpc('call_decline', { v_call_id: callId, v_reason: 'blocked' }).catch(() => {});
      return;
    }
  } catch (e) {}
  // Build the canonical activeCall in the `incoming_ringing` state.
  // From here, the callee's UI (managed by call-manager.js) shows the
  // incoming bubble. The state NEVER goes back to null until teardown.
  activeCall = {
    callId, kind, role: 'callee',
    state: 'incoming_ringing',
    stateAt: Date.now(),
    peer: null, localStream: null,
    remoteStream: new MediaStream(),
    otherId: callerId,
    minimized: false,
    position: null,
    startedAt: Date.now(),
    connectedAt: null,
    _acceptInFlight: false,
    _permissionError: null,
  };
  // Inform the caller we got the notification (informational).
  rpc('call_ringing', { v_call_id: callId }).catch(() => {});
  setupSignaling();
  emit({ type: 'incoming', call: activeCall });
  // DB miss_sweep RPC handles 60s timeout server-side.
}

// ---- accept (callee) ----
// Atomic state transition: incoming_ringing → accepting → (media) → connecting.
// CRITICAL: never leaves `activeCall` null between steps (Bug #1 fix).
// If media fails: transitions to `failed` with `_permissionError` set so
// the UI can show a retry button — does NOT silently teardown (Bug #1+#3 fix).
export async function accept() {
  if (!activeCall || activeCall.role !== 'callee') return;
  if (isTerminal(activeCall.state)) return;
  // Idempotency: if already accepting, no-op (prevents double-click race).
  if (activeCall._acceptInFlight) return;
  activeCall._acceptInFlight = true;

  // Step 1: transition to 'accepting' (UI updates immediately).
  if (!setCallState(activeCall, 'accepting')) return;
  cancelCallerTimeout(activeCall.callId);
  emit({ type: 'state', call: activeCall });

  try {
    // Step 2: secure context check (spec §11).
    if (typeof window !== 'undefined' && window.isSecureContext === false) {
      throw makeMediaError('SecurityError',
        'Page is not in a secure context. Kaszael Ngobrol requires HTTPS to access the camera/microphone.');
    }

    // Step 3: mediaDevices availability (spec §11).
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw makeMediaError('NotSupportedError',
        'Camera/microphone access is not supported in this browser.');
    }

    // Step 4: acquire media (the user-gesture path; browser shows prompt).
    //         Voice = audio only. Video = audio + video (spec §8/§9).
    const stream = await acquireMedia(activeCall.kind);
    activeCall.localStream = stream;

    // Step 5: transition to 'connecting'.
    if (!setCallState(activeCall, 'connecting')) return;
    emit({ type: 'state', call: activeCall });

    // Step 6: call_accept RPC — server-authoritative state change.
    //         (If this fails, we surface the error but keep activeCall so the
    //         user can hangup cleanly.)
    try {
      await rpc('call_accept', { v_call_id: activeCall.callId });
    } catch (rpcErr) {
      // Server rejected — most likely the call was cancelled/ended.
      const msg = rpcErr && (rpcErr.message || String(rpcErr)) || '';
      console.warn('[chc-call] call_accept RPC failed', msg);
      if (/CHC:not_found/i.test(msg)) {
        // Caller cancelled before we accepted.
        if (setCallState(activeCall, 'cancelled')) emit({ type: 'state', call: activeCall });
        teardown('cancelled');
        return;
      }
      // Otherwise: keep call going, the user can still talk — the server may
      // eventually time out the row and our caller-side UI will reflect it.
    }

    // Step 7: signaling — caller may already have sent an offer.
    //         Process any pending signaling first, then notify caller we're ready.
    drainPendingSignaling(activeCall.callId);
    // Caller will create the offer when it sees our 'accepted' UPDATE event
    // (handled in call-manager.onCallsUpdate).
  } catch (e) {
    // Permission or other media error — transition to `failed` with the
    // error details attached so the UI can show a retry banner.
    console.warn('[chc-call] accept failed', e);
    activeCall._permissionError = friendlyMediaError(e, activeCall.kind);
    if (setCallState(activeCall, 'failed')) emit({ type: 'state', call: activeCall });
    // Do NOT teardown — the user needs to see the failure + retry option.
    // They can hangup via the bubble's hangup button.
  } finally {
    if (activeCall) activeCall._acceptInFlight = false;
  }
}

// ---- decline (callee) ----
export async function decline(reason = 'declined') {
  if (!activeCall) return;
  if (isTerminal(activeCall.state)) return;
  if (activeCall.role !== 'callee') return;
  if (!setCallState(activeCall, 'declining')) return;
  emit({ type: 'state', call: activeCall });
  cancelCallerTimeout(activeCall.callId);
  try { await rpc('call_decline', { v_call_id: activeCall.callId, v_reason: reason }); } catch (e) {}
  // Use 'declined' if reason is 'declined', else keep the reason text.
  teardown(reason === 'declined' ? 'declined' : reason);
}

// ---- cancel (caller before accept) ----
export async function cancel() {
  if (!activeCall) return;
  if (activeCall.role !== 'caller') return;
  if (isTerminal(activeCall.state)) return;
  cancelCallerTimeout(activeCall.callId);
  if (!setCallState(activeCall, 'cancelled')) return;
  emit({ type: 'state', call: activeCall });
  try { await rpc('call_cancel', { v_call_id: activeCall.callId }); } catch (e) {}
  teardown('cancelled');
}

// ---- hangup (either side, any non-terminal state) ----
// Always teardown after a fixed timeout so the UI can never get stuck
// showing the panel if call_end RPC hangs (Bug C fix).
const HANGUP_FALLBACK_MS = 3000;
export async function hangup(reason = 'ended') {
  if (!activeCall) return;
  if (isTerminal(activeCall.state)) return;
  cancelCallerTimeout(activeCall.callId);
  if (!setCallState(activeCall, 'ending')) return;
  emit({ type: 'state', call: activeCall });
  // Start a hard timeout that fires teardown unconditionally. Even if the
  // RPC hangs or the user closes the tab, this guarantees the panel goes away.
  const fallback = setTimeout(() => {
    if (activeCall && !isTerminal(activeCall.state)) {
      console.warn('[chc-call] hangup fallback fired — RPC took too long');
      teardown(reason);
    }
  }, HANGUP_FALLBACK_MS);
  try {
    await rpc('call_end', { v_call_id: activeCall.callId, v_reason: reason });
    clearTimeout(fallback);
    teardown('ended');
  } catch (e) {
    // RPC failed — clear fallback (it'll fire teardown on its own if needed),
    // but teardown now so the user isn't left waiting.
    clearTimeout(fallback);
    console.warn('[chc-call] hangup RPC failed, forcing teardown', e);
    teardown('ended');
  }
}

// ---- media ----
async function acquireMedia(kind) {
  const constraints = {
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    video: kind === 'video'
      ? { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }
      : false
  };
  return navigator.mediaDevices.getUserMedia(constraints);
}

// Build a synthetic DOMException-like error for failures we detect BEFORE
// getUserMedia is called (secure-context, no-mediaDevices). We attach .name
// so friendlyMediaError's switch can match it.
function makeMediaError(name, message) {
  let err;
  try {
    err = new DOMException(message, name);
  } catch (_) {
    err = new Error(message);
    err.name = name;
  }
  return err;
}

// Translate the most common getUserMedia errors into a useful toast message.
// `kind` is 'voice' or 'video' so we can tailor the prompt.
function friendlyMediaError(e, kind) {
  const msg = (e && (e.message || String(e))) || '';
  const name = e && e.name;
  // Build rich, actionable messages per spec §10.
  if (name === 'SecurityError' || /secure context|insecure/i.test(msg)) {
    return 'Page must be loaded over HTTPS to access the microphone and camera.';
  }
  if (name === 'NotAllowedError' || /denied|permission/i.test(msg)) {
    if (kind === 'video') {
      return 'Camera/microphone permission denied. Please allow camera AND microphone access for Kaszael Ngobrol in your browser\u2019s site settings, then try again.';
    }
    return 'Microphone permission denied. Please allow microphone access for Kaszael Ngobrol in your browser\u2019s site settings, then try again.';
  }
  if (name === 'NotFoundError' || /NotFound|not found/i.test(msg)) {
    if (kind === 'video') return 'No microphone or camera was detected on this device.';
    return 'No microphone was detected on this device.';
  }
  if (name === 'NotReadableError' || /in use|busy/i.test(msg)) {
    return 'Microphone or camera is in use by another application. Close other apps and try again.';
  }
  if (name === 'OverconstrainedError' || /constraint/i.test(msg)) {
    return 'Camera does not support the requested settings. Try again with default settings.';
  }
  if (name === 'NotSupportedError' || /not supported/i.test(msg)) {
    return 'Camera/microphone access is not supported in this browser.';
  }
  if (name === 'AbortError' || /aborted/i.test(msg)) {
    return 'Microphone/camera access was interrupted. Please try again.';
  }
  // Fallback: use the raw message (truncated).
  return msg ? msg.split('\n')[0].slice(0, 200) : 'Could not start media.';
}

function releaseMedia(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try { track.stop(); } catch (e) {}
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
      } catch (e) {}
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
      setCallState(activeCall, 'connected');
      activeCall.connectedAt = activeCall.connectedAt || Date.now();
      emit({ type: 'state', call: activeCall });
    } else if (cs === 'failed') {
      // ICE failure — attempt ICE restart once before giving up.
      tryIceRestart(pc);
    } else if (cs === 'disconnected') {
      setCallState(activeCall, 'reconnecting');
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
    setTimeout(() => {
      if (activeCall && activeCall.peer === pc && pc.connectionState !== 'connected') {
        if (setCallState(activeCall, 'failed')) emit({ type: 'state', call: activeCall });
        toast('Call connection failed', 'error');
        hangup('failed').catch(() => {});
      }
      if (activeCall) activeCall._iceRestartInFlight = false;
    }, 12_000);
  } catch (e) {
    if (activeCall) activeCall._iceRestartInFlight = false;
    if (setCallState(activeCall, 'failed')) emit({ type: 'state', call: activeCall });
    toast('Call connection failed', 'error');
    hangup('failed').catch(() => {});
  }
}

// ---- signaling ----
let signalingChannel = null;
function setupSignaling() {
  if (signalingChannel) { try { sb.removeChannel(signalingChannel); } catch (e) {} }
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
      // Race-safe: if we're still in incoming_ringing/accepting (not yet
      // accepting → connecting), queue the signaling so we can process it
      // after media is acquired. This handles the "offer arrives before
      // Accept click" race (spec §28).
      const cur = activeCall;
      if (cur && cur.role === 'callee' &&
          (cur.state === 'incoming_ringing' || cur.state === 'accepting')) {
        let q = _pendingSignalingByCallId.get(cur.callId);
        if (!q) { q = []; _pendingSignalingByCallId.set(cur.callId, q); }
        q.push(payload);
        console.info('[chc] queued signaling during pre-accept state');
        return;
      }
      try { await onSignal(payload); }
      catch (e) { console.error('[chc] signal handler error', e); }
    })
    .subscribe();
}

// Drain queued signaling messages that arrived before accept completed.
async function drainPendingSignaling(callId) {
  const q = _pendingSignalingByCallId.get(callId);
  if (!q || !q.length) return;
  _pendingSignalingByCallId.delete(callId);
  for (const payload of q) {
    try { await onSignal(payload); }
    catch (e) { console.error('[chc] drainPendingSignaling error', e); }
  }
}

async function onSignal(msg) {
  if (!activeCall) return;
  try {
    if (msg.type === 'answer') {
      if (!activeCall.peer) activeCall.peer = buildPeerConnection();
      if (activeCall.localStream) {
        const existing = activeCall.peer.getSenders().map(s => s.track && s.track.kind);
        for (const track of activeCall.localStream.getTracks()) {
          if (!existing.includes(track.kind)) activeCall.peer.addTrack(track, activeCall.localStream);
        }
      }
      await activeCall.peer.setRemoteDescription(new RTCSessionDescription(msg.payload));
      setCallState(activeCall, 'connected');
      activeCall.connectedAt = activeCall.connectedAt || Date.now();
      cancelCallerTimeout(activeCall.callId);
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
      try { await activeCall.peer.addIceCandidate(new RTCIceCandidate(msg.payload)); } catch (e) { /* late candidate */ }
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
// (via realtime subscription on calls table — handled by call-manager.js).
export async function startNegotiation() {
  if (!activeCall || activeCall.role !== 'caller') return;
  if (isTerminal(activeCall.state)) return;
  if (!activeCall.peer) activeCall.peer = buildPeerConnection();
  if (!activeCall.localStream) {
    try {
      activeCall.localStream = await acquireMedia(activeCall.kind);
    } catch (e) {
      console.warn('[chc-call] caller getUserMedia failed', e);
      activeCall._permissionError = friendlyMediaError(e, activeCall.kind);
      if (setCallState(activeCall, 'failed')) emit({ type: 'state', call: activeCall });
      toast(`Cannot start media: ${activeCall._permissionError}`, 'error');
      return;
    }
    emit({ type: 'local-stream', call: activeCall });
  }
  // Idempotent track add.
  const existing = activeCall.peer.getSenders().map(s => s.track && s.track.kind);
  for (const track of activeCall.localStream.getTracks()) {
    if (!existing.includes(track.kind)) activeCall.peer.addTrack(track, activeCall.localStream);
  }
  try {
    const offer = await activeCall.peer.createOffer();
    await activeCall.peer.setLocalDescription(offer);
    sendSignal({ type: 'offer', payload: offer });
    setCallState(activeCall, 'connecting');
    emit({ type: 'state', call: activeCall });
  } catch (e) {
    console.error('[chc-call] startNegotiation failed', e);
    if (setCallState(activeCall, 'failed')) emit({ type: 'state', call: activeCall });
    toast(`Negotiation failed: ${e.message || e}`, 'error');
  }
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
  // Only run if we actually have a call (avoid spurious cleanup).
  if (!activeCall) return;
  const prev = activeCall;
  if (!isTerminal(prev.state)) {
    // Reuse the requested reason as the state if it's a terminal state,
    // otherwise fall back to 'ended'.
    const terminal = TERMINAL_STATES.has(reason) ? reason : 'ended';
    setCallState(prev, terminal);
  }
  cancelCallerTimeout(prev.callId);
  // Drop any queued signaling for this call.
  _pendingSignalingByCallId.delete(prev.callId);
  // Best-effort 'bye' broadcast so the other side can drop their channel.
  if (signalingChannel) {
    try { signalingChannel.send({
      type: 'broadcast', event: 'signal',
      payload: { type: 'bye', from: getUserId(), call_id: prev.callId, reason }
    }); } catch (e) {}
  }
  if (signalingChannel) { try { sb.removeChannel(signalingChannel); } catch (e) {} signalingChannel = null; }
  releaseMedia(prev.localStream);
  if (prev.remoteStream) {
    for (const t of prev.remoteStream.getTracks()) { try { t.stop(); } catch (e) {} }
  }
  if (prev.peer) { try { prev.peer.close(); } catch (e) {} }
  const final = Object.assign({}, prev, { state: reason });
  activeCall = null;
  emit({ type: 'ended', call: final, reason });
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
  } catch (e) {}
}

// Same as pollActive but proactively cleans up OUR stale rows BEFORE the
// busy-check fires. Called on app boot, after sign-in, and whenever we
// suspect the user might be stuck.
export async function selfRecoverStale() {
  try {
    const n = await rpc('call_self_recover_all', {});
    return n;
  } catch (e) { return 0; }
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
    } catch (e) {}
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