import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth } from '../middleware/auth.js';
import noiseRuleService from '../services/noiseRuleService.js';
import logger from '../utils/logger.js';

const router = express.Router();

router.use(requireAuth);

/**
 * GET /api/noise-rules
 * List all noise rules
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const rules = await noiseRuleService.getAllRules();
    res.json({ success: true, data: rules });
  }),
);

/**
 * GET /api/noise-rules/stats
 * Get noise ticket statistics
 */
router.get(
  '/stats',
  asyncHandler(async (req, res) => {
    const stats = await noiseRuleService.getStats();
    res.json({ success: true, data: stats });
  }),
);

/**
 * POST /api/noise-rules
 * Create a new noise rule
 */
router.post(
  '/',
  asyncHandler(async (req, res) => {
    const { name, pattern, description, category, isEnabled } = req.body;

    if (!name || !pattern) {
      return res.status(400).json({
        success: false,
        message: 'Name and pattern are required',
      });
    }

    try {
      const rule = await noiseRuleService.createRule({
        name,
        pattern,
        description,
        category,
        isEnabled,
      });
      logger.info(`Created noise rule: ${name}`);
      res.status(201).json({ success: true, data: rule });
    } catch (error) {
      return res.status(400).json({
        success: false,
        message: error.message,
      });
    }
  }),
);

/**
 * PUT /api/noise-rules/:id
 * Update a noise rule
 */
router.put(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid rule ID' });
    }

    try {
      const rule = await noiseRuleService.updateRule(id, req.body);
      logger.info(`Updated noise rule ${id}: ${rule.name}`);
      res.json({ success: true, data: rule });
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ success: false, message: 'Rule not found' });
      }
      return res.status(400).json({ success: false, message: error.message });
    }
  }),
);

/**
 * DELETE /api/noise-rules/:id
 * Delete a noise rule
 */
router.delete(
  '/:id',
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id)) {
      return res.status(400).json({ success: false, message: 'Invalid rule ID' });
    }

    try {
      await noiseRuleService.deleteRule(id);
      logger.info(`Deleted noise rule ${id}`);
      res.json({ success: true, message: 'Rule deleted' });
    } catch (error) {
      if (error.code === 'P2025') {
        return res.status(404).json({ success: false, message: 'Rule not found' });
      }
      throw error;
    }
  }),
);

/**
 * POST /api/noise-rules/test
 * Test a regex pattern against existing tickets
 */
router.post(
  '/test',
  asyncHandler(async (req, res) => {
    const { pattern } = req.body;
    if (!pattern) {
      return res.status(400).json({ success: false, message: 'Pattern is required' });
    }

    try {
      const result = await noiseRuleService.testPattern(pattern);
      res.json({ success: true, data: result });
    } catch (error) {
      return res.status(400).json({ success: false, message: error.message });
    }
  }),
);

/**
 * POST /api/noise-rules/backfill
 * Re-evaluate all tickets against current rules
 */
router.post(
  '/backfill',
  asyncHandler(async (req, res) => {
    logger.info('Starting noise rule backfill...');
    const result = await noiseRuleService.backfillAll((progress) => {
      logger.info(`Backfill progress: ${progress.totalProcessed}/${progress.totalTickets} (${progress.noiseCount} noise)`);
    });

    logger.info(`Backfill complete: ${result.updated} tickets updated, ${result.noiseCount} noise tickets`);
    res.json({ success: true, data: result });
  }),
);

/**
 * POST /api/noise-rules/seed
 * Seed default noise rules (only if none exist)
 */
router.post(
  '/seed',
  asyncHandler(async (req, res) => {
    const count = await noiseRuleService.seedDefaults();
    res.json({
      success: true,
      message: `${count} noise rules seeded`,
      data: { count },
    });
  }),
);

export default router;
