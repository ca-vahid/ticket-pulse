import logger from '../utils/logger.js';
import emailHealthService from './emailHealthService.js';
import { resolveFromName } from './workspaceEmailIdentityService.js';
import { pickIngestMailbox, pickOutboundMailbox, sendgridFromAddress } from './mailboxPicker.js';
import * as mailboxPicker from './mailboxPicker.js';
import { plusAddressReplyTo, storeEntryMessageId, threadingHeadersForTicket } from './emailThreadingService.js';

/**
 * The team mailbox a send should use (22 Nov 2026). A workspace with one mailbox per team
 * (Accounting: AP and AR) sent every workflow e-mail from the primary, so an AR ticket's
 * notice left from the AP address while the agent's reply on the same ticket (since 4.3.91)
 * left from the AR one. `mailboxTicket` = { workspaceId, groupId, internalGroupId } of the
 * ticket the e-mail is about; null = the usual workspace pick. Never another workspace's
 * mailbox: a ticket from elsewhere is ignored.
 */
function teamTicketFor(workspaceId, mailboxTicket) {
  if (!mailboxTicket || typeof mailboxTicket !== 'object') return null;
  const ws = Number(workspaceId ?? mailboxTicket.workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return null;
  if (mailboxTicket.workspaceId !== null && mailboxTicket.workspaceId !== undefined && Number(mailboxTicket.workspaceId) !== ws) return null;
  return { workspaceId: ws, groupId: mailboxTicket.groupId ?? null, internalGroupId: mailboxTicket.internalGroupId ?? null };
}

/** The Graph-lane connection: the ticket's team mailbox when there is one, else the primary. */
async function outboundConnectionFor(workspaceId, teamTicket) {
  if (teamTicket && typeof mailboxPicker.pickOutboundMailboxForTicket === 'function') {
    return mailboxPicker.pickOutboundMailboxForTicket(teamTicket);
  }
  return pickOutboundMailbox(workspaceId);
}

/** The SendGrid-lane mailbox (From and Reply-To): the ticket's team mailbox, else the primary. Never throws. */
async function ingestConnectionFor(workspaceId, teamTicket) {
  try {
    if (teamTicket && typeof mailboxPicker.pickIngestMailboxForTicket === 'function') {
      return await mailboxPicker.pickIngestMailboxForTicket(teamTicket);
    }
    return await pickIngestMailbox(workspaceId ?? null);
  } catch (err) {
    logger.debug(`ingest mailbox pick skipped: ${err.message}`);
    return null;
  }
}

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
// Display names for the e-mails Ticket Pulse sends to its own people (19 Oct
// 2026, Vahid), keyed by the send's label. A caller's own fromName still wins
// (an approver's question carries their name), and anything not listed here,
// above all every e-mail to a requester, keeps the workspace's sender name
// from Email branding. On the Graph lane Exchange may still show the mailbox's
// own name; the SendGrid lane keeps these exactly.
export const SYSTEM_SENDER_NAMES = Object.freeze({
  approval: 'Ticket Pulse Approval',
  report: 'Ticket Pulse Reports',
  alert: 'Ticket Pulse Alerts',
  notice: 'Ticket Pulse Notifications',
});
const LABEL_KIND = Object.freeze({
  'noise-close-digest': 'report',
  'urgent-response-digest': 'report',
  'mailbox-hold-digest': 'report',
  'knowledge-review-digest': 'report',
  'auto-help-overnight-summary': 'report',
  'agent alert': 'alert',
  'sync-health-alert': 'alert',
  'teams-assistant-cap': 'alert',
  'urgent response notice': 'alert',
  'park wake': 'notice',
  'ready to close': 'notice',
  'task assignment': 'notice',
  'task due reminder': 'notice',
  'open tasks handed over': 'notice',
  'auto-help-assignee': 'notice',
  'auto-help-preview': 'notice',
  'auto-help handover': 'notice',
});

/** The header that marks mail Ticket Pulse sent itself (intake reads it as `email.ticketPulseMail`). */
export const OWN_MAIL_HEADER = 'X-Ticket-Pulse-Mail';

export function systemSenderName(label) {
  const key = String(label || '').trim().toLowerCase();
  if (!key) return null;
  if (key === 'approval' || key.startsWith('approval ')) return SYSTEM_SENDER_NAMES.approval;
  const kind = LABEL_KIND[key];
  return kind ? SYSTEM_SENDER_NAMES[kind] : null;
}

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
  // Approvals v3: an explicit Reply-To (plus-address reply key) wins over the
  // ticket-derived one on both lanes.
  replyTo: replyToOverride = null,
  // 22 Nov 2026: the ticket the e-mail is about, for the team-mailbox pick
  // only (no threading — that stays with `ticket`). See teamTicketFor.
  mailboxTicket = null,
  // 24 Nov 2026 (mail loop): an automatic e-mail (a workflow's). It carries
  // `X-Ticket-Pulse-Mail: workflow` on both lanes and, on SendGrid (Graph only
  // takes X- names), the RFC 3834 `Auto-Submitted: auto-generated`.
  automated = false,
}) {
  const teamTicket = teamTicketFor(workspaceId, mailboxTicket);
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
  const senderName = fromName || systemSenderName(label) || await resolveFromName(workspaceId ?? null);
  const threading = ticket?.id
    ? await threadingHeadersForTicket(ticket.id)
    : { inReplyTo: null, references: [] };
  const htmlBody = html || htmlFromText(text);
  // Brand pictograms referenced as cid:tp-* travel inline with the message (17 Sep 2026).
  const { withBrandAttachments } = await import('./emailBrandAssets.js');
  attachments = withBrandAttachments(attachments, htmlBody);
  const allRecipients = [...recipients, ...ccRecipients, ...bccRecipients];

  let graphError = null;
  const connection = await outboundConnectionFor(workspaceId, teamTicket);
  if (connection) {
    const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
    if (graphMailClient.isConfigured()) {
      // Graph bypasses sendgridNotificationService, so record its health here.
      const startedAt = Date.now();
      // A send-only mailbox is not read (22 Nov 2026 review): replies to it would be
      // lost, so the plus-address comes from the mailbox that reads replies, or none.
      let replyTo = replyToOverride || null;
      if (!replyTo && ticket) {
        const readsReplies = connection.mode === 'send' ? await ingestConnectionFor(workspaceId, teamTicket) : connection;
        replyTo = readsReplies?.address ? plusAddressReplyTo(readsReplies.address, ticket) : null;
      }
      try {
        const sent = await graphMailClient.sendMailAsMailbox(connection.address, {
          to: recipients,
          // 16 Nov 2026: Bcc travels as Bcc on this lane too (it used to be
          // folded into Cc, which showed the Bcc'd person to everyone).
          cc: ccRecipients,
          bcc: bccRecipients,
          subject,
          html: htmlBody,
          attachments,
          fromName: senderName,
          replyTo,
          inReplyTo: threading.inReplyTo,
          references: threading.references,
          ...(automated ? { headers: { [OWN_MAIL_HEADER]: 'workflow' } } : {}),
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
  // Reply-To on this lane points at the workspace's ingest mailbox (when one
  // is connected) so a requester's answer still reaches the ticket. Since
  // FR 09-11 #5 the mail also LEAVES from that mailbox's address when the
  // caller did not name one — a workspace's mail should carry the address
  // people write to, not the global sender's.
  let sendgridReplyTo;
  let laneFrom;
  if (teamTicket) {
    // The ticket's team mailbox gives both the From and the Reply-To home.
    const ingest = await ingestConnectionFor(workspaceId, teamTicket);
    sendgridReplyTo = replyToOverride || (ticket && ingest ? plusAddressReplyTo(ingest.address, ticket) : null);
    laneFrom = from || String(ingest?.address || '').trim() || null;
  } else {
    sendgridReplyTo = replyToOverride || (ticket ? await sendgridLaneReplyTo(workspaceId, ticket) : null);
    laneFrom = from || await sendgridFromAddress(workspaceId ?? ticket?.workspaceId ?? null);
  }
  const { default: sendgrid } = await import('./sendgridNotificationService.js');
  try {
    const result = await sendgrid.sendEmail({
      to: recipients,
      cc: ccRecipients,
      bcc: bccRecipients,
      from: laneFrom,
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
      ...(automated ? { headers: { 'Auto-Submitted': 'auto-generated', [OWN_MAIL_HEADER]: 'workflow' } } : {}),
    });
    const messageId = result?.messageId || null;
    if (threadEntryId && messageId) await storeEntryMessageId(threadEntryId, messageId);
    return {
      via: 'sendgrid',
      provider: result?.provider || 'sendgrid',
      providerMessageId: result?.providerMessageId || null,
      messageId,
      from: laneFrom || null,
      replyTo: sendgridReplyTo,
      // QA 11-24 item 9: why this went by SendGrid when a mailbox was there to send it.
      ...(graphError ? { graphFallbackReason: String(graphError.message || graphError).slice(0, 300) } : {}),
    };
  } catch (err) {
    if (graphError) err.graphError = graphError.message;
    throw err;
  }
}

/**
 * Plus-address Reply-To for a SendGrid-lane ticket email: the workspace's
 * ingest-capable mailbox (mode ingest|both) + `tp<n>` (TP-born) or `fs<n>`
 * (FS-born, 17 Sep 2026); null when there is none. Never throws.
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
 * The address a send WOULD leave from, without sending (22 Nov 2026): what Preview and
 * Shadow show for a workflow e-mail. Same picks as deliverTransactionalEmail — the
 * (team) Graph mailbox when Graph is set up, else the caller's `from`, else the (team)
 * SendGrid mailbox, else the global sender. Never throws; null when unknown.
 * @returns {Promise<{ address: string|null, via: 'msgraph'|'sendgrid' }|null>}
 */
export async function plannedSenderAddress({ workspaceId, from = null, mailboxTicket = null } = {}) {
  try {
    const teamTicket = teamTicketFor(workspaceId, mailboxTicket);
    const connection = await outboundConnectionFor(workspaceId, teamTicket);
    if (connection?.address) {
      const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
      if (graphMailClient.isConfigured()) return { address: connection.address, via: 'msgraph' };
    }
    const pinned = String(from || '').trim();
    if (pinned) return { address: pinned, via: 'sendgrid' };
    const ingest = await ingestConnectionFor(workspaceId, teamTicket);
    if (ingest?.address) return { address: String(ingest.address).trim(), via: 'sendgrid' };
    const { default: settingsRepository } = await import('./settingsRepository.js');
    const config = await settingsRepository.getSendGridConfig();
    return { address: config?.fromEmail || config?.smtpFromEmail || null, via: 'sendgrid' };
  } catch (err) {
    logger.debug(`plannedSenderAddress skipped: ${err.message}`);
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

export default { sendTransactionalEmail, deliverTransactionalEmail, sendgridLaneReplyTo, plannedSenderAddress };
