import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, requireWorkspaceAccess } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { ValidationError } from '../utils/errors.js';
import settingsRepository from '../services/settingsRepository.js';
import technicianRepository from '../services/technicianRepository.js';
import syncService from '../services/syncService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import { sendAssignmentEmail } from '../services/sendgridNotificationService.js';
import { placeVoiceCall, sendSms, sendWhatsApp } from '../services/twilioNotificationService.js';
import logger from '../utils/logger.js';

const router = express.Router();
const MASKED_SETTING_VALUE = '***MASKED***';
const SENSITIVE_SETTING_KEYS = new Set(['freshservice_api_key', 'sendgrid_api_key', 'twilio_auth_token']);

function maskSensitiveSettings(settings) {
  for (const key of SENSITIVE_SETTING_KEYS) {
    if (settings[key]) settings[key] = MASKED_SETTING_VALUE;
  }
  return settings;
}

function normalizeSettingsForUpdate(settings) {
  const normalized = { ...settings };
  for (const key of SENSITIVE_SETTING_KEYS) {
    if (normalized[key] === '' || normalized[key] === MASKED_SETTING_VALUE) {
      delete normalized[key];
    }
  }
  return normalized;
}

function validateE164(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  if (!/^\+[1-9]\d{6,14}$/.test(String(value).trim())) {
    throw new ValidationError(`${fieldName} must be in E.164 format, for example +16045550100`);
  }
}

function validateEmail(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim())) {
    throw new ValidationError(`${fieldName} must be a valid email address`);
  }
}

function attachWorkspaceIdIfPresent(req, _res, next) {
  const raw = req.headers['x-workspace-id'] || req.session?.user?.selectedWorkspaceId || req.query.workspaceId;
  if (raw !== undefined && raw !== null && raw !== '') {
    const workspaceId = Number(raw);
    if (!Number.isNaN(workspaceId)) req.workspaceId = workspaceId;
  }
  next();
}

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
    maskSensitiveSettings(settings);

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
  attachWorkspaceIdIfPresent,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { settings } = req.body;

    if (!settings || typeof settings !== 'object') {
      throw new ValidationError('Settings object is required');
    }

    const normalizedSettings = normalizeSettingsForUpdate(settings);

    // Validate specific settings
    if (normalizedSettings.sync_interval_minutes !== undefined) {
      const interval = Number(normalizedSettings.sync_interval_minutes);
      if (isNaN(interval) || interval < 1 || interval > 60) {
        throw new ValidationError('Sync interval must be between 1 and 60 minutes');
      }
    }

    if (normalizedSettings.dashboard_refresh_seconds !== undefined) {
      const refresh = Number(normalizedSettings.dashboard_refresh_seconds);
      if (isNaN(refresh) || refresh < 10 || refresh > 300) {
        throw new ValidationError('Dashboard refresh must be between 10 and 300 seconds');
      }
    }

    validateE164(normalizedSettings.twilio_from_number, 'Twilio phone number');
    validateEmail(normalizedSettings.sendgrid_from_email, 'SendGrid from email');
    if (normalizedSettings.twilio_account_sid !== undefined
      && normalizedSettings.twilio_account_sid
      && !String(normalizedSettings.twilio_account_sid).trim().startsWith('AC')) {
      throw new ValidationError('Twilio Account SID should start with AC');
    }

    // Update settings
    const count = await settingsRepository.setMany(normalizedSettings);

    logger.info(`Updated ${count} settings`);

    // If sync interval changed, restart scheduled sync
    if (normalizedSettings.sync_interval_minutes !== undefined) {
      const newInterval = Number(normalizedSettings.sync_interval_minutes);
      logger.info(`Restarting scheduled sync after sync interval setting update: ${newInterval}m`);
      await scheduledSyncService.restart();
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
  attachWorkspaceIdIfPresent,
  requireAdmin,
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
 * POST /api/settings/notification-providers/test
 * Send a real provider test using the saved global provider configuration.
 */
router.post(
  '/notification-providers/test',
  requireAdmin,
  asyncHandler(async (req, res) => {
    const channel = String(req.body?.channel || '').trim();
    const recipient = String(req.body?.recipient || '').trim();

    if (!recipient) throw new ValidationError('Test recipient is required');

    let result;
    if (channel === 'sendgrid') {
      validateEmail(recipient, 'Test recipient');
      result = await sendAssignmentEmail({
        to: recipient,
        subject: 'Ticket Pulse notification provider test',
        body: 'This is a Ticket Pulse SendGrid test email. If you received it, email notifications are configured.',
      });
    } else if (channel === 'twilio_sms') {
      validateE164(recipient, 'Test recipient');
      result = await sendSms({
        to: recipient,
        body: 'Ticket Pulse Twilio SMS test. If you received this, SMS notifications are configured.',
      });
    } else if (channel === 'twilio_whatsapp') {
      validateE164(recipient, 'Test recipient');
      result = await sendWhatsApp({
        to: recipient,
        body: 'Ticket Pulse Twilio WhatsApp test. If you received this, WhatsApp notifications are configured.',
      });
    } else if (channel === 'twilio_voice') {
      validateE164(recipient, 'Test recipient');
      result = await placeVoiceCall({
        to: recipient,
        message: 'Ticket Pulse Twilio voice test. If you received this call, voice notifications are configured.',
      });
    } else {
      throw new ValidationError('Unknown notification provider test channel');
    }

    res.json({
      success: true,
      data: {
        provider: result.provider,
        providerMessageId: result.providerMessageId,
        status: result.status,
        recipient: result.to,
      },
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
  requireWorkspace,
  requireWorkspaceAccess,
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
  requireWorkspace,
  requireWorkspaceAccess,
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

/**
 * GET /api/settings/technicians/:id/workspaces
 * List workspaces where a technician (same freshserviceId) is active.
 * Useful for identifying shared technicians across workspaces.
 */
router.get(
  '/technicians/:id/workspaces',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const tech = await technicianRepository.getById(id);
    if (!tech) {
      return res.status(404).json({ success: false, message: 'Technician not found' });
    }
    const prismaClient = (await import('../services/prisma.js')).default;
    const siblings = await prismaClient.technician.findMany({
      where: {
        freshserviceId: tech.freshserviceId,
        isActive: true,
      },
      include: { workspace: { select: { id: true, name: true, slug: true } } },
    });
    res.json({
      success: true,
      data: siblings.map(s => ({
        workspaceId: s.workspace.id,
        workspaceName: s.workspace.name,
        workspaceSlug: s.workspace.slug,
        technicianId: s.id,
        isCurrent: s.id === id,
      })),
    });
  }),
);

export default router;
