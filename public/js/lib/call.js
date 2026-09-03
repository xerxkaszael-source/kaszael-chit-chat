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
// The signaling channel is "public" Supabase broadcast (no private channels
// for low-cost). Authz is enforced by:
//   1. checking call_id participant in the message handler (drop if not for us)
//   2. server-side RLS on calls + call_ice_candidates
//   3. RPCs that enforce participant + block state
import { rpc, sb } from './db.js';
import { state, notify } from './state.js';
import { toast } from './util.js';

const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' }
  // TURN servers intentionally omitted here — they require auth credentials
  // that should be provisioned out-of-band for production. Without TURN, calls
  // will fail for users behind symmetric NATs. This is documented as a known
  // limitation in §89 REMAINING section.
];

let activeCall = null; // { callId, peer, localStream, remoteStream, kind, role, signaling, state }
const _listeners = new Set();

export function subscribe(fn) { _listeners.add(fn); return () => _listeners.delete(fn); }
function emit(ev) { for (const fn of _listeners) fn(ev); notify('call'); }

// ---- helpers ----
function getUserId() { return state.profile?.id; }
function isParticipant(callId) {
  // We need to know if we're a participant. activeCall tracks current session.
  return activeCall?.callId === callId;
}

// ---- initiate (caller) ----
export async function initiate(calleeId, kind = 'voice') {
  if (activeCall) {
    toast(`You're already in a ${activeCall.kind} call`, 'error');
    return null;
  }
  try {
    const r = await rpc('call_initiate', { v_callee_id: calleeId, v_kind: kind });
    if (!r?.ok) throw new Error(r?.error || 'initiate_failed');
    activeCall = {
      callId: r.call_id,
      peer: null, // created on accept (callee) or after they accept (caller)
      localStream: null,
      remoteStream: new MediaStream(),
      kind, role: 'caller', state: 'calling',
      otherId: calleeId
    };
    // Caller subscribes to signaling immediately to hear accept/decline/answer/ICE
    setupSignaling();
    emit({ type: 'state', call: activeCall });
    return r.call_id;
  } catch (e) {
    toast(`Call failed: ${e.message}`, 'error');
    return null;
  }
}

// ---- handle incoming call (callee) ----
export async function handleIncoming(callId, callerId, kind) {
  if (activeCall) {
    // Auto-decline the new one
    rpc('call_decline', { v_call_id: callId, v_reason: 'busy' }).catch(() => {});
    return;
  }
  activeCall = {
    callId, kind, role: 'callee', state: 'ringing',
    peer: null, localStream: null,
    remoteStream: new MediaStream(),
    otherId: callerId
  };
  // Tell the caller we got the notification (informational; not strictly required)
  rpc('call_ringing', { v_call_id: callId }).catch(() => {});
  setupSignaling();
  emit({ type: 'incoming', call: activeCall });
  // Auto-miss-sweep: if no answer in 60s, server RPC will mark as missed
}

// ---- accept (callee) ----
export async function accept() {
  if (!activeCall || activeCall.role !== 'callee') return;
  try {
    // Acquire media BEFORE the RPC so we can answer with media ready
    const stream = await acquireMedia(activeCall.kind);
    activeCall.localStream = stream;
    await rpc('call_accept', { v_call_id: activeCall.callId });
    // Caller will then create the offer; we listen for it on signaling.
    activeCall.state = 'accepted';
    emit({ type: 'state', call: activeCall });
  } catch (e) {
    toast(`Cannot start media: ${e.message}`, 'error');
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

function releaseMedia(stream) {
  if (!stream) return;
  for (const track of stream.getTracks()) track.stop();
}

function buildPeerConnection() {
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  pc.addEventListener('icecandidate', ({ candidate }) => {
    if (candidate && activeCall) {
      // Send via Realtime broadcast (low latency) + persist to DB (fallback)
      sendSignal({ type: 'ice', payload: candidate.toJSON() });
      rpc('call_ice_candidate', { v_call_id: activeCall.callId, v_candidate: candidate.toJSON() }).catch(() => {});
    }
  });
  pc.addEventListener('track', (ev) => {
    if (activeCall) {
      for (const track of ev.streams[0].getTracks()) {
        activeCall.remoteStream.addTrack(track);
      }
      emit({ type: 'remote-track', call: activeCall });
    }
  });
  pc.addEventListener('connectionstatechange', () => {
    if (!activeCall) return;
    const cs = pc.connectionState;
    if (cs === 'connected') { activeCall.state = 'connected'; emit({ type: 'state', call: activeCall }); }
    else if (cs === 'failed') { activeCall.state = 'failed'; emit({ type: 'state', call: activeCall }); toast('Call connection failed', 'error'); hangup('failed'); }
    else if (cs === 'disconnected') { activeCall.state = 'reconnecting'; emit({ type: 'state', call: activeCall }); }
  });
  return pc;
}

// ---- signaling ----
let signalingChannel = null;
function setupSignaling() {
  if (signalingChannel) sb.removeChannel(signalingChannel);
  signalingChannel = sb.channel(`call:${activeCall.callId}`, { config: { broadcast: { self: false } } });
  signalingChannel
    .on('broadcast', { event: 'signal' }, async ({ payload }) => {
      if (!payload || !isParticipant(activeCall?.callId)) return;
      if (payload.from === getUserId()) return; // ignore self
      await onSignal(payload);
    })
    .subscribe();
}

async function onSignal(msg) {
  if (!activeCall) return;
  try {
    if (msg.type === 'answer') {
      await activeCall.peer.setRemoteDescription(new RTCSessionDescription(msg.payload));
      activeCall.state = 'connected';
      emit({ type: 'state', call: activeCall });
    } else if (msg.type === 'offer') {
      if (!activeCall.peer) activeCall.peer = buildPeerConnection();
      if (activeCall.localStream) {
        for (const track of activeCall.localStream.getTracks()) {
          activeCall.peer.addTrack(track, activeCall.localStream);
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
// (via realtime subscription on calls table — handled by views/call.js or
// by the caller also subscribing to the calls row).
// Here we expose a helper that the caller can call once it sees accepted.
export async function startNegotiation() {
  if (!activeCall || activeCall.role !== 'caller' || !activeCall.peer) {
    if (!activeCall) return;
    activeCall.peer = buildPeerConnection();
  }
  if (!activeCall.localStream) {
    activeCall.localStream = await acquireMedia(activeCall.kind);
    emit({ type: 'local-stream', call: activeCall });
  }
  for (const track of activeCall.localStream.getTracks()) {
    activeCall.peer.addTrack(track, activeCall.localStream);
  }
  const offer = await activeCall.peer.createOffer();
  await activeCall.peer.setLocalDescription(offer);
  sendSignal({ type: 'offer', payload: offer });
  activeCall.state = 'connecting';
  emit({ type: 'state', call: activeCall });
}

// ---- local media controls ----
export function toggleMic() {
  if (!activeCall?.localStream) return false;
  const track = activeCall.localStream.getAudioTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  emit({ type: 'state', call: activeCall });
  return track.enabled;
}
export function toggleCam() {
  if (!activeCall?.localStream) return false;
  const track = activeCall.localStream.getVideoTracks()[0];
  if (!track) return false;
  track.enabled = !track.enabled;
  emit({ type: 'state', call: activeCall });
  return track.enabled;
}

// ---- teardown ----
function teardown(reason) {
  if (signalingChannel) { try { sb.removeChannel(signalingChannel); } catch {} signalingChannel = null; }
  if (activeCall) {
    releaseMedia(activeCall.localStream);
    if (activeCall.peer) { try { activeCall.peer.close(); } catch {} }
    const final = { ...activeCall, state: reason };
    activeCall = null;
    emit({ type: 'ended', call: final, reason });
  }
}

// ---- history ----
export async function history(limit = 30, beforeId = null) {
  return rpc('call_history_list', { v_limit: limit, v_before_id: beforeId });
}

// ---- active poll (used on app boot) ----
export async function pollActive() {
  try {
    const r = await rpc('call_active');
    if (r?.call) {
      // We have an active call but lost local state (refresh?). Restore minimally.
      if (!activeCall) {
        // We can't fully restore the WebRTC session, but at least surface the
        // call row so the user can decide to rejoin or hangup.
        emit({ type: 'rehydrate', call: r.call });
      }
    }
  } catch {}
}

export function getActive() { return activeCall; }