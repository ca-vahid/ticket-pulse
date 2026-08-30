/**
 * FreshService conversation → `ticket_thread_entries.external_entry_id`
 * namespace (Mega 08-30 Phase DR1).
 *
 * One conversation, ONE stamp. Before this helper three call sites minted
 * two different ids for the same FS conversation — the live write in
 * ticketService (`fs-conv-<id>`), the reconcile import in mirrorService
 * (`fs-conv-<id>`) and the FS conversation sync in the transformer
 * (`fs-conversation:<id>`) — so `@@unique([ticketId, externalEntryId])`
 * never merged them and every TP-sent reply on an FS-born ticket grew a
 * "Ticket Pulse" twin ~hours later (QA 08-28 #1, 62 pairs on prod).
 *
 * Canonical form is the transformer's `fs-conversation:<id>` (the majority
 * of rows). `parseFsConversationId` still understands the legacy `fs-conv-`
 * prefix so the 135 pre-existing rows keep resolving (note edits, reconcile
 * "already imported" checks) until the DR6 prod repair re-stamps them.
 */

export const FS_CONVERSATION_PREFIX = 'fs-conversation:';
export const LEGACY_FS_CONV_PREFIX = 'fs-conv-';

// Longest prefix first: `fs-conversation:` must win over any shorter
// candidate, and `fs-conversation-fallback:` (transformer rows without an
// FS id) matches NEITHER — its 8th char is 'e', not '-'.
const PARSE_PREFIXES = [FS_CONVERSATION_PREFIX, LEGACY_FS_CONV_PREFIX]
  .sort((a, b) => b.length - a.length);

/**
 * Canonical external id for an FS conversation.
 * @param {number|string|bigint} conversationId
 * @returns {string} `fs-conversation:<id>`
 */
export function fsConversationEntryId(conversationId) {
  const id = String(conversationId ?? '').trim();
  if (!id) throw new TypeError('fsConversationEntryId: conversation id is required');
  return `${FS_CONVERSATION_PREFIX}${id}`;
}

/**
 * Legacy stamp for the same conversation — ONLY for "does an old row already
 * exist" lookups; never mint new rows with it.
 * @param {number|string|bigint} conversationId
 * @returns {string} `fs-conv-<id>`
 */
export function legacyFsConversationEntryId(conversationId) {
  const id = String(conversationId ?? '').trim();
  if (!id) throw new TypeError('legacyFsConversationEntryId: conversation id is required');
  return `${LEGACY_FS_CONV_PREFIX}${id}`;
}

/**
 * Both stamps a conversation may carry in the table (canonical first).
 * @param {number|string|bigint} conversationId
 * @returns {string[]}
 */
export function fsConversationEntryIdCandidates(conversationId) {
  return [fsConversationEntryId(conversationId), legacyFsConversationEntryId(conversationId)];
}

/**
 * Extract the FS conversation id from an external entry id, accepting the
 * canonical `fs-conversation:<id>` AND the legacy `fs-conv-<id>`.
 * @param {string|null|undefined} externalEntryId
 * @returns {string|null} the conversation id (as a string) or null when the
 *   value is not an FS conversation stamp
 */
export function parseFsConversationId(externalEntryId) {
  const ext = typeof externalEntryId === 'string' ? externalEntryId : '';
  for (const prefix of PARSE_PREFIXES) {
    if (ext.startsWith(prefix)) {
      const id = ext.slice(prefix.length).trim();
      return id || null;
    }
  }
  return null;
}

/** True when the external id is an FS conversation stamp of either form. */
export function isFsConversationEntryId(externalEntryId) {
  return parseFsConversationId(externalEntryId) !== null;
}

export default {
  FS_CONVERSATION_PREFIX,
  LEGACY_FS_CONV_PREFIX,
  fsConversationEntryId,
  legacyFsConversationEntryId,
  fsConversationEntryIdCandidates,
  parseFsConversationId,
  isFsConversationEntryId,
};
