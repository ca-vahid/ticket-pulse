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

/** Body length below which there is nothing to compare (a bare "see attached"). */
const MIN_BODY_LENGTH = 40;

/**
 * Same normalization as the subject, applied to the body. Used to tell a real
 * burst (identical copies of one request) from recurring machine mail that
 * merely shares a template subject.
 */
export function normalizeBody(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/<[^>]+>/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Do these two tickets say the same thing? (QA 09-09 #1.)
 *
 * The guard used to match on subject alone, which is true of a burst but also
 * true of every invoice a vendor ever sends: "New Invoice from Instacart
 * Business" is a template, and the invoice number lives in the body. Seventeen
 * genuinely different Instacart invoices were dismissed as duplicates of each
 * other in 30 days on that basis.
 *
 * When BOTH tickets carry a substantial body, the bodies must agree too.
 * When either body is missing or too short to mean anything, we fall back to
 * subject-only — that is the original Teams-app storm, whose 12 copies were
 * identical in every field.
 */
export function bodiesAgree(a, b) {
  const left = normalizeBody(a);
  const right = normalizeBody(b);
  if (left.length < MIN_BODY_LENGTH || right.length < MIN_BODY_LENGTH) return true;
  return left === right;
}

/**
 * Attachment fingerprint: the sorted (name, size) multiset.
 *
 * Size is load-bearing, not decoration. Kirsten's #241127/#241128 are two
 * different Tytan invoices whose bodies are literally "<br>" and whose
 * attachments are BOTH called SalesInvoice.Report.pdf — the vendor's exporter
 * names every file the same. They differ only at 204,780 vs 201,147 bytes.
 * Comparing names alone would still have collapsed them.
 */
export function attachmentFingerprint(attachments = []) {
  return (Array.isArray(attachments) ? attachments : [])
    .map((a) => `${String(a?.fileName || '').trim().toLowerCase()}:${Number(a?.sizeBytes) || 0}`)
    .sort()
    .join('|');
}

/**
 * Full content comparison for two same-subject tickets. Bodies decide when
 * there is enough body to decide; otherwise the attachments do; and when
 * neither carries any signal we fall back to subject-only, which is the
 * original burst case.
 */
export function contentAgrees(a, b) {
  if (!bodiesAgree(a?.body, b?.body)) return false;

  const leftBody = normalizeBody(a?.body);
  const rightBody = normalizeBody(b?.body);
  const bodiesWereDecisive = leftBody.length >= MIN_BODY_LENGTH && rightBody.length >= MIN_BODY_LENGTH;
  if (bodiesWereDecisive) return true;

  // Bodies said nothing — let the documents speak (the AP pattern: an empty
  // mail whose entire content is the invoice PDF).
  const leftFiles = attachmentFingerprint(a?.attachments);
  const rightFiles = attachmentFingerprint(b?.attachments);
  if (!leftFiles || !rightFiles) return true;
  return leftFiles === rightFiles;
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
      select: {
        id: true, requesterId: true, subject: true, createdAt: true,
        descriptionText: true, description: true,
        attachments: { select: { fileName: true, sizeBytes: true } },
      },
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
      select: {
        id: true, subject: true, createdAt: true, freshserviceTicketId: true,
        nativeNumber: true, origin: true, descriptionText: true, description: true,
        attachments: { select: { fileName: true, sizeBytes: true } },
      },
      orderBy: { createdAt: 'asc' },
      take: 25,
    });
    const needleContent = {
      body: ticket.descriptionText || ticket.description,
      attachments: ticket.attachments,
    };

    for (const candidate of candidates) {
      // Only earlier tickets count as the original (createdAt tie → lower id).
      const earlier = candidate.createdAt < ticket.createdAt
        || (candidate.createdAt.getTime() === ticket.createdAt.getTime() && candidate.id < ticket.id);
      if (!earlier || normalizeSubject(candidate.subject) !== needle) continue;
      const candidateContent = {
        body: candidate.descriptionText || candidate.description,
        attachments: candidate.attachments,
      };
      if (!contentAgrees(needleContent, candidateContent)) {
        logger.info('Duplicate guard: same subject but different content — not a burst', {
          ticketId, workspaceId, candidateId: candidate.id,
        });
        continue;
      }
      return candidate;
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
