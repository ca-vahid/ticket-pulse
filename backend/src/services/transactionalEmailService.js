import prisma from './prisma.js';
import logger from '../utils/logger.js';
import emailHealthService from './emailHealthService.js';

/**
 * Shared one-off ("transactional") email transport. Prefers sending as a
 * workspace's connected mailbox via Microsoft Graph (so it comes from a real
 * person/shared mailbox), and falls back to SendGrid as ticketpulse@. This is
 * the exact path approval emails proved out; tasks and future notifications
 * reuse it instead of duplicating the graph→sendgrid fallback.
 *
 * @returns {{ sent: boolean, via?: string, reason?: string, error?: string }}
 */
export async function sendTransactionalEmail({ workspaceId, to, subject, html, label = 'email' }) {
  const recipients = Array.isArray(to) ? to.filter(Boolean) : [to].filter(Boolean);
  if (recipients.length === 0) return { sent: false, reason: 'no_recipient' };
  try {
    const connection = await prisma.mailboxConnection.findFirst({
      where: { workspaceId, isEnabled: true, mode: { in: ['send', 'both'] } },
      orderBy: { id: 'asc' },
    });
    if (connection) {
      const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
      if (graphMailClient.isConfigured()) {
        // Graph bypasses sendgridNotificationService, so record its health here.
        const startedAt = Date.now();
        try {
          await graphMailClient.sendMailAsMailbox(connection.address, { to: recipients, subject, html });
          await emailHealthService.recordSuccess({
            workspaceId, channel: 'email', context: label, provider: 'msgraph',
            durationMs: Date.now() - startedAt, recipients,
          });
          return { sent: true, via: 'msgraph' };
        } catch (graphErr) {
          await emailHealthService.recordFailure({
            workspaceId, channel: 'email', context: label, provider: 'msgraph',
            error: graphErr, durationMs: Date.now() - startedAt, recipients,
          });
          throw graphErr;
        }
      }
    }
    // sendgridNotificationService.sendEmail records its own health event.
    const { default: sendgrid } = await import('./sendgridNotificationService.js');
    await sendgrid.sendEmail({ to: recipients, subject, html, context: label, workspaceId });
    return { sent: true, via: 'sendgrid' };
  } catch (err) {
    logger.warn(`Transactional ${label} send failed (non-fatal): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export default { sendTransactionalEmail };
