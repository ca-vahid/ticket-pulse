import prisma from './prisma.js';
import logger from '../utils/logger.js';

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
        await graphMailClient.sendMailAsMailbox(connection.address, { to: recipients, subject, html });
        return { sent: true, via: 'msgraph' };
      }
    }
    const { default: sendgrid } = await import('./sendgridNotificationService.js');
    await sendgrid.sendEmail({ to: recipients, subject, html });
    return { sent: true, via: 'sendgrid' };
  } catch (err) {
    logger.warn(`Transactional ${label} send failed (non-fatal): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export default { sendTransactionalEmail };
