import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import vtService from '../services/vacationTrackerService.js';
import vtRepo from '../services/vacationTrackerRepository.js';
import VacationTrackerV2Client, { describeV2Error, looksLikeV2Key } from '../integrations/vacationTrackerV2.js';

const router = express.Router();

router.use(requireAuth);

// ── Config ──

router.get(
  '/config',
  asyncHandler(async (req, res) => {
    const config = await vtRepo.getConfig(req.workspaceId);
    res.json({
      success: true,
      data: config
        ? {
          syncEnabled: config.syncEnabled,
          lastSyncAt: config.lastSyncAt,
          hasApiKey: !!config.apiKey,
          hasApiKeyV2: !!config.apiKeyV2,
        }
        : null,
    });
  }),
);

router.put(
  '/config',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { apiKey, apiKeyV2, syncEnabled } = req.body;
    const data = {};
    // A v2 key in the v1 slot would stop the hourly sync (3 Oct 2026).
    if (apiKey !== undefined && looksLikeV2Key(apiKey)) {
      return res.status(400).json({ success: false, error: 'That is an API v2 key (vt_live_…). Paste it in the "API v2 key" field; this field keeps the v1 key.' });
    }
    if (apiKeyV2 !== undefined && apiKeyV2 && !looksLikeV2Key(apiKeyV2)) {
      return res.status(400).json({ success: false, error: 'An API v2 key starts with vt_live_. Create one in Vacation Tracker under Add-ons → Open API.' });
    }
    if (apiKey !== undefined) data.apiKey = apiKey;
    if (apiKeyV2 !== undefined) data.apiKeyV2 = apiKeyV2 || null;
    if (syncEnabled !== undefined) data.syncEnabled = syncEnabled;

    const config = await vtRepo.upsertConfig(req.workspaceId, data);
    res.json({
      success: true,
      data: {
        syncEnabled: config.syncEnabled,
        lastSyncAt: config.lastSyncAt,
        hasApiKey: !!config.apiKey,
        hasApiKeyV2: !!config.apiKeyV2,
      },
    });
  }),
);

router.post(
  '/config/test-v2',
  requireAdmin,
  asyncHandler(async (req, res) => {
    let key = req.body?.apiKey;
    if (!key) key = (await vtRepo.getConfig(req.workspaceId))?.apiKeyV2;
    if (!key) return res.status(400).json({ success: false, error: 'No API v2 key provided' });
    if (!looksLikeV2Key(key)) return res.json({ success: false, error: 'An API v2 key starts with vt_live_' });
    try {
      await new VacationTrackerV2Client(key).testConnection();
      res.json({ success: true });
    } catch (err) {
      res.json({ success: false, error: describeV2Error(err) });
    }
  }),
);

router.post(
  '/config/test',
  asyncHandler(async (req, res) => {
    const { apiKey } = req.body;
    let key = apiKey;
    if (!key) {
      const config = await vtRepo.getConfig(req.workspaceId);
      key = config?.apiKey;
    }
    if (!key) {
      return res.status(400).json({ success: false, error: 'No API key provided' });
    }
    if (looksLikeV2Key(key)) {
      return res.json({ success: false, error: 'That is an API v2 key (vt_live_…) — use the "API v2 key" field below. This test checks the v1 key.' });
    }
    const result = await vtService.testConnection(key);
    res.json({ success: result.success, error: result.error });
  }),
);

// ── Leave Types ──

router.get(
  '/leave-types',
  asyncHandler(async (req, res) => {
    const leaveTypes = await vtRepo.getLeaveTypes(req.workspaceId);
    res.json({ success: true, data: leaveTypes });
  }),
);

router.post(
  '/leave-types/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const leaveTypes = await vtService.syncLeaveTypes(req.workspaceId);
    res.json({ success: true, data: leaveTypes });
  }),
);

router.put(
  '/leave-types',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { mappings } = req.body;
    if (!Array.isArray(mappings)) {
      return res.status(400).json({ success: false, error: 'mappings array required' });
    }
    const valid = ['OFF', 'WFH', 'OTHER', 'IGNORED'];
    for (const m of mappings) {
      if (!valid.includes(m.category)) {
        return res.status(400).json({ success: false, error: `Invalid category: ${m.category}` });
      }
    }
    const results = await vtRepo.bulkUpdateLeaveTypeCategories(mappings);
    res.json({ success: true, data: results });
  }),
);

// ── User Mappings ──

router.get(
  '/users',
  asyncHandler(async (req, res) => {
    const mappings = await vtRepo.getUserMappings(req.workspaceId);
    res.json({ success: true, data: mappings });
  }),
);

router.post(
  '/users/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const results = await vtService.syncUsers(req.workspaceId);
    res.json({ success: true, data: results });
  }),
);

router.put(
  '/users/:id/match',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { technicianId } = req.body;
    const id = parseInt(req.params.id, 10);
    const matchStatus = technicianId ? 'manual_matched' : 'unmatched';
    const result = await vtRepo.updateUserMappingMatch(id, technicianId || null, matchStatus);
    res.json({ success: true, data: result });
  }),
);

// ── Sync ──

router.post(
  '/sync',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const result = await vtService.fullSync(req.workspaceId);
    res.json({ success: true, data: result });
  }),
);

router.get(
  '/sync/status',
  asyncHandler(async (req, res) => {
    res.json({ success: true, data: vtService.getSyncStatus() });
  }),
);

// ── Leaves (for dashboard consumption) ──

router.get(
  '/leaves',
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.query;
    if (!startDate || !endDate) {
      return res.status(400).json({ success: false, error: 'startDate and endDate required' });
    }
    const leaves = await vtRepo.getLeavesByDateRange(
      req.workspaceId,
      new Date(startDate + 'T00:00:00Z'),
      new Date(endDate + 'T00:00:00Z'),
    );
    res.json({ success: true, data: leaves });
  }),
);

export default router;
