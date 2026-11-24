/**
 * QA 11-23 item 2: the weekly "the requester raised it" list. Tickets the AI
 * had at Medium or Low that the requester raised from their status link, for
 * the coordinators' weekly look at how the AI judged them. Read-only and
 * scoped to the selected workspace; reviewer (coordinator) or admin.
 *
 * GET /api/assignment/priority-raises?days=7
 *   → { success: true, data: [{ ticketId, displayRef, subject, aiPriority, raisedTo, raisedAt, requesterName }], days }
 */
import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireReviewer } from '../middleware/auth.js';
import { listRequesterPriorityRaises } from '../services/priorityHistoryService.js';

const router = express.Router();

router.get('/priority-raises', requireReviewer, asyncHandler(async (req, res) => {
  const requested = Number(req.query.days);
  const days = Number.isFinite(requested) ? Math.min(90, Math.max(1, Math.floor(requested))) : 7;
  const data = await listRequesterPriorityRaises({ workspaceId: req.workspaceId, days });
  res.json({ success: true, data, days });
}));

export default router;
