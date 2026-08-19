import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { sendAssignmentEmail, sendEmail } from './sendgridNotificationService.js';
import { placeVoiceCall, sendSms, sendWhatsApp } from './twilioNotificationService.js';
import { resolveFromName } from './workspaceEmailIdentityService.js';

function payloadValue(payload, key) {
  return payload && typeof payload === 'object' ? payload[key] : null;
}

function buildEmailSubject(delivery) {
  if (delivery.subject) return delivery.subject;
  const ticketId = payloadValue(delivery.payload, 'freshserviceTicketId');
  const priorityLabel = delivery.assessedPriority || 'updated';
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

async function sendDelivery(delivery) {
  const message = bodyFromDelivery(delivery);
  const voiceMessage = payloadValue(delivery.payload, 'voiceMessage') || message;

  if (delivery.channel === 'email') {
    const toRecipients = listFromDelivery(delivery, 'toRecipients', delivery.recipient ? [delivery.recipient] : []);
    const hasWorkflowBody = delivery.htmlBody || delivery.textBody || payloadValue(delivery.payload, 'htmlBody');
    // Per-workspace From display name (Phase EB); falls back to the global
    // default inside resolveFromName when the workspace has no override.
    const fromName = await resolveFromName(delivery.workspaceId ?? null);
    if (hasWorkflowBody || toRecipients.length > 1 || delivery.ccRecipients?.length || delivery.bccRecipients?.length) {
      return sendEmail({
        to: toRecipients,
        cc: listFromDelivery(delivery, 'ccRecipients'),
        bcc: listFromDelivery(delivery, 'bccRecipients'),
        from: delivery.fromAddress || payloadValue(delivery.payload, 'fromAddress'),
        fromName,
        subject: buildEmailSubject(delivery),
        html: delivery.htmlBody || payloadValue(delivery.payload, 'htmlBody') || payloadValue(delivery.payload, 'html'),
        text: message,
        customArgs: {
          delivery_id: String(delivery.id),
          workspace_id: String(delivery.workspaceId),
          ...(delivery.workflowRunId ? { workflow_run_id: String(delivery.workflowRunId) } : {}),
        },
      });
    }
    return sendAssignmentEmail({
      to: delivery.recipient,
      subject: buildEmailSubject(delivery),
      body: message,
      fromName,
    });
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
    await prisma.notificationDelivery.update({
      where: { id: delivery.id },
      data: {
        status: 'sent',
        provider: result.provider || delivery.provider,
        providerMessageId: result.providerMessageId,
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
