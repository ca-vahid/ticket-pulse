import autoResponseService from '../services/autoResponseService.js';
import assignmentPipelineService from '../services/assignmentPipelineService.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

/**
 * POST /api/webhook/:workspaceSlug/ticket
 * Receive incoming ticket webhook and trigger auto-response
 */
export const handleTicketWebhook = async (req, res) => {
  try {
    const payload = req.body;

    logger.info('Received ticket webhook', {
      ticketId: payload.ticketId || payload.ticket_id,
      senderEmail: payload.senderEmail || payload.requester?.email,
    });

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
      workspaceId: req.workspaceId,
    };

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
 * POST /api/webhook/:workspaceSlug/assignment
 * Trigger the assignment pipeline for an incoming ticket
 */
export const handleAssignmentWebhook = async (req, res) => {
  try {
    const payload = req.body;
    const workspaceId = req.workspaceId;

    const freshserviceTicketId = payload.freshserviceTicketId || payload.ticket_id || payload.id;

    logger.info('Received assignment webhook', {
      freshserviceTicketId,
      workspaceId,
    });

    if (!freshserviceTicketId) {
      return res.status(400).json({ success: false, message: 'Missing ticket ID in payload' });
    }

    // Find the ticket in our DB by FreshService ID
    const ticket = await prisma.ticket.findFirst({
      where: {
        freshserviceTicketId: BigInt(freshserviceTicketId),
        workspaceId,
      },
      select: { id: true },
    });

    if (!ticket) {
      return res.status(404).json({
        success: false,
        message: `Ticket with FreshService ID ${freshserviceTicketId} not found in workspace. It may not be synced yet.`,
      });
    }

    // Run the pipeline asynchronously -- respond immediately
    res.status(202).json({
      success: true,
      message: 'Assignment pipeline triggered',
      data: { ticketId: ticket.id, freshserviceTicketId },
    });

    // Fire-and-forget pipeline execution
    assignmentPipelineService.runPipeline(ticket.id, workspaceId, 'webhook').catch((error) => {
      logger.error('Assignment pipeline webhook execution failed', {
        ticketId: ticket.id,
        error: error.message,
      });
    });
  } catch (error) {
    logger.error('Assignment webhook handling error', {
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
 */
export const testWebhook = async (req, res) => {
  res.json({
    success: true,
    message: 'Webhook endpoint is accessible',
    timestamp: new Date().toISOString(),
  });
};
