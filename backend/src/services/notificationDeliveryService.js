import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { sendAssignmentEmail } from './sendgridNotificationService.js';
import { placeVoiceCall, sendSms, sendWhatsApp } from './twilioNotificationService.js';

function payloadValue(payload, key) {
  return payload && typeof payload === 'object' ? payload[key] : null;
}

function buildEmailSubject(delivery) {
  const ticketId = payloadValue(delivery.payload, 'freshserviceTicketId');
  return ticketId
    ? `Ticket Pulse: ${delivery.assessedPriority} priority ticket #${ticketId}`
    : `Ticket Pulse: ${delivery.assessedPriority} priority ticket`;
}

async function sendDelivery(delivery) {
  const message = payloadValue(delivery.payload, 'message');
  const voiceMessage = payloadValue(delivery.payload, 'voiceMessage') || message;

  if (delivery.channel === 'email') {
    return sendAssignmentEmail({
      to: delivery.recipient,
      subject: buildEmailSubject(delivery),
      body: message,
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
        status: 'failed',
        retryCount: { increment: 1 },
        error: error.message,
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

export async function processQueuedDeliveries({ limit = 25 } = {}) {
  const deliveries = await prisma.notificationDelivery.findMany({
    where: { status: 'queued' },
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
