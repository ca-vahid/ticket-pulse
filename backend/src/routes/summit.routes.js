import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import summitWorkshopService from '../services/summitWorkshopService.js';

export const summitPublicRouter = express.Router();
export const summitProtectedRouter = express.Router();

summitPublicRouter.get('/:token', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getPublicWorkshop(req.params.token);
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

summitProtectedRouter.get('/workshop', asyncHandler(async (req, res) => {
  const result = await summitWorkshopService.getOrCreateWorkshop(req.workspaceId, req.session?.user?.email);
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

export default summitProtectedRouter;
