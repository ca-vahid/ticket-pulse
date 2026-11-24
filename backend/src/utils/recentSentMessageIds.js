/**
 * Message-IDs this process is about to send, or just sent (24 Nov 2026 mail-loop
 * guard). The transports remember an id BEFORE the send call, so intake can prove
 * a mail ours even when it comes back into another of our mailboxes before the
 * delivery row or thread entry that records its id is written. Ten minutes is far
 * longer than that gap; the database lookups cover everything older.
 * In memory, bounded; ids compare without their angle brackets, case-insensitively.
 */
export const RECENT_SENT_TTL_MS = 10 * 60 * 1000;
const MAX_IDS = 5000;
const sent = new Map(); // bare id -> remembered at (ms)

const bare = (id) => String(id || '').trim().replace(/^<|>$/g, '').toLowerCase();

function prune(now) {
  for (const [id, at] of sent) {
    if (now - at < RECENT_SENT_TTL_MS && sent.size <= MAX_IDS) break; // oldest first
    sent.delete(id);
  }
}

export function rememberSentMessageId(id, now = Date.now()) {
  const key = bare(id);
  if (!key) return;
  sent.delete(key); // re-insert at the end (newest)
  sent.set(key, now);
  prune(now);
}

export function wasRecentlySent(id, now = Date.now()) {
  const key = bare(id);
  if (!key) return false;
  const at = sent.get(key);
  if (at === undefined) return false;
  if (now - at >= RECENT_SENT_TTL_MS) {
    sent.delete(key);
    return false;
  }
  return true;
}

export function clearRecentSentMessageIds() {
  sent.clear();
}
