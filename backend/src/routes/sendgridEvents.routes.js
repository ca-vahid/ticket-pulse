/**
 * SendGrid Event Webhook receiver (12 Oct 2026). Pre-auth: SendGrid calls it, not a signed-in person.
 * The caller proves itself with the token in the URL (`?token=`), compared to the stored setting.
 * Answers at once; the work happens after the response so SendGrid never retries on our slowness.
 */
import express from 'express';
import logger from '../utils/logger.js';
import emailBounceService from '../services/emailBounceService.js';

const router = express.Router();

router.post('/sendgrid-events', async (req, res) => {
  const ok = await emailBounceService.verifyToken(req.query?.token).catch(() => false);
  if (!ok) return res.status(401).json({ success: false });
  const events = Array.isArray(req.body) ? req.body : [];
  res.status(202).json({ success: true, accepted: events.length });
  if (events.length) {
    setImmediate(() => {
      emailBounceService.handleEvents(events)
        .then((out) => { if (out.failed) logger.info(`SendGrid events: ${out.seen} received, ${out.failed} not delivered, ${out.matched} matched, ${out.noted} noted on tickets`); })
        .catch((err) => logger.warn(`SendGrid event handling failed: ${err.message}`));
    });
  }
  return undefined;
});

export default router;
