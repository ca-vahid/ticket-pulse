import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { deliverTransactionalEmail } from './transactionalEmailService.js';
import { placeVoiceCall, sendSms, sendWhatsApp } from './twilioNotificationService.js';
import { resolveFromName } from './workspaceEmailIdentityService.js';

function payloadValue(payload, key) {
  return payload && typeof payload === 'object' ? payload[key] : null;
}

function buildEmailSubject(delivery) {
  if (delivery.subject) return delivery.subject;
  const priorityLabel = delivery.assessedPriority || 'updated';
  // QA 11-23 item 1: the ticket's own reference (TP-n / #n) when the alert carries it.
  const ticketRef = payloadValue(delivery.payload, 'ticketRef');
  if (ticketRef) return `Ticket Pulse: ${priorityLabel} priority ticket ${ticketRef}`;
  const ticketId = payloadValue(delivery.payload, 'freshserviceTicketId');
  return ticketId
    ? `Ticket Pulse: ${priorityLabel} priority ticket #${ticketId}`
    : `Ticket Pulse: ${priorityLabel} priority ticket`;
}

function listFromDelivery(delivery, field, fallback = []) {
  if (Array.isArray(delivery[field]) && delivery[field].length > 0) return delivery[field];
  const payloadList = payloadValue(delivery.payload, field);
  if (Array.isArray(payloadList) && payloadList.length > 0) return payloadList;
  return fallback;
}

function bodyFromDelivery(delivery) {
  return delivery.textBody
    || payloadValue(delivery.payload, 'textBody')
    || payloadValue(delivery.payload, 'text')
    || payloadValue(delivery.payload, 'message');
}

/**
 * The ticket behind a delivery, ONLY when the email is requester-facing
 * (the requester or a ticket Cc is among To/Cc). Threading anchors and the
 * plus-address Reply-To then apply; agent-facing pings (assignment alerts)
 * deliberately get none — an agent answering a notification must not be
 * ingested as a requester reply. Best-effort: a lookup failure means "no
 * threading", never a failed send.
 */
async function deliveryTicket(delivery) {
  const ticketId = Number(delivery.ticketId);
  if (!Number.isInteger(ticketId) || ticketId <= 0) return null;
  try {
    return await prisma.ticket.findUnique({
      where: { id: ticketId },
      select: {
        id: true, workspaceId: true, origin: true, nativeNumber: true, freshserviceTicketId: true, ccEmails: true,
        // 22 Nov 2026: the team mailbox pick (group → internal group → primary).
        groupId: true, internalGroupId: true,
        requester: { select: { email: true } },
      },
    }) || null;
  } catch (err) {
    logger.debug(`Delivery ${delivery.id}: ticket lookup for threading skipped: ${err.message}`);
    return null;
  }
}

function requesterFacing(ticket, toRecipients, ccRecipients) {
  if (!ticket) return null;
  const audience = new Set([...toRecipients, ...ccRecipients].map((a) => String(a || '').trim().toLowerCase()).filter(Boolean));
  const ticketSide = [ticket.requester?.email, ...(Array.isArray(ticket.ccEmails) ? ticket.ccEmails : [])]
    .map((a) => String(a || '').trim().toLowerCase()).filter(Boolean);
  return ticketSide.some((a) => audience.has(a)) ? ticket : null;
}

/**
 * A workflow e-mail (a run's send step, or the editor's test send) — the ones that leave
 * from the ticket's team mailbox (22 Nov 2026). Assignment and alert pings keep the
 * workspace's usual sender.
 */
function isWorkflowEmail(delivery) {
  return Boolean(delivery.workflowRunId) || delivery.notificationType === 'notification_workflow_test_email';
}

/** The ticket's team-mailbox keys for the transport, or null (no ticket / another workspace). */
function mailboxTicketFor(delivery, ticket) {
  if (!ticket || !isWorkflowEmail(delivery)) return null;
  if (delivery.workspaceId !== null && delivery.workspaceId !== undefined && Number(ticket.workspaceId) !== Number(delivery.workspaceId)) return null;
  return { workspaceId: ticket.workspaceId, groupId: ticket.groupId ?? null, internalGroupId: ticket.internalGroupId ?? null };
}

/** Observer Bcc for a workflow e-mail (its workflow read from the run). Never throws. */
async function observerBccForDelivery(delivery, to, cc, bcc) {
  try {
    const run = await prisma.notificationWorkflowRun.findUnique({ where: { id: Number(delivery.workflowRunId) }, select: { workflowId: true } });
    const { observerBccFor } = await import('./workflowMailObserverService.js');
    return await observerBccFor({ workspaceId: delivery.workspaceId, workflowId: run?.workflowId ?? null, to, cc, bcc });
  } catch (err) {
    logger.debug(`Delivery ${delivery.id}: observer Bcc skipped: ${err.message}`);
    return [];
  }
}

/**
 * Machine senders taken off a workflow e-mail's To/Cc (16 Nov 2026) and its own Bcc
 * (22 Nov 2026). Runs before the observer Bcc is added, so that one is never dropped.
 * Never throws.
 */
async function machineSplitForDelivery(delivery, to, cc, bcc) {
  try {
    const { splitMachineRecipients } = await import('./machineSenderService.js');
    const split = await splitMachineRecipients({ workspaceId: delivery.workspaceId, to, cc, bcc });
    return { ...split, bcc: Array.isArray(split.bcc) ? split.bcc : bcc };
  } catch (err) {
    logger.debug(`Delivery ${delivery.id}: machine-sender check skipped: ${err.message}`);
    return { to, cc, bcc, removed: [] };
  }
}

/**
 * Our own mailboxes taken off a workflow e-mail's To/Cc/Bcc (24 Nov 2026 mail
 * loop): every connected mailbox in any workspace, its also-known-as addresses
 * and `+tag` variants, the global sender and FreshService relay addresses
 * (originalRecipientsService.ownMailboxAddresses / isOwnAddress). A workflow
 * e-mail to one of them came back in as a new ticket from "our other mailbox",
 * whose acknowledgement came back again: 39 e-mails and 19 tickets in Accounting.
 * Throws when the list cannot be read: the caller does not send (fail safe).
 */
async function ownMailboxSplit(to, cc, bcc) {
  const { ownMailboxAddresses, isOwnAddress, bareAddress } = await import('./originalRecipientsService.js');
  const own = await ownMailboxAddresses();
  const removed = [];
  const keep = (list, field) => list.filter((raw) => {
    const address = bareAddress(raw) || String(raw || '').trim().toLowerCase();
    if (!isOwnAddress(address, own)) return true;
    removed.push({ address, field });
    return false;
  });
  return { to: keep(to, 'to'), cc: keep(cc, 'cc'), bcc: keep(bcc, 'bcc'), removed };
}

async function sendDelivery(delivery) {
  const message = bodyFromDelivery(delivery);
  const voiceMessage = payloadValue(delivery.payload, 'voiceMessage') || message;

  if (delivery.channel === 'email') {
    let toRecipients = listFromDelivery(delivery, 'toRecipients', delivery.recipient ? [delivery.recipient] : []);
    let ccRecipients = listFromDelivery(delivery, 'ccRecipients');
    // A copy: the observer Bcc is pushed onto it below, never onto the row's own list.
    let bccRecipients = [...listFromDelivery(delivery, 'bccRecipients')];
    // Never e-mail our own mailboxes from a workflow (24 Nov 2026), whichever
    // token put them there (the requester, Cc, a fixed address). With nobody
    // left on To the e-mail is not sent. When the list cannot be read nobody
    // can be checked, so nothing is sent: the delivery fails and can be retried.
    let ownRemoved = [];
    if (delivery.workflowRunId) {
      let split;
      try {
        split = await ownMailboxSplit(toRecipients, ccRecipients, bccRecipients);
      } catch (err) {
        logger.warn(`Delivery ${delivery.id} not sent: our own-mailbox list could not be read (${err.message})`);
        const error = new Error(`Not sent: our own-mailbox list could not be read, so the recipients could not be checked (${err.message})`);
        error.retryable = true;
        error.errorClass = 'own_mailbox_unverified';
        throw error;
      }
      if (split.removed.length) {
        ownRemoved = split.removed;
        toRecipients = split.to;
        ccRecipients = split.cc;
        bccRecipients = split.bcc;
        logger.info(`Delivery ${delivery.id}: our own mailbox(es) taken off (${ownRemoved.map((r) => `${r.field}: ${r.address}`).join(', ')})`);
        if (!toRecipients.some((a) => String(a || '').includes('@'))) {
          return { skipped: 'own_mailbox', ownRemoved };
        }
      }
    }
    // Machine senders (16 Nov 2026): BambooHR's new-hire notices, Darktrace's
    // alerts and no-reply addresses open real tickets, but a workflow e-mail to
    // them reaches nobody. They come off To/Cc and (22 Nov 2026) the step's own
    // Bcc; with nobody left on To the e-mail is not sent at all — a Bcc alone,
    // custom or observer, never makes a send.
    let machineRemoved = [];
    if (delivery.workflowRunId) {
      const split = await machineSplitForDelivery(delivery, toRecipients, ccRecipients, bccRecipients);
      if (split.removed.length) {
        machineRemoved = split.removed;
        toRecipients = split.to;
        ccRecipients = split.cc;
        bccRecipients = split.bcc;
        if (!toRecipients.some((a) => String(a || '').includes('@'))) {
          return { skipped: 'machine_sender', machineRemoved, ...(ownRemoved.length ? { ownRemoved } : {}) };
        }
      }
    }
    // "Copy me on workflow e-mails" (16 Nov 2026): an observer set for the
    // workspace gets a Bcc of every e-mail a workflow sends, without the
    // workflow knowing. Shadow e-mails never get here.
    // Only alongside a real recipient: an e-mail whose To came out empty (an
    // unattended requester) must never become a send to the observer alone.
    const hasRealTo = toRecipients.some((a) => String(a || '').includes('@'));
    const observerBcc = delivery.workflowRunId && hasRealTo ? await observerBccForDelivery(delivery, toRecipients, ccRecipients, bccRecipients) : [];
    if (observerBcc.length) bccRecipients.push(...observerBcc);
    const hasWorkflowBody = delivery.htmlBody || delivery.textBody || payloadValue(delivery.payload, 'htmlBody');
    // Per-workspace From display name (Phase EB); falls back to the global
    // default inside resolveFromName when the workspace has no override.
    const fromName = await resolveFromName(delivery.workspaceId ?? null);
    const deliveryTicketRow = await deliveryTicket(delivery);
    const ticket = requesterFacing(deliveryTicketRow, toRecipients, ccRecipients);
    // 22 Nov 2026: a workflow e-mail about a ticket leaves from the ticket's team
    // mailbox (an AR ticket from the AR address), the same pick agent replies use.
    // Only the address changes; the From name above is untouched.
    const mailboxTicket = mailboxTicketFor(delivery, deliveryTicketRow);
    // Mega 08-31 Phase MB-1a: every lane rides the mailbox-aware transport —
    // workspace mailbox via Graph when one is connected (replies land back in
    // the ticket), SendGrid otherwise / on Graph failure. Template + branding
    // are untouched (same subject/html/text/fromName as before); send-health
    // telemetry records on both lanes inside the transport.
    // A machine sender taken off means To no longer equals delivery.recipient: send the list.
    const rich = hasWorkflowBody || toRecipients.length > 1 || ccRecipients.length > 0 || bccRecipients.length > 0 || machineRemoved.length > 0 || ownRemoved.length > 0;
    const result = await deliverTransactionalEmail({
      workspaceId: delivery.workspaceId ?? null,
      to: rich ? toRecipients : [delivery.recipient],
      cc: rich ? ccRecipients : [],
      bcc: rich ? bccRecipients : [],
      from: rich ? (delivery.fromAddress || payloadValue(delivery.payload, 'fromAddress')) : null,
      fromName,
      subject: buildEmailSubject(delivery),
      html: rich ? (delivery.htmlBody || payloadValue(delivery.payload, 'htmlBody') || payloadValue(delivery.payload, 'html')) : null,
      text: message,
      label: rich ? 'workflow' : 'assignment',
      customArgs: rich ? {
        delivery_id: String(delivery.id),
        workspace_id: String(delivery.workspaceId),
        ...(delivery.workflowRunId ? { workflow_run_id: String(delivery.workflowRunId) } : {}),
      } : null,
      ticket,
      ...(mailboxTicket ? { mailboxTicket } : {}),
      // 24 Nov 2026: a workflow e-mail says it is automatic (Auto-Submitted /
      // X-Ticket-Pulse-Mail), so our own intake, and other systems, never answer it.
      ...(isWorkflowEmail(delivery) ? { automated: true } : {}),
    });
    const machineFromBcc = machineRemoved.some((r) => r.field === 'bcc');
    const ownFromBcc = ownRemoved.some((r) => r.field === 'bcc');
    return {
      provider: result.provider,
      providerMessageId: result.providerMessageId,
      via: result.via,
      messageId: result.messageId,
      from: result.from,
      replyTo: result.replyTo,
      status: 'accepted',
      ...(observerBcc.length ? { observerBcc } : {}),
      ...(observerBcc.length || machineFromBcc || ownFromBcc ? { bccRecipients } : {}),
      ...(machineRemoved.length ? { machineRemoved, toRecipients, ccRecipients } : {}),
      ...(ownRemoved.length ? { ownRemoved, toRecipients, ccRecipients } : {}),
    };
  }

  if (delivery.channel === 'sms') {
    return sendSms({
      to: delivery.recipient,
      body: message,
    });
  }

  if (delivery.channel === 'whatsapp') {
    return sendWhatsApp({
      to: delivery.recipient,
      body: message,
      variables: payloadValue(delivery.payload, 'whatsappVariables') || {},
    });
  }

  if (delivery.channel === 'phone_call') {
    return placeVoiceCall({
      to: delivery.recipient,
      message: voiceMessage,
    });
  }

  throw new Error(`Unsupported notification channel: ${delivery.channel}`);
}

export async function processDelivery(delivery) {
  try {
    const result = await sendDelivery(delivery);
    const priorPayload = delivery.payload && typeof delivery.payload === 'object' ? delivery.payload : {};
    if (result?.skipped === 'machine_sender') {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'skipped',
          error: null,
          payload: {
            ...priorPayload,
            skippedReason: 'machine_sender',
            machineRemoved: result.machineRemoved,
            ...(result.ownRemoved?.length ? { ownMailboxRemoved: result.ownRemoved } : {}),
          },
        },
      });
      logger.info(`Delivery ${delivery.id} not sent: every recipient is a machine sender (${result.machineRemoved.map((r) => r.entry).join(', ')})`);
      return { id: delivery.id, success: true, skipped: 'machine_sender' };
    }
    if (result?.skipped === 'own_mailbox') {
      await prisma.notificationDelivery.update({
        where: { id: delivery.id },
        data: {
          status: 'skipped',
          error: null,
          payload: { ...priorPayload, skippedReason: 'own_mailbox', ownMailboxRemoved: result.ownRemoved },
        },
      });
      logger.warn(`Delivery ${delivery.id} not sent: every recipient on To is one of our own mailboxes (${result.ownRemoved.map((r) => r.address).join(', ')})`);
      return { id: delivery.id, success: true, skipped: 'own_mailbox' };
    }
    // 22 Nov 2026 review: the Graph lane always sends as its mailbox and ignores a
    // from address pinned on the step, so the pinned column can name an address
    // the mail never used. The address really used goes in the payload then.
    const sentFromDiffers = Boolean(result.from && delivery.fromAddress
      && String(result.from).toLowerCase() !== String(delivery.fromAddress).toLowerCase());
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'sent',
        provider: result.provider || delivery.provider,
        providerMessageId: result.providerMessageId,
        // Phase RL (RL-5): the RFC Message-ID the mail left with (Graph
        // internetMessageId / the SendGrid lane's minted `<tp-…>` id) — what
        // a reply's In-Reply-To carries, so ingest rung 1b can thread replies
        // to SendGrid-lane acks. providerMessageId keeps SendGrid's
        // x-message-id, which never appears in a reply header.
        ...(result.messageId ? { messageId: String(result.messageId).slice(0, 255) } : {}),
        // Audit the actual sender when the transport chose one (Graph lane)
        // and the workflow node did not pin a from address.
        ...(result.from && !delivery.fromAddress ? { fromAddress: result.from } : {}),
        // Who was Bcc'd as an observer is part of the e-mail's own record.
        // So is a machine sender taken off the Bcc (22 Nov 2026).
        ...(Array.isArray(result.bccRecipients) ? { bccRecipients: result.bccRecipients } : {}),
        // Who actually got it: machine senders taken off are recorded, not silently lost.
        ...(result.machineRemoved?.length || result.ownRemoved?.length ? { toRecipients: result.toRecipients, ccRecipients: result.ccRecipients } : {}),
        ...(result.observerBcc?.length || result.machineRemoved?.length || result.ownRemoved?.length || sentFromDiffers ? {
          payload: {
            ...priorPayload,
            ...(result.observerBcc?.length ? { observerBcc: result.observerBcc } : {}),
            ...(result.machineRemoved?.length ? { machineRemoved: result.machineRemoved } : {}),
            ...(result.ownRemoved?.length ? { ownMailboxRemoved: result.ownRemoved } : {}),
            ...(sentFromDiffers ? { sentFrom: String(result.from) } : {}),
          },
        } : {}),
        sentAt: new Date(),
        error: null,
      },
    });
    return { id: delivery.id, success: true, result };
  } catch (error) {
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: error.retryable === false ? 'failed_permanent' : 'failed',
        retryCount: { increment: 1 },
        error: error.message,
        payload: {
          ...(delivery.payload && typeof delivery.payload === 'object' ? delivery.payload : {}),
          lastErrorClass: error.errorClass || null,
          lastErrorRetryable: error.retryable !== false,
        },
      },
    });
    logger.warn('Notification delivery failed', {
      deliveryId: delivery.id,
      channel: delivery.channel,
      error: error.message,
    });
    return { id: delivery.id, success: false, error: error.message };
  }
}

function uniquePositiveIds(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => Number(value))
      .filter((value) => Number.isInteger(value) && value > 0),
  )];
}

function uniqueDedupeKeys(values) {
  return [...new Set(
    (Array.isArray(values) ? values : [])
      .map((value) => String(value || '').trim())
      .filter(Boolean),
  )];
}

function queuedDeliveryWhere({ ids, dedupeKeys } = {}) {
  const deliveryIds = uniquePositiveIds(ids);
  const keys = uniqueDedupeKeys(dedupeKeys);
  const scoped = [];
  if (deliveryIds.length > 0) scoped.push({ id: { in: deliveryIds } });
  if (keys.length > 0) scoped.push({ dedupeKey: { in: keys } });

  if (scoped.length === 0) return { status: 'queued' };
  return {
    status: 'queued',
    OR: scoped,
  };
}

export async function processQueuedDeliveries({ limit = 25, ids = null, dedupeKeys = null } = {}) {
  const deliveries = await prisma.notificationDelivery.findMany({
    where: queuedDeliveryWhere({ ids, dedupeKeys }),
    orderBy: { queuedAt: 'asc' },
    take: limit,
  });

  const results = [];
  for (const delivery of deliveries) {
    // Deliver sequentially so provider failures and rate limits remain contained.
    results.push(await processDelivery(delivery));
  }

  return {
    processed: results.length,
    sent: results.filter((result) => result.success).length,
    failed: results.filter((result) => !result.success).length,
    results,
  };
}

export default {
  processDelivery,
  processQueuedDeliveries,
};
