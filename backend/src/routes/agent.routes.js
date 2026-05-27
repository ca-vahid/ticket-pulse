import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import agentCompetencyService from '../services/agentCompetencyService.js';
import summitWorkshopService from '../services/summitWorkshopService.js';
import notificationPreferenceService from '../services/notificationPreferenceService.js';

const router = express.Router();

router.get('/competencies', asyncHandler(async (req, res) => {
  const result = await agentCompetencyService.getMyCompetencyMatrix(
    req.session?.user?.email,
    req.query.workspaceId,
  );
  res.json({ success: true, data: result });
}));

router.post('/competencies/changes', asyncHandler(async (req, res) => {
  const result = await agentCompetencyService.submitMyCompetencyChange(
    req.session?.user?.email,
    req.body || {},
  );
  res.json({ success: true, ...result });
}));

router.post('/competencies/changes/bulk', asyncHandler(async (req, res) => {
  const result = await agentCompetencyService.submitMyCompetencyChanges(
    req.session?.user?.email,
    req.body || {},
  );
  res.json({ success: true, ...result });
}));

router.delete('/competencies/changes/:id', asyncHandler(async (req, res) => {
  const result = await agentCompetencyService.cancelMyCompetencyChange(
    req.session?.user?.email,
    req.params.id,
  );
  res.json({ success: true, ...result });
}));

router.get('/notifications/preferences', asyncHandler(async (req, res) => {
  const result = await notificationPreferenceService.getMyPreferences(
    req.session?.user?.email,
    req.query.workspaceId,
  );
  res.json({ success: true, data: result });
}));

router.put('/notifications/preferences', asyncHandler(async (req, res) => {
  const result = await notificationPreferenceService.saveMyPreferences(
    req.session?.user?.email,
    req.body || {},
  );
  res.json({ success: true, data: result });
}));

router.post('/notifications/phone-verification', asyncHandler(async (req, res) => {
  const result = await notificationPreferenceService.requestPhoneVerification(
    req.session?.user?.email,
    req.body || {},
  );
  res.json({ success: true, ...result });
}));

router.post('/notifications/phone-verification/confirm', asyncHandler(async (req, res) => {
  const result = await notificationPreferenceService.confirmPhoneVerification(
    req.session?.user?.email,
    req.body || {},
  );
  res.json({ success: true, data: result });
}));

router.get('/summit-2026/feedback', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getAuthenticatedFeedback(1, req.session?.user || {});
  res.json({ success: true, ...result });
}));

router.get('/summit-2026/workshop', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getAuthenticatedWorkshop(1, req.session?.user || {});
  res.json({ success: true, ...result });
}));

router.get('/summit-2026/events', asyncHandler(async (req, res) => {
  await summitWorkshopService.streamAuthenticatedFeedback(1, req.session?.user || {}, res);
}));

router.get('/summit-2026/workshop/events', asyncHandler(async (req, res) => {
  await summitWorkshopService.streamAuthenticatedWorkshop(1, req.session?.user || {}, res);
}));

router.post('/summit-2026/votes', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.submitAuthenticatedVote(1, req.session?.user || {}, req.body || {});
  res.json({ success: true, ...result });
}));

router.post('/summit-2026/feedback/items', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.submitAuthenticatedFeedbackItem(1, req.session?.user || {}, req.body || {});
  res.json({ success: true, ...result });
}));

router.post('/summit-2026/feedback/items/:itemId/vote', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.voteAuthenticatedFeedbackItem(1, req.session?.user || {}, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

router.post('/summit-2026/feedback/items/:itemId/comments', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.commentAuthenticatedFeedbackItem(1, req.session?.user || {}, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

export default router;
