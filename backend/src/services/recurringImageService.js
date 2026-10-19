import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Signature logos (19 Oct 2026). Mail clients send the company logo in a
 * signature as an inline picture, so every e-mailed ticket carried a
 * "picture-1-…-image001.png" in its Attachments tab. In prod one 39,593-byte
 * PNG sat on 128 tickets under 114 names.
 *
 * We store no content hash, but an exact byte size of an image arriving by mail
 * on many different tickets is the same picture in practice. Those are marked
 * `recurring` so the app can leave them out of attachment counts and lists while
 * still showing them where the message body places them.
 */
export const RECURRING_MIN_TICKETS = 5;
const CACHE_MS = 10 * 60 * 1000;
const cache = new Map(); // workspaceId -> { at, keys:Set }

const keyOf = (contentType, sizeBytes) => `${String(contentType || '').toLowerCase()}|${Number(sizeBytes) || 0}`;
const isImageType = (contentType) => /^image\//i.test(String(contentType || ''));

/** Image (type, size) pairs that arrived by mail on at least RECURRING_MIN_TICKETS tickets. */
export async function recurringImageKeys(workspaceId, { now = Date.now() } = {}) {
  const ws = Number(workspaceId);
  if (!ws) return new Set();
  const hit = cache.get(ws);
  if (hit && now - hit.at < CACHE_MS) return hit.keys;
  let keys = new Set();
  try {
    const rows = await prisma.$queryRaw`
      SELECT lower(content_type) AS content_type, size_bytes
      FROM ticket_attachments
      WHERE workspace_id = ${ws}
        AND content_type ILIKE 'image/%'
        AND source <> 'upload'
      GROUP BY 1, 2
      HAVING count(DISTINCT ticket_id) >= ${RECURRING_MIN_TICKETS}`;
    keys = new Set((rows || []).map((r) => keyOf(r.content_type, r.size_bytes)));
  } catch (err) {
    logger.warn(`Recurring image lookup failed for workspace ${ws}: ${err.message}`);
    return hit?.keys || new Set();
  }
  cache.set(ws, { at: now, keys });
  return keys;
}

/** The rows with `recurring: true` on signature logos (pasted uploads never are). */
export async function markRecurring(workspaceId, rows = []) {
  if (!rows.length) return rows;
  const keys = await recurringImageKeys(workspaceId);
  if (!keys.size) return rows;
  return rows.map((a) => (a && a.source !== 'upload' && isImageType(a.contentType) && keys.has(keyOf(a.contentType, a.sizeBytes))
    ? { ...a, recurring: true }
    : a));
}

/** Test hook. */
export function resetRecurringImageCache() {
  cache.clear();
}

export default { recurringImageKeys, markRecurring, resetRecurringImageCache, RECURRING_MIN_TICKETS };
