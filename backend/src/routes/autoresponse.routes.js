import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import availabilityService from '../services/availabilityService.js';
import queueStatsService from '../services/queueStatsService.js';
import autoResponseRepository from '../services/autoResponseRepository.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Protect all routes with authentication
router.use(requireAuth);

/**
 * GET /api/autoresponse/business-hours
 * Get business hours configuration
 */
router.get('/business-hours', asyncHandler(async (req, res) => {
  const businessHours = await availabilityService.getBusinessHours();

  res.json({
    success: true,
    data: businessHours,
  });
}));

/**
 * PUT /api/autoresponse/business-hours
 * Update business hours configuration
 */
router.put('/business-hours', asyncHandler(async (req, res) => {
  const { hours } = req.body;

  if (!Array.isArray(hours)) {
    return res.status(400).json({
      success: false,
      message: 'Invalid hours format. Expected array of business hours.',
    });
  }

  await availabilityService.updateBusinessHours(hours);

  res.json({
    success: true,
    message: 'Business hours updated successfully',
  });
}));

/**
 * GET /api/autoresponse/holidays
 * Get all holidays
 */
router.get('/holidays', asyncHandler(async (req, res) => {
  const holidays = await availabilityService.getHolidays();

  res.json({
    success: true,
    data: holidays,
  });
}));

/**
 * POST /api/autoresponse/holidays
 * Add a new holiday
 */
router.post('/holidays', asyncHandler(async (req, res) => {
  const { name, date, isRecurring, country } = req.body;

  if (!name || !date) {
    return res.status(400).json({
      success: false,
      message: 'Name and date are required',
    });
  }

  const holiday = await availabilityService.addHoliday({
    name,
    date: new Date(date),
    isRecurring: isRecurring || false,
    country: country || null,
    isEnabled: true,
  });

  res.json({
    success: true,
    data: holiday,
    message: 'Holiday added successfully',
  });
}));

/**
 * PUT /api/autoresponse/holidays/:id
 * Update a holiday
 */
router.put('/holidays/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const { name, date, isRecurring, country, isEnabled } = req.body;

  const holiday = await availabilityService.updateHoliday(id, {
    name,
    date: date ? new Date(date) : undefined,
    isRecurring,
    country,
    isEnabled,
  });

  res.json({
    success: true,
    data: holiday,
    message: 'Holiday updated successfully',
  });
}));

/**
 * DELETE /api/autoresponse/holidays/:id
 * Delete a holiday
 */
router.delete('/holidays/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);

  await availabilityService.deleteHoliday(id);

  res.json({
    success: true,
    message: 'Holiday deleted successfully',
  });
}));

/**
 * POST /api/autoresponse/holidays/load-canadian
 * Load Canadian holidays for a given year
 */
router.post('/holidays/load-canadian', asyncHandler(async (req, res) => {
  const { year } = req.body;
  const targetYear = year || new Date().getFullYear();

  await availabilityService.loadCanadianHolidays(targetYear);

  res.json({
    success: true,
    message: `Canadian holidays loaded for ${targetYear}`,
  });
}));

/**
 * GET /api/autoresponse/responses
 * Get recent auto-responses
 */
router.get('/responses', asyncHandler(async (req, res) => {
  const limit = parseInt(req.query.limit, 10) || 50;
  const responses = await autoResponseRepository.getRecent(limit);

  res.json({
    success: true,
    data: responses,
  });
}));

/**
 * GET /api/autoresponse/responses/:id
 * Get a specific auto-response by ID
 */
router.get('/responses/:id', asyncHandler(async (req, res) => {
  const id = parseInt(req.params.id, 10);
  const response = await autoResponseRepository.getById(id);

  if (!response) {
    return res.status(404).json({
      success: false,
      message: 'Auto-response not found',
    });
  }

  res.json({
    success: true,
    data: response,
  });
}));

/**
 * GET /api/autoresponse/stats
 * Get auto-response statistics
 */
router.get('/stats', asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  const end = endDate ? new Date(endDate) : new Date();

  const stats = await autoResponseRepository.getStats(start, end);

  res.json({
    success: true,
    data: stats,
  });
}));

/**
 * GET /api/autoresponse/availability/check
 * Check current availability status
 */
router.get('/availability/check', asyncHandler(async (req, res) => {
  const now = new Date();

  const availabilityCheck = await availabilityService.isBusinessHours(now);
  const holidayCheck = await availabilityService.isHoliday(now);

  res.json({
    success: true,
    data: {
      isBusinessHours: availabilityCheck.isBusinessHours,
      reason: availabilityCheck.reason,
      isHoliday: holidayCheck.isHoliday,
      holidayName: holidayCheck.name,
      timestamp: now.toISOString(),
    },
  });
}));

/**
 * GET /api/autoresponse/eta/debug
 * Debug endpoint: returns queue stats and computed ETA for the current moment.
 * Query params:
 *  - timezone (optional): IANA timezone (default: America/Los_Angeles)
 *  - staleDays (optional): number (default: 3)
 */
router.get('/eta/debug', asyncHandler(async (req, res) => {
  const timezone = req.query.timezone || 'America/Los_Angeles';
  const staleDays = req.query.staleDays ? parseInt(req.query.staleDays, 10) : 3;

  const queueStats = await queueStatsService.getQueueStats({ timezone, staleDays });
  const eta = await availabilityService.calculateETA(queueStats);

  res.json({
    success: true,
    data: {
      queueStats,
      eta,
    },
  });
}));

/**
 * POST /api/autoresponse/test
 * Test auto-response workflow with sample data (DRY RUN - no email sent)
 * Returns detailed step-by-step execution trace
 */
router.post('/test', asyncHandler(async (req, res) => {
  const { senderEmail, senderName, subject, body } = req.body;

  // Validate input
  if (!senderEmail || !subject) {
    return res.status(400).json({
      success: false,
      message: 'senderEmail and subject are required for testing',
    });
  }

  // Import the UNIFIED auto-response service
  const autoResponseService = (await import('../services/autoResponseService.js')).default;

  // Create test webhook payload
  const testPayload = {
    ticketId: 99999,
    freshserviceTicketId: 99999,
    subject: subject || '[TEST] Auto-response test',
    body: body || 'This is a test of the auto-response system.',
    senderEmail: senderEmail,
    senderName: senderName || 'Test User',
    priority: 2,
    status: 'Open',
    source: 'Email',
    createdAt: new Date().toISOString(),
  };

  logger.info('Processing dry-run test auto-response', { senderEmail, subject });

  // Call unified service with dryRun=true
  const result = await autoResponseService.processIncomingTicket(testPayload, true);

  if (result.success) {
    res.json({
      success: true,
      message: 'Dry-run completed successfully',
      data: {
        summary: result.summary,
        executionTrace: result.executionTrace,
        email: result.email,
        sendData: result.sendData,
      },
    });
  } else {
    res.status(500).json({
      success: false,
      message: 'Dry-run test failed',
      error: result.error,
      executionTrace: result.executionTrace,
    });
  }
}));

/**
 * POST /api/autoresponse/test/send
 * Send email after dry-run review
 */
router.post('/test/send', asyncHandler(async (req, res) => {
  const { sendData } = req.body;

  if (!sendData || !sendData.senderEmail) {
    return res.status(400).json({
      success: false,
      message: 'sendData is required',
    });
  }

  // Use unified service's sendAfterReview method
  const autoResponseService = (await import('../services/autoResponseService.js')).default;

  logger.info('Sending email after dry-run review', { to: sendData.senderEmail });

  const result = await autoResponseService.sendAfterReview(sendData);

  res.json({
    success: result.success,
    message: result.success ? 'Email sent successfully' : 'Failed to send email',
    messageId: result.messageId,
    error: result.error,
  });
}));

export default router;

