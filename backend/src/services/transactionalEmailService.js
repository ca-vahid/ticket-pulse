import logger from '../utils/logger.js';
import emailHealthService from './emailHealthService.js';
import { resolveFromName } from './workspaceEmailIdentityService.js';
import { pickIngestMailbox, pickOutboundMailbox } from './mailboxPicker.js';
import { plusAddressReplyTo, storeEntryMessageId, threadingHeadersForTicket } from './emailThreadingService.js';

function normalizeList(value) {
  const list = Array.isArray(value) ? value : [value];
  const seen = new Set();
  const out = [];
  for (const raw of list) {
    const address = String(raw || '').trim();
    if (!address) continue;
    const key = address.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(address);
  }
  return out;
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

/** Graph sends HTML only — text-only callers (assignment pings) get a wrapper. */
function htmlFromText(text) {
  const body = String(text ?? '').trim();
  return body ? `<p>${escapeHtml(body).replace(/\r?\n/g, '<br/>')}</p>` : null;
}

/**
 * Shared one-off ("transactional") email transport. Prefers sending as the
 * workspace's connected mailbox via Microsoft Graph (so it comes from a real
 * person/shared mailbox and replies land back in the ticket), and falls back
 * to SendGrid as ticketpulse@ — also when the Graph send itself fails, so a
 * mailbox outage never swallows an acknowledgement. Approvals, tasks, watcher
 * notices and (Mega 08-31 Phase MB-1a) the workflow/lifecycle engine all ride
 * this instead of duplicating the graph→sendgrid fallback.
 *
 * `cc` (Phase MR6): optional carbon copies — deduped, and any address already
 * in `to` is dropped (SendGrid rejects an address present in both; Graph
 * would deliver twice). `bcc` gets the same guard against to+cc.
 *
 * Threading (Phase MB-1b/1c/1h) when `ticket` is given: In-Reply-To /
 * References from the ticket's stored Message-IDs on BOTH lanes; a
 * plus-address Reply-To (`mailbox+tp<n>@domain`, TP-born only) — from the
 * sending mailbox on Graph, from the workspace's INGEST mailbox (if any) on
 * the SendGrid fallback so the loop survives a Graph outage; on the SendGrid
 * lane our own Message-ID is minted. Whatever Message-ID the
 * mail went out with is stored on `threadEntryId` (when given) so ingest
 * rung 1 can match the reply.
 *
 * `deliverTransactionalEmail` THROWS on total failure (callers that manage
 * retry state, e.g. notificationDeliveryService, need the error class);
 * `sendTransactionalEmail` is the non-fatal wrapper everything else uses.
 *
 * @returns {{ via: 'msgraph'|'sendgrid', provider: string, providerMessageId: string|null,
 *            messageId: string|null, from: string|null, replyTo: string|null }}
 */
export async function deliverTransactionalEmail({
  workspaceId,
  to,
  cc = [],
  bcc = [],
  subject,
  html = null,
  text = null,
  label = 'email',
  fromName = null,
  from = null,
  attachments = [],
  customArgs = null,
  ticket = null,
  threadEntryId = null,
}) {
  const recipients = normalizeList(to);
  if (recipients.length === 0) {
    const err = new Error('Email recipient is required');
    err.retryable = false;
    err.reason = 'no_recipient';
    throw err;
  }
  const toKeys = new Set(recipients.map((a) => a.toLowerCase()));
  const ccRecipients = normalizeList(cc).filter((a) => !toKeys.has(a.toLowerCase()));
  const ccKeys = new Set(ccRecipients.map((a) => a.toLowerCase()));
  const bccRecipients = normalizeList(bcc).filter((a) => !toKeys.has(a.toLowerCase()) && !ccKeys.has(a.toLowerCase()));

  // Per-workspace From display name (Phase EB) — guaranteed on the SendGrid
  // fallback; best-effort on Graph (Exchange usually rewrites it to the
  // mailbox displayName). Sends without a workspaceId (sync-health and other
  // global notices) resolve to the global default. Callers that already
  // resolved a name (reply-as-agent) pass it through.
  const senderName = fromName || await resolveFromName(workspaceId ?? null);
  const threading = ticket?.id
    ? await threadingHeadersForTicket(ticket.id)
    : { inReplyTo: null, references: [] };
  const htmlBody = html || htmlFromText(text);
  const allRecipients = [...recipients, ...ccRecipients, ...bccRecipients];

  let graphError = null;
  const connection = await pickOutboundMailbox(workspaceId);
  if (connection) {
    const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
    if (graphMailClient.isConfigured()) {
      // Graph bypasses sendgridNotificationService, so record its health here.
      const startedAt = Date.now();
      const replyTo = ticket ? plusAddressReplyTo(connection.address, ticket) : null;
      try {
        const sent = await graphMailClient.sendMailAsMailbox(connection.address, {
          to: recipients,
          // Graph drafts carry no bcc field in our client; bcc folds into cc
          // rather than silently dropping a recipient.
          cc: [...ccRecipients, ...bccRecipients],
          subject,
          html: htmlBody,
          attachments,
          fromName: senderName,
          replyTo,
          inReplyTo: threading.inReplyTo,
          references: threading.references,
        });
        await emailHealthService.recordSuccess({
          workspaceId, channel: 'email', context: label, provider: 'msgraph',
          durationMs: Date.now() - startedAt, recipients: allRecipients,
        });
        const messageId = sent?.internetMessageId || null;
        if (threadEntryId && messageId) await storeEntryMessageId(threadEntryId, messageId);
        return {
          via: 'msgraph', provider: 'msgraph', providerMessageId: messageId, messageId,
          from: connection.address, replyTo,
        };
      } catch (err) {
        graphError = err;
        await emailHealthService.recordFailure({
          workspaceId, channel: 'email', context: label, provider: 'msgraph',
          error: err, durationMs: Date.now() - startedAt, recipients: allRecipients,
        });
        logger.warn(`Graph ${label} send as ${connection.address} failed, falling back to SendGrid: ${err.message}`);
      }
    }
  }

  // sendgridNotificationService.sendEmail records its own health event.
  // Reply-To on this lane points at the workspace's ingest mailbox (when
  // one is connected) so a requester's answer still reaches the ticket even
  // though the mail left as ticketpulse@.
  const sendgridReplyTo = ticket ? await sendgridLaneReplyTo(workspaceId, ticket) : null;
  const { default: sendgrid } = await import('./sendgridNotificationService.js');
  try {
    const result = await sendgrid.sendEmail({
      to: recipients,
      cc: ccRecipients,
      bcc: bccRecipients,
      from,
      replyTo: sendgridReplyTo,
      subject,
      html: htmlBody,
      text,
      fromName: senderName,
      attachments,
      customArgs,
      context: label,
      workspaceId,
      ticketIdForMessageId: ticket?.id || null,
      inReplyTo: threading.inReplyTo,
      references: threading.references,
    });
    const messageId = result?.messageId || null;
    if (threadEntryId && messageId) await storeEntryMessageId(threadEntryId, messageId);
    return {
      via: 'sendgrid',
      provider: result?.provider || 'sendgrid',
      providerMessageId: result?.providerMessageId || null,
      messageId,
      from: from || null,
      replyTo: sendgridReplyTo,
    };
  } catch (err) {
    if (graphError) err.graphError = graphError.message;
    throw err;
  }
}

/**
 * Plus-address Reply-To for a SendGrid-lane ticket email: the workspace's
 * ingest-capable mailbox (mode ingest|both) + `tp<n>`; null when there is
 * none or the ticket is FS-born. Never throws.
 */
export async function sendgridLaneReplyTo(workspaceId, ticket) {
  try {
    const ingest = await pickIngestMailbox(workspaceId ?? ticket?.workspaceId);
    return ingest ? plusAddressReplyTo(ingest.address, ticket) : null;
  } catch (err) {
    logger.debug(`sendgridLaneReplyTo skipped: ${err.message}`);
    return null;
  }
}

/**
 * Non-fatal wrapper: never throws.
 * @returns {{ sent: boolean, via?: string, reason?: string, error?: string, messageId?: string|null }}
 */
export async function sendTransactionalEmail(params) {
  const label = params?.label || 'email';
  if (normalizeList(params?.to).length === 0) return { sent: false, reason: 'no_recipient' };
  try {
    const result = await deliverTransactionalEmail({ ...params, label });
    return { sent: true, via: result.via, ...(result.messageId ? { messageId: result.messageId } : {}) };
  } catch (err) {
    logger.warn(`Transactional ${label} send failed (non-fatal): ${err.message}`);
    return { sent: false, error: err.message };
  }
}

export default { sendTransactionalEmail, deliverTransactionalEmail, sendgridLaneReplyTo };
