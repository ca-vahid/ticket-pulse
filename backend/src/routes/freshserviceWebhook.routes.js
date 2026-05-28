import express from 'express';
import freshServiceWebhookIngestService, { WebhookIngestError } from '../services/freshServiceWebhookIngestService.js';
import workspaceWebhookService from '../services/workspaceWebhookService.js';
import logger from '../utils/logger.js';

const router = express.Router();

function firstNumericCandidate(candidates) {
  for (const candidate of candidates) {
    if (candidate === undefined || candidate === null || candidate === '') continue;
    const value = String(candidate).trim();
    if (/^\d+$/.test(value)) return value;
  }
  return null;
}

export function normalizeFreshServiceWebhookTicketId(body = {}) {
  return firstNumericCandidate([
    body.ticket_id,
    body.ticketId,
    body.freshservice_ticket_id,
    body.freshserviceTicketId,
    body.ticket?.id,
    body.ticket?.ticket_id,
    body.ticket?.freshservice_ticket_id,
    body.data?.ticket_id,
    body.data?.ticketId,
    body.data?.ticket?.id,
    body.data?.ticket?.ticket_id,
    body.payload?.ticket_id,
    body.payload?.ticketId,
    body.payload?.ticket?.id,
    body.event?.ticket_id,
    body.event?.ticket?.id,
    body.id,
  ]);
}

function getSuppliedSecret(req) {
  const direct = req.get(workspaceWebhookService.headerName)
    || req.get('x-webhook-secret')
    || req.query.token
    || req.query.webhook_secret;
  if (direct) return String(direct);

  const auth = req.get('authorization') || '';
  if (auth.toLowerCase().startsWith('bearer ')) {
    return auth.slice(7).trim();
  }
  return null;
}

router.post('/:workspaceSlug/tickets', async (req, res) => {
  const freshserviceTicketId = normalizeFreshServiceWebhookTicketId(req.body || {});
  const suppliedSecret = getSuppliedSecret(req);

  try {
    const result = await freshServiceWebhookIngestService.handleTicketWebhook({
      workspaceSlug: req.params.workspaceSlug,
      freshserviceTicketId,
      suppliedSecret,
    });
    return res.status(202).json({ success: true, data: result });
  } catch (error) {
    const statusCode = error instanceof WebhookIngestError ? error.statusCode : 500;
    const code = error instanceof WebhookIngestError ? error.code : 'webhook_error';
    const message = error instanceof WebhookIngestError ? error.message : 'Webhook processing failed';
    logger.warn('FreshService webhook rejected', {
      workspaceSlug: req.params.workspaceSlug,
      freshserviceTicketId: freshserviceTicketId || null,
      code,
      statusCode,
    });
    return res.status(statusCode).json({
      success: false,
      code,
      message,
    });
  }
});

export default router;
