/**
 * QA 10-01 #3 — Autofill from the Teams bot, web side.
 *
 * GET /api/teams-autofill/:token — the New Ticket page (/tickets/new?autofill=…)
 * reads the draft the bot made: the extraction, the pasted text and the
 * pictures. Signed-in callers only, and only the person who sent the message
 * (anyone else gets a 404). Mounted after requireAuth but before workspace
 * enforcement: the draft names its own workspace and the page switches to it.
 */
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { AuthenticationError } from '../utils/errors.js';
import teamsIntakeService from '../services/teamsIntakeService.js';

const router = express.Router();

router.get('/:token', asyncHandler(async (req, res) => {
  const email = (req.session?.user ?? req.user)?.email;
  if (!email) throw new AuthenticationError('Authentication required');
  res.set('Cache-Control', 'no-store');
  const data = await teamsIntakeService.getPrefill(req.params.token, email);
  res.json({ success: true, data });
}));

export default router;
