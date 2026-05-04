import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import agentCompetencyService from '../services/agentCompetencyService.js';

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

export default router;
