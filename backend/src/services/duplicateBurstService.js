// Duplicate-burst guard: when the same requester files near-identical tickets
// minutes apart (seen 2026-07-13: the FreshService MS Teams app created 12
// copies of one request in 84s), later copies are auto-linked as duplicates of
// the first and their AI runs are skipped — one visible request, one triage,
// instead of a storm. Detection is deliberately conservative: exact
// normalized-subject match, same requester, small time window.
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const DUPLICATE_BURST_WINDOW_MINUTES = 15;
const MIN_SUBJECT_LENGTH = 6; // don't collapse generic subjects ("help", "hi")

/** Lowercase, strip punctuation, collapse whitespace — burst copies often
 *  differ only in retyped punctuation/casing. */
export function normalizeSubject(subject) {
  return String(subject || '')
    .toLowerCase()
    .replace(/^\s*(re|fw|fwd)\s*:\s*/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

class DuplicateBurstService {
  /**
   * Is this ticket a burst-duplicate of an earlier one? Returns the ORIGINAL
   * (earliest matching ticket in the window) or null. Never matches when the
   * requester is unknown or the subject is too generic.
   */
  async detectBurstDuplicate(ticketId, workspaceId) {
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId },
      select: { id: true, requesterId: true, subject: true, createdAt: true },
    });
    if (!ticket?.requesterId || !ticket.createdAt) return null;

    const needle = normalizeSubject(ticket.subject);
    if (needle.length < MIN_SUBJECT_LENGTH) return null;

    const windowStart = new Date(ticket.createdAt.getTime() - DUPLICATE_BURST_WINDOW_MINUTES * 60 * 1000);
    const candidates = await prisma.ticket.findMany({
      where: {
        workspaceId,
        requesterId: ticket.requesterId,
        id: { not: ticket.id },
        createdAt: { gte: windowStart, lte: ticket.createdAt },
        status: { notIn: ['Deleted', 'Spam'] },
        isNoise: false,
      },
      select: { id: true, subject: true, createdAt: true, freshserviceTicketId: true, nativeNumber: true, origin: true },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });

    for (const candidate of candidates) {
      // Only earlier tickets count as the original (createdAt tie → lower id).
      const earlier = candidate.createdAt < ticket.createdAt
        || (candidate.createdAt.getTime() === ticket.createdAt.getTime() && candidate.id < ticket.id);
      if (earlier && normalizeSubject(candidate.subject) === needle) return candidate;
    }
    return null;
  }

  /**
   * Record the dismissal: duplicate_of link (+ TP-born copies get resolved by
   * markDuplicate; FS-born copies keep their FS status — agents may prefer to
   * merge in FS) and a completed pipeline run with decision
   * 'duplicate_dismissed' so the review queue shows what happened. The
   * original ticket's own run is untouched.
   */
  async dismissAsDuplicate(ticketId, workspaceId, original, triggerSource) {
    const { default: ticketLinkService } = await import('./ticketLinkService.js');
    const { ticketDisplayRef } = await import('../utils/ticketOrigin.js');
    const ref = ticketDisplayRef(original);

    try {
      await ticketLinkService.markDuplicate(ticketId, workspaceId, original.id, {
        name: 'Ticket Pulse duplicate guard',
        email: null,
      });
    } catch (err) {
      // Link may already exist (re-triggered run on a known duplicate) — the
      // dismissal run below is still worth recording.
      logger.info('Duplicate guard: link not created', { ticketId, error: err.message });
    }

    const now = new Date();
    const run = await prisma.assignmentPipelineRun.create({
      data: {
        ticketId,
        workspaceId,
        status: 'completed',
        triggerSource,
        llmModel: 'duplicate-guard',
        totalDurationMs: 0,
        totalTokensUsed: 0,
        decision: 'duplicate_dismissed',
        decidedAt: now,
        recommendation: {
          recommendations: [],
          overallReasoning: `Duplicate burst detected: same requester and subject as ${ref}, created within ${DUPLICATE_BURST_WINDOW_MINUTES} minutes. The AI run was skipped and this ticket was linked as a duplicate — triage continues on ${ref}.`,
          duplicateOfTicketId: original.id,
          duplicateOfRef: ref,
          source: 'duplicate_guard',
        },
        errorMessage: `Auto-dismissed as duplicate of ${ref}`,
      },
      select: { id: true },
    });

    logger.info('Duplicate guard dismissed burst copy', {
      workspaceId, ticketId, originalTicketId: original.id, runId: run.id, triggerSource,
    });
    return run;
  }
}

export default new DuplicateBurstService();
