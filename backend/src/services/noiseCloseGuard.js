/**
 * Noise-close guard (27 Sep 2026, Vahid's review of the AI auto-closes).
 *
 * The AI's "this is noise" verdict may close a ticket only when nothing about
 * the ticket says a person is waiting on it. The rule path has had this guard
 * since v3.8.32 (noiseRuleService.canAutoClose); the AI path never did, and
 * it closed real requests from people — licence asks, BST outages, a
 * forwarded vendor mail. The verdict still stands as a label; the run is
 * held for a person instead of closing the ticket.
 *
 * Checked in this order, first hit wins:
 *   assigned          an agent already owns the ticket
 *   marked_not_noise  a person already said it is not noise (Reopen & route,
 *                     or the noise toggle on the ticket)
 *   hr_notice         an HR notice (On Leave, Departure, Transfer, New Hire)
 *                     — these are parked until their date, never closed
 *   forwarded_by_person  the subject carries a person's FW:/RE: prefix
 *   person_requester  the requester is one of our people (internal domain,
 *                     where configured) with a real ticket in the past year
 *
 * A machine address (noreply@, alerts@, monitoring@ …) skips the person
 * checks. Fails SAFE: a lookup error holds the ticket.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import * as noiseRules from './noiseRuleService.js';

export const NOISE_CLOSE_HOLD_REASONS = Object.freeze({
  ASSIGNED: 'assigned',
  MARKED_NOT_NOISE: 'marked_not_noise',
  HR_NOTICE: 'hr_notice',
  FORWARDED: 'forwarded_by_person',
  PERSON: 'person_requester',
  LOOKUP_FAILED: 'lookup_failed',
});

const HR_NOTICE_SUBJECT = /^\s*(transfer notification|new hire|nh )|departure notification|on leave notification/i;

/** Same subjects the HR auto-park sweep looks for (ticketParkService HR_SUBJECT_FILTERS). */
export function isHrNoticeSubject(subject) {
  return HR_NOTICE_SUBJECT.test(String(subject || ''));
}

export function emailDomainIsInternal(email, internalDomains) {
  const domain = String(email || '').trim().toLowerCase().split('@')[1] || '';
  if (!domain || !Array.isArray(internalDomains) || internalDomains.length === 0) return false;
  return internalDomains.some((d) => {
    const dd = String(d || '').trim().toLowerCase();
    return dd && (domain === dd || domain.endsWith(`.${dd}`));
  });
}

export function holdMessage(reason, detail = {}) {
  switch (reason) {
  case NOISE_CLOSE_HOLD_REASONS.ASSIGNED:
    return 'The AI marked this as noise, but an agent already owns the ticket - it was not closed.';
  case NOISE_CLOSE_HOLD_REASONS.MARKED_NOT_NOISE:
    return 'The AI marked this as noise, but a person already said it is not - it was not closed.';
  case NOISE_CLOSE_HOLD_REASONS.HR_NOTICE:
    return detail.parkedUntil
      ? `HR notice - parked until ${detail.parkedUntil} instead of closed.`
      : 'HR notice - held for a person instead of closed (no clear date to park it until).';
  case NOISE_CLOSE_HOLD_REASONS.FORWARDED:
    return 'The AI marked this as noise, but a person forwarded or replied to it - held for a person instead of closed.';
  case NOISE_CLOSE_HOLD_REASONS.PERSON:
    return 'The AI marked this as noise, but it came from one of our people - held for a person instead of closed.';
  default:
    return 'The AI marked this as noise, but the close check could not complete - held for a person instead of closed.';
  }
}

/**
 * @returns {Promise<{hold: boolean, reason: string|null, message: string|null, hrNotice?: boolean}>}
 */
export async function evaluateNoiseCloseGuard({ ticketId, workspaceId }) {
  try {
    const ticket = await prisma.ticket.findUnique({
      where: { id: Number(ticketId) },
      select: {
        id: true,
        subject: true,
        assignedTechId: true,
        requesterId: true,
        requester: { select: { email: true } },
      },
    });
    if (!ticket) return { hold: false, reason: null, message: null };

    const hold = (reason, extra = {}) => ({ hold: true, reason, message: holdMessage(reason), ...extra });

    if (ticket.assignedTechId) return hold(NOISE_CLOSE_HOLD_REASONS.ASSIGNED);
    const clearedByPerson = await prisma.ticketActivity.findFirst({
      where: { ticketId: ticket.id, activityType: 'noise_cleared' },
      select: { id: true },
    });
    if (clearedByPerson) return hold(NOISE_CLOSE_HOLD_REASONS.MARKED_NOT_NOISE);
    if (isHrNoticeSubject(ticket.subject)) return hold(NOISE_CLOSE_HOLD_REASONS.HR_NOTICE, { hrNotice: true });

    const requesterEmail = ticket.requester?.email || null;
    const sender = noiseRules.classifySender({ subject: ticket.subject, requesterEmail });
    if (sender.humanPrefix) return hold(NOISE_CLOSE_HOLD_REASONS.FORWARDED);
    if (sender.machineAddress) return { hold: false, reason: null, message: null };

    // Only our own people count by history. An outside sender with a past
    // real ticket is usually a vendor whose support case once came in; their
    // marketing mail is still noise (Veeam, 1Password: 30-day replay, 27 Sep).
    // Where no internal domains are configured, history alone decides.
    const workspace = await prisma.workspace.findUnique({
      where: { id: Number(workspaceId) },
      select: { internalDomains: true },
    });
    const internalDomains = workspace?.internalDomains || [];
    if (internalDomains.length > 0 && !emailDomainIsInternal(requesterEmail, internalDomains)) {
      return { hold: false, reason: null, message: null };
    }

    if (ticket.requesterId) {
      const realTicket = await prisma.ticket.findFirst({
        where: {
          requesterId: ticket.requesterId,
          id: { not: ticket.id },
          isNoise: false,
          createdAt: { gte: new Date(Date.now() - 365 * 86400e3) },
        },
        select: { id: true },
      });
      if (realTicket) return hold(NOISE_CLOSE_HOLD_REASONS.PERSON);
    }
    return { hold: false, reason: null, message: null };
  } catch (error) {
    logger.warn('Noise-close guard lookup failed - holding the ticket for a person', {
      ticketId, workspaceId, error: error.message,
    });
    return { hold: true, reason: NOISE_CLOSE_HOLD_REASONS.LOOKUP_FAILED, message: holdMessage(NOISE_CLOSE_HOLD_REASONS.LOOKUP_FAILED) };
  }
}

/** HR notice held by the guard: park it until its date now, rather than waiting for the sweep. */
export async function parkHeldHrNotice({ ticketId, workspaceId }) {
  try {
    const { default: ticketParkService } = await import('./ticketParkService.js');
    if (!(await ticketParkService.hrAutoParkEnabled(workspaceId))) return null;
    const suggestion = await ticketParkService.hrSuggestion(ticketId, workspaceId);
    if (!suggestion?.usable) return null;
    await ticketParkService.park(
      ticketId,
      workspaceId,
      { kind: 'until_date', until: suggestion.until, reason: suggestion.reason },
      { name: 'Ticket Pulse (HR notice)', role: 'automation' },
      { source: 'suggested_hr' },
    );
    return suggestion.wakeDate;
  } catch (error) {
    logger.warn('Noise-close guard: HR notice park failed (the park sweep will retry)', { ticketId, workspaceId, error: error.message });
    return null;
  }
}
