import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import vtService from '../services/vacationTrackerService.js';
import vtRepo from '../services/vacationTrackerRepository.js';

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
        }
        : null,
    });
  }),
);

router.put(
  '/config',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { apiKey, syncEnabled } = req.body;
    const data = {};
    if (apiKey !== undefined) data.apiKey = apiKey;
    if (syncEnabled !== undefined) data.syncEnabled = syncEnabled;

    const config = await vtRepo.upsertConfig(req.workspaceId, data);
    res.json({
      success: true,
      data: {
        syncEnabled: config.syncEnabled,
        lastSyncAt: config.lastSyncAt,
        hasApiKey: !!config.apiKey,
      },
    });
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
