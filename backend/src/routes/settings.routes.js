import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { ValidationError } from '../utils/errors.js';
import settingsRepository from '../services/settingsRepository.js';
import technicianRepository from '../services/technicianRepository.js';
import syncService from '../services/syncService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import logger from '../utils/logger.js';

const router = express.Router();

// Protect all settings routes with authentication
router.use(requireAuth);

/**
 * GET /api/settings
 * Get all settings
 */
router.get(
  '/',
  asyncHandler(async (req, res) => {
    const settings = await settingsRepository.getAll();

    // Mask API key for security
    if (settings.freshservice_api_key) {
      settings.freshservice_api_key = '***MASKED***';
    }

    res.json({
      success: true,
      data: settings,
    });
  }),
);

/**
 * PUT /api/settings
 * Update multiple settings
 */
router.put(
  '/',
  asyncHandler(async (req, res) => {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      throw new ValidationError('Settings object is required');
    }

    // Validate specific settings
    if (settings.sync_interval_minutes !== undefined) {
      const interval = Number(settings.sync_interval_minutes);
      if (isNaN(interval) || interval < 1 || interval > 60) {
        throw new ValidationError('Sync interval must be between 1 and 60 minutes');
      }
    }

    if (settings.dashboard_refresh_seconds !== undefined) {
      const refresh = Number(settings.dashboard_refresh_seconds);
      if (isNaN(refresh) || refresh < 10 || refresh > 300) {
        throw new ValidationError('Dashboard refresh must be between 10 and 300 seconds');
      }
    }

    // Update settings
    const count = await settingsRepository.setMany(settings);

    logger.info(`Updated ${count} settings`);

    // If sync interval changed, restart scheduled sync
    if (settings.sync_interval_minutes !== undefined) {
      const newInterval = Number(settings.sync_interval_minutes);
      logger.info(`Restarting scheduled sync with new interval: ${newInterval}m`);
      await scheduledSyncService.restart(newInterval);
    }

    res.json({
      success: true,
      message: `${count} settings updated successfully`,
    });
  }),
);

/**
 * PUT /api/settings/:key
 * Update a single setting
 */
router.put(
  '/:key',
  asyncHandler(async (req, res) => {
    const { key } = req.params;
    const { value } = req.body;

    if (value === undefined) {
      throw new ValidationError('Value is required');
    }

    await settingsRepository.set(key, value);

    logger.info(`Updated setting: ${key}`);

    res.json({
      success: true,
      message: `Setting ${key} updated successfully`,
    });
  }),
);

/**
 * POST /api/settings/test-connection
 * Test FreshService connection
 */
router.post(
  '/test-connection',
  asyncHandler(async (req, res) => {
    logger.info('Testing FreshService connection');

    const isConnected = await syncService.testConnection();

    res.json({
      success: true,
      connected: isConnected,
      message: isConnected
        ? 'FreshService connection successful'
        : 'FreshService connection failed',
    });
  }),
);

/**
 * POST /api/settings/initialize
 * Initialize default settings
 */
router.post(
  '/initialize',
  asyncHandler(async (req, res) => {
    logger.info('Initializing default settings');

    const count = await settingsRepository.initializeDefaults();

    res.json({
      success: true,
      message: `${count} default settings initialized`,
    });
  }),
);

/**
 * GET /api/settings/admins
 * Get the list of admin emails. Falls back to ADMIN_EMAILS env var if not in DB.
 */
router.get(
  '/admins',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const dbVal = await settingsRepository.get('admin_emails');
    let emails;
    if (dbVal && dbVal.trim()) {
      emails = dbVal.split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    } else {
      emails = (process.env.ADMIN_EMAILS || '').split(',').map(e => e.trim().toLowerCase()).filter(Boolean);
    }
    res.json({ success: true, data: { emails, source: dbVal ? 'database' : 'env' } });
  }),
);

/**
 * PUT /api/settings/admins
 * Update the admin emails list. Stores in app_settings.
 */
router.put(
  '/admins',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { emails } = req.body;
    if (!Array.isArray(emails) || emails.length === 0) {
      return res.status(400).json({ success: false, message: 'emails array is required and must not be empty' });
    }

    const currentUserEmail = req.session?.user?.email?.toLowerCase();
    const cleaned = emails.map(e => e.trim().toLowerCase()).filter(Boolean);

    if (currentUserEmail && !cleaned.includes(currentUserEmail)) {
      return res.status(400).json({ success: false, message: 'You cannot remove yourself from the admin list' });
    }

    await settingsRepository.set('admin_emails', cleaned.join(','));
    logger.info(`Admin emails updated to: ${cleaned.join(', ')}`);

    res.json({ success: true, data: { emails: cleaned } });
  }),
);

/**
 * GET /api/settings/technicians
 * Get all technicians for the current workspace (active + inactive).
 */
router.get(
  '/technicians',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const techs = await technicianRepository.getAll(req.workspaceId, { lite: true });
    res.json({
      success: true,
      data: techs.map(t => ({
        id: t.id,
        name: t.name,
        email: t.email,
        photoUrl: t.photoUrl,
        isActive: t.isActive,
      })),
    });
  }),
);

/**
 * PUT /api/settings/technicians/:id/active
 * Enable or disable a technician.
 */
router.put(
  '/technicians/:id/active',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const { isActive } = req.body;
    if (typeof isActive !== 'boolean') {
      return res.status(400).json({ success: false, message: 'isActive boolean is required' });
    }
    const tech = await technicianRepository.update(id, { isActive });
    clearReadCache();
    logger.info(`Technician ${tech.name} (${id}) ${isActive ? 'enabled' : 'disabled'}`);
    res.json({ success: true, data: { id: tech.id, name: tech.name, isActive: tech.isActive } });
  }),
);

export default router;
