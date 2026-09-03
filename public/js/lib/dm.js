// lib/dm.js — DM data access layer. Wraps the 21 DM RPCs with typed JS helpers.
// All mutations go through RPCs (auth.uid() set by Supabase session).
import { rpc } from './db.js';
import { state } from './state.js';

// ---- inbox ----
export async function loadInbox() {
  const r = await rpc('inbox_list');
  if (!r?.ok) throw new Error(r?.error || 'inbox_load_failed');
  state.dmInbox = r.conversations || [];
  return state.dmInbox;
}

// ---- conversation lifecycle ----
export async function openOrCreateConversation(otherUserId) {
  const r = await rpc('conversation_get_or_create', { v_other_id: otherUserId });
  if (!r?.ok) throw new Error(r?.error || 'conv_failed');
  return r.conversation_id;
}

// ---- messages ----
export async function loadDmMessages(convId, beforeTs = null, limit = 50) {
  const r = await rpc('dm_list', {
    v_conv_id: convId,
    v_before_ts: beforeTs,
    v_limit: limit
  });
  if (!r?.ok) throw new Error(r?.error || 'list_failed');
  return r.messages || [];
}

export async function sendDmMessage(convId, content, clientMsgId, replyTo = null) {
  const r = await rpc('dm_send', {
    v_conv_id: convId,
    v_content: content,
    v_reply_to: replyTo,
    v_client_msg_id: clientMsgId
  });
  if (!r?.ok) throw new Error(r?.error || 'send_failed');
  return r; // { ok, message_id, dedup? }
}

export async function editDmMessage(msgId, newContent) {
  const r = await rpc('dm_edit', { v_msg_id: msgId, v_new_content: newContent });
  if (!r?.ok) throw new Error(r?.error || 'edit_failed');
  return r;
}

export async function deleteDmMessage(msgId) {
  const r = await rpc('dm_delete_own', { v_msg_id: msgId });
  if (!r?.ok) throw new Error(r?.error || 'delete_failed');
  return r;
}

export async function markDmRead(convId, throughMsgId = null) {
  const r = await rpc('dm_mark_read', {
    v_conv_id: convId,
    v_through_msg_id: throughMsgId
  });
  return r;
}

// ---- reactions ----
export async function toggleDmReaction(msgId, emoji) {
  const r = await rpc('dm_reaction_toggle', { v_msg_id: msgId, v_emoji: emoji });
  if (!r?.ok) throw new Error(r?.error || 'reaction_failed');
  return r;
}

export async function fetchDmReactions(msgIds) {
  if (!msgIds?.length) return [];
  const r = await rpc('dm_reactions_for', { v_msg_ids: msgIds });
  if (!r?.ok) throw new Error(r?.error || 'reactions_failed');
  return r.reactions || [];
}

// ---- pins ----
export async function pinDmMessage(msgId) {
  return rpc('dm_pin', { v_msg_id: msgId });
}
export async function unpinDmMessage(msgId) {
  return rpc('dm_unpin', { v_msg_id: msgId });
}
export async function listDmPins(convId) {
  const r = await rpc('pins_list_dm', { v_conv_id: convId });
  if (!r?.ok) throw new Error(r?.error || 'pins_failed');
  return r.pins || [];
}

// ---- bookmarks (private) ----
export async function addBookmark(msgId) {
  return rpc('bookmark_add', { v_msg_id: msgId });
}
export async function removeBookmark(msgId) {
  return rpc('bookmark_remove', { v_msg_id: msgId });
}
export async function listBookmarks() {
  const r = await rpc('bookmarks_list');
  if (!r?.ok) throw new Error(r?.error || 'bookmarks_failed');
  return r.bookmarks || [];
}

// ---- drafts ----
export async function getDraft(convId) {
  const r = await rpc('draft_get', { v_conv_id: convId });
  return r?.draft || '';
}
export async function setDraft(convId, draft) {
  return rpc('draft_set', { v_conv_id: convId, v_draft: draft });
}

// ---- search ----
export async function searchDm(query) {
  if (!query || query.length < 2) return [];
  const r = await rpc('dm_search', { v_query: query });
  if (!r?.ok) throw new Error(r?.error || 'search_failed');
  return r.results || [];
}

// ---- conversation-level flags ----
export async function setConvFlag(convId, flag, value) {
  return rpc('conversation_set_flag', {
    v_conv_id: convId,
    v_flag: flag,
    v_value: value
  });
}

// ---- friends ----
export async function listFriends() {
  const r = await rpc('friends_list');
  if (!r?.ok) throw new Error(r?.error || 'friends_failed');
  return r.friends || [];
}
export async function sendFriendRequest(usernameOrId) {
  return rpc('friend_request', { target_username: usernameOrId });
}
export async function respondFriendRequest(friendshipId, accept) {
  return rpc('friend_respond', { friendship_id: friendshipId, accept });
}
export async function removeFriend(otherId) {
  return rpc('friend_remove', { other_id: otherId });
}
export async function blockUser(otherId) {
  return rpc('friend_block', { other_id: otherId });
}
export async function unblockUser(otherId) {
  return rpc('friend_unblock', { other_id: otherId });
}
export async function listBlocks() {
  const r = await rpc('blocks_list');
  if (!r?.ok) throw new Error(r?.error || 'blocks_failed');
  return r.blocks || [];
}
export async function searchUsers(query) {
  if (!query || query.length < 2) return [];
  const r = await rpc('user_search', { q: query });
  if (!r?.ok) throw new Error(r?.error || 'search_failed');
  return r.users || [];
}
export async function userPublic(targetId) {
  const r = await rpc('user_public', { target_id: targetId });
  if (!r?.ok) throw new Error(r?.error || 'not_found');
  return r;
}