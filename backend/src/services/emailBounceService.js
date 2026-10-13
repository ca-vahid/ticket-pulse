/**
 * Bounce reporting for mail sent through SendGrid (IT intake plan, 12 Oct 2026).
 *
 * SendGrid answers "accepted" at send time and that was stored as "sent"; a bounce or a block
 * that happened afterwards was invisible. SendGrid's Event Webhook posts those outcomes to
 * POST /api/sendgrid-events. An event is matched to the delivery it belongs to by SendGrid's
 * message id (the part of `sg_message_id` before the first dot is the `x-message-id` we stored
 * as providerMessageId). The delivery is marked, and the ticket gets one internal note so the
 * agent who replied can see their mail did not arrive.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';

export const BOUNCE_TOKEN_KEY = 'sendgrid_event_webhook_token';
// What counts as "it did not arrive". 'deferred' is SendGrid still trying; 'delivered'/'open' are fine.
const FAILED_EVENTS = new Set(['bounce', 'dropped', 'blocked', 'spamreport']);
const WORDS = { bounce: 'bounced', dropped: 'was dropped by the mail service', blocked: 'was blocked by the receiving server', spamreport: 'was reported as spam by the recipient' };

const esc = (v) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function sendgridMessageId(event) {
  return String(event?.sg_message_id || event?.['smtp-id'] || '').split('.')[0].replace(/^<|>$/g, '').trim() || null;
}

class EmailBounceService {
  async verifyToken(token) {
    const expected = String(await settingsRepository.get(BOUNCE_TOKEN_KEY).catch(() => '') || '').trim();
    return Boolean(expected) && typeof token === 'string' && token.length === expected.length && token === expected;
  }

  /** @returns {{ seen: number, failed: number, matched: number, noted: number }} Never throws. */
  async handleEvents(events) {
    const out = { seen: 0, failed: 0, matched: 0, noted: 0 };
    for (const event of Array.isArray(events) ? events.slice(0, 500) : []) {
      out.seen += 1;
      const kind = String(event?.event || '').toLowerCase();
      // SendGrid reports a block as event "bounce" with type "blocked".
      const outcome = kind === 'bounce' && String(event?.type || '').toLowerCase() === 'blocked' ? 'blocked' : kind;
      if (!FAILED_EVENTS.has(outcome)) continue;
      out.failed += 1;
      try {
        const id = sendgridMessageId(event);
        if (!id) continue;
        const delivery = await prisma.notificationDelivery.findFirst({
          where: { providerMessageId: id },
          select: { id: true, ticketId: true, workspaceId: true, status: true, recipient: true, notificationType: true },
          orderBy: { id: 'desc' },
        });
        if (!delivery) continue;
        out.matched += 1;
        if (delivery.status === 'bounced') continue; // one note per delivery, however many events arrive
        const address = String(event.email || delivery.recipient || 'the recipient');
        const reason = String(event.reason || event.response || event.status || '').replace(/\s+/g, ' ').trim().slice(0, 300);
        await prisma.notificationDelivery.update({
          where: { id: delivery.id },
          data: { status: 'bounced', error: `${outcome}: ${reason || 'no reason given'}`.slice(0, 1000) },
        });
        if (delivery.ticketId) {
          const { default: ticketService } = await import('./ticketService.js');
          const what = delivery.notificationType === 'native_reply_to_requester' ? 'The reply' : 'An e-mail from this ticket';
          await ticketService.addPrivateNote(delivery.ticketId, delivery.workspaceId, {
            bodyHtml: `<p><strong>${what} to ${esc(address)} ${WORDS[outcome]}.</strong> It did not arrive.${reason ? ` The mail service said: ${esc(reason)}` : ''}</p>`
              + '<p>Check the address, or reach the person another way.</p>',
          }, { email: 'mailbox@ticketpulse.internal', name: 'Ticket Pulse Mail', role: 'system', technicianId: null }, [], { systemNote: true });
          out.noted += 1;
        }
        logger.warn(`E-mail not delivered (${outcome}) to ${address} for ticket ${delivery.ticketId || 'n/a'}: ${reason || 'no reason given'}`);
      } catch (err) {
        logger.warn(`Bounce event not recorded (non-fatal): ${err.message}`);
      }
    }
    return out;
  }
}

export default new EmailBounceService();
