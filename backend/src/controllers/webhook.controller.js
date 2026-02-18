import autoResponseService from '../services/autoResponseService.js';
import logger from '../utils/logger.js';

/**
 * Webhook Controller
 * Handles incoming webhook requests for ticket auto-responses
 */

/**
 * POST /api/webhook/ticket
 * Receive incoming ticket webhook and trigger auto-response
 */
export const handleTicketWebhook = async (req, res) => {
  try {
    const payload = req.body;

    logger.info('Received ticket webhook', {
      ticketId: payload.ticketId || payload.ticket_id,
      senderEmail: payload.senderEmail || payload.requester?.email,
    });

    // Normalize payload structure (support different webhook formats)
    const normalizedPayload = {
      ticketId: payload.ticketId || payload.ticket_id || payload.id,
      freshserviceTicketId: payload.freshserviceTicketId || payload.ticket_id || payload.id,
      subject: payload.subject || payload.ticket?.subject || 'No subject',
      body: payload.body || payload.description || payload.ticket?.description || '',
      senderEmail: payload.senderEmail || payload.requester?.email || payload.email || 'unknown@example.com',
      senderName: payload.senderName || payload.requester?.name || payload.name || 'Unknown',
      priority: payload.priority,
      status: payload.status,
      source: payload.source,
      createdAt: payload.createdAt || payload.created_at || new Date().toISOString(),
    };

    // Process auto-response asynchronously
    const result = await autoResponseService.processIncomingTicket(normalizedPayload);

    if (result.success) {
      res.status(200).json({
        success: true,
        message: 'Ticket webhook processed successfully',
        data: {
          autoResponseId: result.autoResponseId,
          classification: result.classification,
          responseSent: result.responseSent,
          estimatedWaitMinutes: result.estimatedWaitMinutes,
        },
      });
    } else {
      res.status(500).json({
        success: false,
        message: 'Failed to process ticket webhook',
        error: result.error,
      });
    }
  } catch (error) {
    logger.error('Webhook handling error', {
      error: error.message,
      stack: error.stack,
    });

    res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message,
    });
  }
};

/**
 * GET /api/webhook/test
 * Test endpoint to verify webhook is accessible
 */
export const testWebhook = async (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is accessible',
    timestamp: new Date().toISOString(),
  });
};

