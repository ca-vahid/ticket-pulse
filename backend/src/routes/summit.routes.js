import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import summitWorkshopService from '../services/summitWorkshopService.js';

export const summitPublicRouter = express.Router();
export const summitProtectedRouter = express.Router();

summitPublicRouter.get('/:token', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getPublicWorkshop(req.params.token, req.query?.participantKey);
  res.json({ success: true, ...result });
}));

summitPublicRouter.get('/:token/events', asyncHandler(async (req, res) => {
  await summitWorkshopService.streamPublicWorkshop(req.params.token, res);
}));

summitPublicRouter.post('/:token/join', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.joinPublicWorkshop(
    req.params.token,
    req.body?.displayName,
    req.body?.participantKey,
  );
  res.json({ success: true, ...result });
}));

summitPublicRouter.post('/:token/votes', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.submitVote(req.params.token, req.body || {});
  res.json({ success: true, ...result });
}));

summitPublicRouter.post('/:token/feedback/items', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.submitPublicFeedbackItem(req.params.token, req.body || {});
  res.json({ success: true, ...result });
}));

summitPublicRouter.post('/:token/feedback/items/:itemId/vote', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.votePublicFeedbackItem(req.params.token, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

summitPublicRouter.post('/:token/feedback/items/:itemId/comments', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.commentPublicFeedbackItem(req.params.token, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

summitProtectedRouter.get('/workshop', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getOrCreateWorkshop(req.workspaceId, req.session?.user?.email);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.get('/workshop/events', asyncHandler(async (req, res) => {
  await summitWorkshopService.streamWorkshopByWorkspace(req.workspaceId, res);
}));

summitProtectedRouter.get('/workshop/feedback', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getWorkshopFeedback(req.workspaceId);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/feedback/items', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.submitAuthenticatedFeedbackItem(req.workspaceId, req.session?.user || {}, req.body || {});
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/feedback/items/:itemId/vote', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.voteAuthenticatedFeedbackItem(req.workspaceId, req.session?.user || {}, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/feedback/items/:itemId/comments', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.commentAuthenticatedFeedbackItem(req.workspaceId, req.session?.user || {}, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

summitProtectedRouter.put('/workshop/feedback/items/:itemId', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.updateFeedbackItem(req.workspaceId, req.params.itemId, req.body || {});
  res.json({ success: true, ...result });
}));

summitProtectedRouter.delete('/workshop/feedback/items/:itemId', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.deleteFeedbackItem(req.workspaceId, req.params.itemId);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.delete('/workshop/feedback/comments/:commentItemId', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.deleteFeedbackComment(req.workspaceId, req.params.commentItemId);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/feedback/reset', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.resetFeedback(req.workspaceId);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.put('/workshop/state', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.saveWorkshopState(
    req.workspaceId,
    {
      state: req.body?.state,
      label: req.body?.label,
      snapshotType: req.body?.snapshotType || 'manual',
    },
    req.session?.user?.email,
  );
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/snapshots/:id/restore', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.restoreSnapshot(
    req.workspaceId,
    req.params.id,
    req.session?.user?.email,
  );
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/voting', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.configureVoting(
    req.workspaceId,
    req.body?.durationMinutes,
    !!req.body?.regenerate,
  );
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/voting/extend', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.extendVoting(
    req.workspaceId,
    req.body?.extensionMinutes,
  );
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/participants/:id/reset', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.resetParticipantVotes(req.workspaceId, req.params.id);
  res.json({ success: true, ...result });
}));

summitProtectedRouter.post('/workshop/participants/reset-stale', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.resetStaleParticipants(req.workspaceId);
  res.json({ success: true, ...result });
}));

export default summitProtectedRouter;
