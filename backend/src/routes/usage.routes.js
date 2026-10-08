import express from 'express';
import usageStatsService from '../services/usageStatsService.js';

const router = express.Router();

/**
 * Site stats intake: the browser's page views and time, once a minute per
 * open tab and once more when the tab is hidden or closed. Any signed-in
 * person (agents included). Answers 204 straight away: the events go into a
 * buffer and nothing here waits for the database or reports a problem back.
 */
router.post('/batch', (req, res) => {
  try {
    usageStatsService.acceptBatch(req.session?.user ?? req.user ?? null, req.body, { userAgent: req.get('user-agent') });
  } catch { /* stats never fail a request */ }
  res.status(204).end();
});

export default router;
