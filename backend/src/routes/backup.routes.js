import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAdmin } from '../middleware/auth.js';
import backupService from '../services/backupService.js';
import { ValidationError, AuthorizationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Backup & Restore (BACKUP_RESTORE_PLAN Layer 2/3).
 *
 * Mounted behind requireAuth + requireWorkspace + requireWorkspaceAccess (see
 * routes/index.js), then requireAdmin here: every endpoint needs at least a
 * workspace admin. Site-scope snapshots/schedules additionally need a GLOBAL
 * admin — same check requireGlobalAdmin uses (session role === 'admin'),
 * applied inline because scope arrives in the body/row, not the path.
 */
const router = express.Router();

router.use(requireAdmin);

function isGlobalAdmin(req) {
  return req.session?.user?.role === 'admin';
}

function parseId(raw, label) {
  const id = Number(raw);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError(`Invalid ${label}`);
  return id;
}

/** Non-global admins may only touch workspace-scope snapshots of their current workspace. */
async function loadAccessibleSnapshot(req) {
  const id = parseId(req.params.id, 'snapshot id');
  const snapshot = await backupService.getSnapshot(id);
  if (!isGlobalAdmin(req)) {
    if (snapshot.scope !== 'workspace' || snapshot.workspaceId !== req.workspaceId) {
      throw new AuthorizationError('You do not have access to this snapshot');
    }
  }
  return snapshot;
}

async function loadAccessibleSchedule(req) {
  const id = parseId(req.params.id, 'schedule id');
  const schedule = await backupService.getSchedule(id);
  if (!isGlobalAdmin(req)) {
    if (schedule.scope !== 'workspace' || schedule.workspaceId !== req.workspaceId) {
      throw new AuthorizationError('You do not have access to this schedule');
    }
  }
  return schedule;
}

/** Restores target the caller's workspace unless a global admin says otherwise. */
function resolveTargetWorkspaceId(req) {
  const requested = req.body?.targetWorkspaceId;
  if (requested === undefined || requested === null) return req.workspaceId;
  const target = parseId(requested, 'targetWorkspaceId');
  if (target !== req.workspaceId && !isGlobalAdmin(req)) {
    throw new AuthorizationError('Cross-workspace restore requires a global admin');
  }
  return target;
}

// ---- Snapshots -------------------------------------------------------------

// GET /api/backup/snapshots
router.get(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const snapshots = await backupService.listSnapshots({
      workspaceId: req.workspaceId,
      isGlobalAdmin: isGlobalAdmin(req),
    });
    res.json({ success: true, data: snapshots });
  }),
);

// POST /api/backup/snapshots { scope?, tier? }
router.post(
  '/snapshots',
  asyncHandler(async (req, res) => {
    const scope = req.body?.scope || 'workspace';
    const tier = req.body?.tier || 'config';
    if (scope === 'site' && !isGlobalAdmin(req)) {
      throw new AuthorizationError('Full-site snapshots require a global admin');
    }
    const snapshot = await backupService.createSnapshot({
      scope,
      tier,
      workspaceId: scope === 'workspace' ? req.workspaceId : null,
      trigger: 'manual',
      actorEmail: req.session?.user?.email || null,
    });
    res.status(snapshot.status === 'failed' ? 500 : 201).json({ success: snapshot.status !== 'failed', data: snapshot });
  }),
);

// GET /api/backup/snapshots/:id/download — streams the raw .json.gz bundle
router.get(
  '/snapshots/:id/download',
  asyncHandler(async (req, res) => {
    const snapshot = await loadAccessibleSnapshot(req);
    const { stream, fileName } = await backupService.downloadStream(snapshot.id);
    res.setHeader('Content-Type', 'application/gzip');
    res.setHeader('Content-Disposition', `attachment; filename="${fileName}"`);
    if (snapshot.sizeBytes) res.setHeader('Content-Length', String(snapshot.sizeBytes));
    stream.on('error', (err) => {
      logger.error(`Backup download stream failed for snapshot ${snapshot.id}: ${err.message}`);
      res.destroy(err);
    });
    stream.pipe(res);
  }),
);

// DELETE /api/backup/snapshots/:id
router.delete(
  '/snapshots/:id',
  asyncHandler(async (req, res) => {
    const snapshot = await loadAccessibleSnapshot(req);
    await backupService.deleteSnapshot(snapshot.id);
    logger.info(`[backup] snapshot ${snapshot.id} deleted by ${req.session?.user?.email || 'unknown'}`);
    res.json({ success: true, message: 'Snapshot deleted' });
  }),
);

// POST /api/backup/snapshots/:id/dry-run { modules?, targetWorkspaceId?, sourceWorkspaceId? }
router.post(
  '/snapshots/:id/dry-run',
  asyncHandler(async (req, res) => {
    const snapshot = await loadAccessibleSnapshot(req);
    const result = await backupService.dryRunRestore(snapshot.id, {
      targetWorkspaceId: resolveTargetWorkspaceId(req),
      modules: req.body?.modules,
      sourceWorkspaceId: req.body?.sourceWorkspaceId,
      mode: req.body?.mode || 'merge',
    });
    res.json({ success: true, data: result });
  }),
);

// POST /api/backup/snapshots/:id/restore { modules?, mode?, targetWorkspaceId?, sourceWorkspaceId? }
router.post(
  '/snapshots/:id/restore',
  asyncHandler(async (req, res) => {
    const snapshot = await loadAccessibleSnapshot(req);
    const result = await backupService.applyRestore(snapshot.id, {
      targetWorkspaceId: resolveTargetWorkspaceId(req),
      modules: req.body?.modules,
      mode: req.body?.mode || 'merge',
      sourceWorkspaceId: req.body?.sourceWorkspaceId,
      actorEmail: req.session?.user?.email || null,
    });
    res.json({ success: true, data: result });
  }),
);

// ---- Schedules -------------------------------------------------------------

// GET /api/backup/schedules
router.get(
  '/schedules',
  asyncHandler(async (req, res) => {
    const schedules = await backupService.listSchedules({
      workspaceId: req.workspaceId,
      isGlobalAdmin: isGlobalAdmin(req),
    });
    res.json({ success: true, data: schedules });
  }),
);

// POST /api/backup/schedules { scope?, tier?, frequency?, hourUtc?, weekday?, retentionCount?, enabled? }
router.post(
  '/schedules',
  asyncHandler(async (req, res) => {
    const scope = req.body?.scope || 'workspace';
    if (scope === 'site' && !isGlobalAdmin(req)) {
      throw new AuthorizationError('Site-scope schedules require a global admin');
    }
    const schedule = await backupService.createSchedule({
      ...req.body,
      scope,
      workspaceId: scope === 'workspace' ? req.workspaceId : null,
    });
    res.status(201).json({ success: true, data: schedule });
  }),
);

// PATCH /api/backup/schedules/:id
router.patch(
  '/schedules/:id',
  asyncHandler(async (req, res) => {
    const schedule = await loadAccessibleSchedule(req);
    if (req.body?.scope === 'site' && !isGlobalAdmin(req)) {
      throw new AuthorizationError('Site-scope schedules require a global admin');
    }
    const updated = await backupService.updateSchedule(schedule.id, req.body || {});
    res.json({ success: true, data: updated });
  }),
);

// DELETE /api/backup/schedules/:id
router.delete(
  '/schedules/:id',
  asyncHandler(async (req, res) => {
    const schedule = await loadAccessibleSchedule(req);
    await backupService.deleteSchedule(schedule.id);
    res.json({ success: true, message: 'Schedule deleted' });
  }),
);

export default router;
