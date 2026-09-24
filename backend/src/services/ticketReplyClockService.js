/**
 * Reply clocks (QA 09-18 #5): when did the requester last write, when did an
 * agent last reply publicly — per ticket, from the conversation itself.
 *
 * Nothing on `tickets` records this (no lastRequesterReplyAt / lastAgentReplyAt
 * column), so both are derived from ticket_thread_entries the way the queue's
 * "Awaiting reply" card already does: public entries with a body, newest
 * first; `incoming = true` or author_type 'requester' = the requester wrote,
 * otherwise an agent did. One indexed query per call, never one per ticket.
 *
 * Used by
 *   - the `ticket.requester_silent_for` time trigger (candidates whose latest
 *     public message is an agent's, older than N hours), and
 *   - the workflow condition fields ticket.lastRequesterReplyMinutes /
 *     ticket.lastAgentReplyMinutes (evaluated on demand).
 */
import { Prisma } from '@prisma/client';
import prisma from './prisma.js';
import logger from '../utils/logger.js';

const PUBLIC_MESSAGE_SQL = Prisma.sql`
  (te.is_private = false OR te.is_private IS NULL)
  AND (te.body_text IS NOT NULL OR te.content IS NOT NULL)
  AND (te.event_type IS NULL OR te.event_type <> 'original_email')
  AND (te.author_type IS NULL OR te.author_type <> 'system')
  AND te.source <> 'freshservice_activity'`;

const isRequesterEntry = (row) => row.incoming === true || row.author_type === 'requester';

/**
 * Latest public message per ticket, split by who wrote it.
 * @returns Map<ticketId, { lastRequesterReplyAt: Date|null, lastAgentReplyAt: Date|null, lastAgentEntryId: number|null, latestIsAgent: boolean|null }>
 */
export async function replyClocksFor(ticketIds) {
  const ids = [...new Set((Array.isArray(ticketIds) ? ticketIds : []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  const out = new Map();
  if (ids.length === 0) return out;
  try {
    const rows = await prisma.$queryRaw`
      SELECT te.ticket_id, te.id, te.incoming, te.author_type, te.occurred_at
      FROM ticket_thread_entries te
      WHERE te.ticket_id IN (${Prisma.join(ids)})
        AND ${PUBLIC_MESSAGE_SQL}
      ORDER BY te.ticket_id, te.occurred_at DESC, te.id DESC`;
    for (const row of rows) {
      const ticketId = Number(row.ticket_id);
      let clock = out.get(ticketId);
      if (!clock) {
        clock = { lastRequesterReplyAt: null, lastAgentReplyAt: null, lastAgentEntryId: null, latestIsAgent: null };
        out.set(ticketId, clock);
      }
      const requester = isRequesterEntry(row);
      if (clock.latestIsAgent === null) clock.latestIsAgent = !requester;
      if (requester) {
        if (!clock.lastRequesterReplyAt) clock.lastRequesterReplyAt = new Date(row.occurred_at);
      } else if (!clock.lastAgentReplyAt) {
        clock.lastAgentReplyAt = new Date(row.occurred_at);
        clock.lastAgentEntryId = Number(row.id);
      }
      // Both clocks known → nothing more to learn about this ticket.
    }
  } catch (err) {
    logger.warn(`replyClocksFor failed (non-fatal): ${err.message}`);
  }
  return out;
}

/** Minutes since a date, or null. */
export function minutesSince(date, now = Date.now()) {
  if (!date) return null;
  const t = new Date(date).getTime();
  return Number.isNaN(t) ? null : Math.round((now - t) / 60000);
}

/** The two condition fields for one ticket (null = never happened). */
export async function replyClockMinutes(ticketId, now = Date.now()) {
  const clocks = await replyClocksFor([ticketId]);
  const clock = clocks.get(Number(ticketId)) || null;
  return {
    lastRequesterReplyMinutes: minutesSince(clock?.lastRequesterReplyAt, now),
    lastAgentReplyMinutes: minutesSince(clock?.lastAgentReplyAt, now),
  };
}

/**
 * Tickets whose LATEST public message is an agent's, older than `cutoff`,
 * in one of `statuses`, in one workspace. The requester has been silent for
 * at least (now - cutoff). Ordered oldest-silence first, capped.
 */
export async function requesterSilentCandidates(workspaceId, { statuses, cutoff, limit = 200 } = {}) {
  const names = (Array.isArray(statuses) ? statuses : []).map((s) => String(s)).filter(Boolean);
  if (!names.length || !(cutoff instanceof Date)) return [];
  try {
    const rows = await prisma.$queryRaw`
      SELECT ticket_id, entry_id, occurred_at
      FROM (
        SELECT DISTINCT ON (te.ticket_id) te.ticket_id, te.id AS entry_id, te.incoming, te.author_type, te.occurred_at
        FROM ticket_thread_entries te
        JOIN tickets t ON t.id = te.ticket_id
        WHERE t.workspace_id = ${Number(workspaceId)}
          AND t.status IN (${Prisma.join(names)})
          -- Parked tickets wait on purpose: never "silent requester" material.
          AND t.parked_until IS NULL
          AND t.is_noise = false
          AND ${PUBLIC_MESSAGE_SQL}
        ORDER BY te.ticket_id, te.occurred_at DESC, te.id DESC
      ) latest
      WHERE NOT (latest.incoming = true OR latest.author_type = 'requester')
        AND latest.occurred_at <= ${cutoff}
      ORDER BY latest.occurred_at ASC
      LIMIT ${Math.max(1, Math.min(1000, Number(limit) || 200))}`;
    return rows.map((r) => ({ ticketId: Number(r.ticket_id), lastAgentEntryId: Number(r.entry_id), lastAgentReplyAt: new Date(r.occurred_at) }));
  } catch (err) {
    logger.warn(`requesterSilentCandidates failed (non-fatal): ${err.message}`);
    return [];
  }
}

export default { replyClocksFor, replyClockMinutes, requesterSilentCandidates, minutesSince };
