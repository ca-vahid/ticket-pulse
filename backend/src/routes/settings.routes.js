import express from 'express';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireAuth, requireAdmin, requireWorkspaceAccess } from '../middleware/auth.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { ValidationError } from '../utils/errors.js';
import settingsRepository from '../services/settingsRepository.js';
import prisma from '../services/prisma.js';
import technicianRepository from '../services/technicianRepository.js';
import groupRepository from '../services/groupRepository.js';
import approvalCategoryService from '../services/approvalCategoryService.js';
import azureAdService from '../services/azureAdService.js';
import syncService from '../services/syncService.js';
import scheduledSyncService from '../services/scheduledSyncService.js';
import { clearReadCache } from '../services/dashboardReadCache.js';
import { sendAssignmentEmail } from '../services/sendgridNotificationService.js';
import { placeVoiceCall, sendSms, sendWhatsApp } from '../services/twilioNotificationService.js';
import {
  buildPublicTicketStatusUrl,
  ensurePublicTicketStatusLink,
  getPublicTicketStatusSettings,
  previewPublicTicketStatus,
  resetPublicTicketStatusLink,
  revokePublicTicketStatusLink,
  updatePublicTicketStatusSettings,
} from '../services/publicTicketStatusService.js';
import {
  getFeedbackSettings,
  updateFeedbackSettings,
  listFeedbackSubmissions,
  deleteFeedbackSubmission,
} from '../services/publicFeedbackService.js';
import urgentEscalationService from '../services/afterHoursUrgentEscalationService.js';
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

function validateWhatsAppSender(value, fieldName) {
  if (value === undefined || value === null || String(value).trim() === '') return;
  const text = String(value).trim();
  const e164 = text.toLowerCase().startsWith('whatsapp:') ? text.slice('whatsapp:'.length) : text;
  validateE164(e164, fieldName);
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

function requestActor(req) {
  return req.session?.user || req.user || null;
}

function parsePositiveId(value, label = 'id') {
  const id = Number.parseInt(value, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError(`Invalid ${label}`);
  return id;
}

function parsePositiveBigInt(value, label = 'id') {
  const text = String(value || '').trim();
  if (!/^\d+$/.test(text)) throw new ValidationError(`Invalid ${label}`);
  return BigInt(text);
}

async function ticketIdForFreshserviceNumber(workspaceId, freshserviceTicketId) {
  const ticket = await prisma.ticket.findFirst({
    where: { workspaceId, freshserviceTicketId },
    select: { id: true },
  });
  if (!ticket) throw new ValidationError('Ticket number was not found in this workspace');
  return ticket.id;
}

function serializePublicStatusTicketRow(ticket, baseUrl = null) {
  const link = ticket.publicStatusLinks?.[0] || null;
  const ticketPulseCategory = ticket.internalCategory?.name || ticket.tpSkill || null;
  const ticketPulseSubcategory = ticket.internalSubcategory?.name || ticket.tpSubskill || null;
  return {
    id: ticket.id,
    workspaceId: ticket.workspaceId,
    freshserviceTicketId: ticket.freshserviceTicketId?.toString?.() || String(ticket.freshserviceTicketId || ''),
    subject: ticket.subject || 'No subject',
    status: ticket.status || null,
    priority: ticket.assessedPriority || ({
      1: 'Low',
      2: 'Medium',
      3: 'High',
      4: 'Urgent',
    }[Number(ticket.priority)] || String(ticket.priority || '')),
    requesterName: ticket.requester?.name || null,
    assignedAgentName: ticket.assignedTech?.name || null,
    createdAt: ticket.createdAt?.toISOString?.() || null,
    updatedAt: (ticket.freshserviceUpdatedAt || ticket.updatedAt)?.toISOString?.() || null,
    ticketPulseCategory,
    ticketPulseSubcategory,
    classificationSource: ticket.internalCategory?.name || ticket.internalSubcategory?.name
      ? 'internal_taxonomy'
      : ticket.tpSkill || ticket.tpSubskill
        ? 'ticket_pulse_fields'
        : 'not_classified',
    publicLink: link ? {
      id: link.id,
      enabled: link.enabled,
      revoked: Boolean(link.revokedAt),
      expiresAt: link.expiresAt?.toISOString?.() || null,
      viewCount: link.viewCount || 0,
      lastViewedAt: link.lastViewedAt?.toISOString?.() || null,
      url: link.enabled && !link.revokedAt ? buildPublicTicketStatusUrl(link.token, baseUrl) : null,
    } : null,
  };
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
    validateWhatsAppSender(normalizedSettings.twilio_whatsapp_sender, 'WhatsApp sender');
    validateEmail(normalizedSettings.sendgrid_from_email, 'SendGrid from email');
    if (normalizedSettings.twilio_account_sid !== undefined
      && normalizedSettings.twilio_account_sid
      && !String(normalizedSettings.twilio_account_sid).trim().startsWith('AC')) {
      throw new ValidationError('Twilio Account SID should start with AC');
    }
    if (normalizedSettings.twilio_whatsapp_messaging_service_sid !== undefined
      && normalizedSettings.twilio_whatsapp_messaging_service_sid
      && !String(normalizedSettings.twilio_whatsapp_messaging_service_sid).trim().startsWith('MG')) {
      throw new ValidationError('Twilio WhatsApp Messaging Service SID should start with MG');
    }
    if (normalizedSettings.twilio_whatsapp_content_sid !== undefined
      && normalizedSettings.twilio_whatsapp_content_sid
      && !String(normalizedSettings.twilio_whatsapp_content_sid).trim().startsWith('HX')) {
      throw new ValidationError('Twilio WhatsApp Content SID should start with HX');
    }
    if (normalizedSettings.twilio_whatsapp_content_variables !== undefined
      && normalizedSettings.twilio_whatsapp_content_variables) {
      try {
        const parsed = JSON.parse(String(normalizedSettings.twilio_whatsapp_content_variables));
        if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
          throw new Error('must be a JSON object');
        }
      } catch (error) {
        throw new ValidationError(`WhatsApp content variables must be valid JSON: ${error.message}`);
      }
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
 * GET /api/settings/public-ticket-status
 * Get workspace-scoped public ticket status settings.
 */
router.get(
  '/public-ticket-status',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await getPublicTicketStatusSettings(req.workspaceId);
    res.json({ success: true, data: settings });
  }),
);

/**
 * PUT /api/settings/public-ticket-status
 * Update workspace-scoped public ticket status settings.
 */
router.put(
  '/public-ticket-status',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await updatePublicTicketStatusSettings(
      req.workspaceId,
      req.body || {},
      requestActor(req),
    );
    res.json({ success: true, data: settings });
  }),
);

/**
 * GET /api/settings/feedback-settings
 * Get workspace-scoped public feedback page settings.
 */
router.get(
  '/feedback-settings',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await getFeedbackSettings(req.workspaceId);
    res.json({ success: true, data: settings });
  }),
);

/**
 * PUT /api/settings/feedback-settings
 * Update workspace-scoped public feedback page settings.
 */
router.put(
  '/feedback-settings',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const settings = await updateFeedbackSettings(
      req.workspaceId,
      req.body || {},
      requestActor(req),
    );
    res.json({ success: true, data: settings });
  }),
);

/**
 * GET /api/settings/feedback-submissions
 * List recent first-party feedback submissions (admin; review / test cleanup).
 */
router.get(
  '/feedback-submissions',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await listFeedbackSubmissions(req.workspaceId, { limit: req.query.limit });
    res.json({ success: true, data });
  }),
);

/**
 * DELETE /api/settings/feedback-submissions/:id
 * Permanently delete one feedback submission (admin).
 */
router.delete(
  '/feedback-submissions/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await deleteFeedbackSubmission(req.workspaceId, req.params.id);
    res.json({ success: true, data });
  }),
);

router.get(
  '/public-ticket-status/tickets',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const workspaceId = Number(req.workspaceId);
    if (!Number.isInteger(workspaceId) || workspaceId <= 0) {
      throw new ValidationError('Workspace selection required');
    }
    const search = String(req.query.search || '').trim();
    const page = Math.max(1, Number.parseInt(req.query.page || '1', 10) || 1);
    const pageSize = Math.min(25, Math.max(5, Number.parseInt(req.query.pageSize || '10', 10) || 10));
    const skip = (page - 1) * pageSize;
    const classification = String(req.query.classification || 'all');

    const where = { workspaceId };
    const and = [];
    if (search) {
      const or = [
        { subject: { contains: search, mode: 'insensitive' } },
        { status: { contains: search, mode: 'insensitive' } },
        { ticketCategory: { contains: search, mode: 'insensitive' } },
        { tpSkill: { contains: search, mode: 'insensitive' } },
        { tpSubskill: { contains: search, mode: 'insensitive' } },
        { internalCategory: { name: { contains: search, mode: 'insensitive' } } },
        { internalSubcategory: { name: { contains: search, mode: 'insensitive' } } },
        { requester: { name: { contains: search, mode: 'insensitive' } } },
        { assignedTech: { name: { contains: search, mode: 'insensitive' } } },
      ];
      if (/^\d+$/.test(search)) {
        or.push({ freshserviceTicketId: BigInt(search) });
      }
      and.push({ OR: or });
    }
    if (classification === 'classified') {
      and.push({
        OR: [
          { internalCategoryId: { not: null } },
          { internalSubcategoryId: { not: null } },
          { tpSkill: { not: null } },
          { tpSubskill: { not: null } },
        ],
      });
    } else if (classification === 'unclassified') {
      and.push({
        internalCategoryId: null,
        internalSubcategoryId: null,
        tpSkill: null,
        tpSubskill: null,
      });
    }
    if (and.length > 0) where.AND = and;

    const [workspace, total, rows] = await Promise.all([
      prisma.workspace.findUnique({
        where: { id: workspaceId },
        select: { id: true, name: true, slug: true },
      }),
      prisma.ticket.count({ where }),
      prisma.ticket.findMany({
        where,
        orderBy: [
          { freshserviceUpdatedAt: 'desc' },
          { updatedAt: 'desc' },
          { createdAt: 'desc' },
        ],
        skip,
        take: pageSize,
        select: {
          id: true,
          freshserviceTicketId: true,
          workspaceId: true,
          subject: true,
          status: true,
          priority: true,
          assessedPriority: true,
          ticketCategory: true,
          tpSkill: true,
          tpSubskill: true,
          internalCategoryId: true,
          internalSubcategoryId: true,
          createdAt: true,
          updatedAt: true,
          freshserviceUpdatedAt: true,
          requester: { select: { name: true } },
          assignedTech: { select: { name: true } },
          internalCategory: { select: { name: true } },
          internalSubcategory: { select: { name: true } },
          publicStatusLinks: {
            where: { workspaceId },
            orderBy: { updatedAt: 'desc' },
            take: 1,
            select: {
              id: true,
              token: true,
              enabled: true,
              expiresAt: true,
              revokedAt: true,
              viewCount: true,
              lastViewedAt: true,
            },
          },
        },
      }),
    ]);

    res.json({
      success: true,
      data: {
        workspace,
        tickets: rows.map(ticket => serializePublicStatusTicketRow(ticket, req.headers.origin)),
        page,
        pageSize,
        total,
        totalPages: Math.max(1, Math.ceil(total / pageSize)),
      },
    });
  }),
);

router.get(
  '/public-ticket-status/tickets/:ticketId/preview',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId, 'ticket id');
    const preview = await previewPublicTicketStatus(req.workspaceId, ticketId);
    res.json({ success: true, data: preview });
  }),
);

router.post(
  '/public-ticket-status/tickets/:ticketId/ensure-link',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId, 'ticket id');
    const result = await ensurePublicTicketStatusLink({
      workspaceId: req.workspaceId,
      ticketId,
      actor: requestActor(req),
      baseUrl: req.headers.origin,
    });
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/public-ticket-status/tickets/:ticketId/reset-link',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId, 'ticket id');
    const result = await resetPublicTicketStatusLink({
      workspaceId: req.workspaceId,
      ticketId,
      actor: requestActor(req),
      baseUrl: req.headers.origin,
    });
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/public-ticket-status/tickets/by-number/:freshserviceTicketId/reset-link',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const freshserviceTicketId = parsePositiveBigInt(req.params.freshserviceTicketId, 'ticket number');
    const ticketId = await ticketIdForFreshserviceNumber(req.workspaceId, freshserviceTicketId);
    const result = await resetPublicTicketStatusLink({
      workspaceId: req.workspaceId,
      ticketId,
      actor: requestActor(req),
      baseUrl: req.headers.origin,
    });
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/public-ticket-status/tickets/:ticketId/revoke-link',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const ticketId = parsePositiveId(req.params.ticketId, 'ticket id');
    const result = await revokePublicTicketStatusLink({
      workspaceId: req.workspaceId,
      ticketId,
      actor: requestActor(req),
    });
    res.json({ success: true, data: result });
  }),
);

router.post(
  '/public-ticket-status/tickets/by-number/:freshserviceTicketId/revoke-link',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const freshserviceTicketId = parsePositiveBigInt(req.params.freshserviceTicketId, 'ticket number');
    const ticketId = await ticketIdForFreshserviceNumber(req.workspaceId, freshserviceTicketId);
    const result = await revokePublicTicketStatusLink({
      workspaceId: req.workspaceId,
      ticketId,
      actor: requestActor(req),
    });
    res.json({ success: true, data: result });
  }),
);

router.get(
  '/urgent-escalation',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.getPolicyWithDependencies(req.workspaceId);
    res.json({ success: true, data });
  }),
);

router.put(
  '/urgent-escalation',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.updatePolicy(
      req.workspaceId,
      req.body || {},
      requestActor(req),
    );
    res.json({ success: true, data });
  }),
);

router.get(
  '/urgent-escalation/candidates',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const data = await urgentEscalationService.listCandidates(req.workspaceId);
    res.json({ success: true, data });
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
        variables: {
          priority: 'Test',
          ticketId: '000000',
          link: 'https://ticketpulse.local/settings',
        },
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
 * GET /api/settings/directory/search?q=<term>
 * Entra (GAL) typeahead for adding members. Returns matching directory users
 * with photos + a workspace-aware `alreadyMember` flag so the UI can skip
 * people already on this workspace's roster. Scoped to workspace admins.
 */
router.get(
  '/directory/search',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const q = (req.query.q || '').trim();
    if (q.length < 2) return res.json({ success: true, data: [] });
    if (!azureAdService.isConfigured()) {
      return res.status(400).json({ success: false, message: 'Directory (Entra) is not configured' });
    }
    const results = await azureAdService.searchUsers(q, 7);
    // Photos in parallel (best-effort — a missing photo just renders initials).
    const withPhotos = await Promise.all(
      results.map(async (u) => ({
        ...u,
        photoUrl: u.mail ? await azureAdService.getUserPhoto(u.mail).catch(() => null) : null,
      })),
    );
    // Workspace-aware: flag directory users already on this workspace's roster.
    const emails = withPhotos.map((u) => u.mail).filter(Boolean);
    const existing = emails.length
      ? await prisma.technician.findMany({
        where: { workspaceId: req.workspaceId, email: { in: emails } },
        select: { email: true, isActive: true },
      })
      : [];
    const byEmail = new Map(existing.map((e) => [(e.email || '').toLowerCase(), e]));
    res.json({
      success: true,
      data: withPhotos.map((u) => {
        const match = byEmail.get(u.mail);
        return {
          name: u.displayName,
          email: u.mail,
          jobTitle: u.jobTitle,
          department: u.department,
          photoUrl: u.photoUrl,
          alreadyMember: !!match,
          alreadyMemberActive: match ? match.isActive : false,
        };
      }),
    });
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
        origin: t.origin, // 'freshservice' | 'local'
        location: t.location,
        timezone: t.timezone,
      })),
    });
  }),
);

/**
 * POST /api/settings/technicians
 * Create a LOCAL (non-FreshService) agent — assignable to TP-born tickets only.
 * FreshService agents are managed by sync and cannot be created here.
 */
router.post(
  '/technicians',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, email, timezone, location, photoUrl } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    // Enrich from Entra (authoritative): photo + location, when we have an email
    // and the client didn't already pass them from the directory pick.
    let resolvedLocation = location?.trim() || null;
    let resolvedPhoto = photoUrl || null;
    if (email && azureAdService.isConfigured()) {
      const [profile, photo] = await Promise.all([
        azureAdService.getUserProfile(email).catch(() => null),
        resolvedPhoto ? Promise.resolve(null) : azureAdService.getUserPhoto(email).catch(() => null),
      ]);
      if (!resolvedLocation) resolvedLocation = profile?.officeLocation || profile?.city || null;
      if (!resolvedPhoto) resolvedPhoto = photo || null;
    }
    const tech = await technicianRepository.createLocalAgent({
      workspaceId: req.workspaceId,
      name: name.trim(),
      email: email?.trim() || null,
      timezone: timezone || undefined,
      location: resolvedLocation,
      photoUrl: resolvedPhoto,
    });
    clearReadCache();
    logger.info(`Local agent created: ${tech.name} (${tech.id}) in workspace ${req.workspaceId}`);
    res.status(201).json({ success: true, data: { id: tech.id, name: tech.name, email: tech.email, origin: tech.origin, isActive: tech.isActive, location: tech.location, photoUrl: tech.photoUrl, timezone: tech.timezone } });
  }),
);

/**
 * PATCH /api/settings/technicians/:id
 * Edit a LOCAL agent (name/email/timezone/location). FreshService agents are
 * read-only here (managed by sync).
 */
router.patch(
  '/technicians/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await technicianRepository.getById(id);
    if (!existing || existing.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Technician not found in this workspace' });
    }
    if (existing.origin !== 'local') {
      return res.status(400).json({ success: false, message: 'FreshService agents are managed by sync and cannot be edited here.' });
    }
    const { name, email, timezone, location, isActive } = req.body || {};
    const tech = await technicianRepository.update(id, {
      ...(name !== undefined ? { name: name.trim() } : {}),
      ...(email !== undefined ? { email: email?.trim()?.toLowerCase() || null } : {}),
      ...(timezone !== undefined ? { timezone } : {}),
      ...(location !== undefined ? { location: location?.trim() || null } : {}),
      ...(isActive !== undefined ? { isActive: !!isActive } : {}),
    });
    clearReadCache();
    res.json({ success: true, data: { id: tech.id, name: tech.name, email: tech.email, origin: tech.origin, isActive: tech.isActive } });
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
 * GET /api/settings/groups
 * All groups (FreshService + internal) for the current workspace, with member counts.
 */
router.get(
  '/groups',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const groups = await groupRepository.listForWorkspace(req.workspaceId);
    res.json({ success: true, data: groups });
  }),
);

/**
 * POST /api/settings/groups
 * Create an INTERNAL (TP-native) group. FreshService groups come from sync.
 */
router.post(
  '/groups',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, description } = req.body || {};
    if (!name || !name.trim()) {
      return res.status(400).json({ success: false, message: 'name is required' });
    }
    const group = await groupRepository.createInternal({
      workspaceId: req.workspaceId,
      name,
      description,
    });
    clearReadCache();
    logger.info(`Internal group created: ${group.name} (${group.id}) in workspace ${req.workspaceId}`);
    res.status(201).json({
      success: true,
      data: { id: group.id, name: group.name, origin: group.origin, isActive: group.isActive, memberCount: 0 },
    });
  }),
);

/**
 * PATCH /api/settings/groups/:id
 * Edit an internal group (name/description/isActive). FreshService groups are read-only here.
 */
router.patch(
  '/groups/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await groupRepository.getById(id);
    if (!existing || existing.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Group not found in this workspace' });
    }
    const { name, description, isActive } = req.body || {};
    const group = await groupRepository.updateInternal(id, { name, description, isActive });
    clearReadCache();
    res.json({ success: true, data: { id: group.id, name: group.name, origin: group.origin, isActive: group.isActive } });
  }),
);

/**
 * GET /api/settings/groups/:id/members
 * List the technicians in a group.
 */
router.get(
  '/groups/:id/members',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await groupRepository.getById(id);
    if (!existing || existing.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Group not found in this workspace' });
    }
    const members = await groupRepository.getMembers(id);
    res.json({ success: true, data: members });
  }),
);

/**
 * PUT /api/settings/groups/:id/members
 * Replace a group's membership with { technicianIds: [...] }. Internal groups only.
 */
router.put(
  '/groups/:id/members',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const existing = await groupRepository.getById(id);
    if (!existing || existing.workspaceId !== req.workspaceId) {
      return res.status(404).json({ success: false, message: 'Group not found in this workspace' });
    }
    const { technicianIds } = req.body || {};
    if (!Array.isArray(technicianIds)) {
      return res.status(400).json({ success: false, message: 'technicianIds array is required' });
    }
    const count = await groupRepository.setMembers(id, technicianIds, req.workspaceId);
    clearReadCache();
    const members = await groupRepository.getMembers(id);
    res.json({ success: true, data: { memberCount: count, members } });
  }),
);

// ------------------------------------------------------ approval categories
// Per-workspace approval categories + their approval managers. TP-only.

router.get(
  '/approval-categories',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const categories = await approvalCategoryService.list(req.workspaceId);
    res.json({ success: true, data: categories });
  }),
);

router.post(
  '/approval-categories',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { name, description, managerEmails, sortOrder } = req.body || {};
    const category = await approvalCategoryService.create(req.workspaceId, { name, description, managerEmails, sortOrder });
    logger.info(`Approval category created: ${category.name} (${category.id}) in workspace ${req.workspaceId}`);
    res.status(201).json({ success: true, data: category });
  }),
);

router.patch(
  '/approval-categories/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const category = await approvalCategoryService.update(id, req.workspaceId, req.body || {});
    res.json({ success: true, data: category });
  }),
);

router.delete(
  '/approval-categories/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const id = parseInt(req.params.id, 10);
    const result = await approvalCategoryService.remove(id, req.workspaceId);
    res.json({ success: true, data: result });
  }),
);

// --------------------------------------------------- ticket ops (enterprise)
// SLA policies (TP-born due-date clocks), macros (quick-action bundles) and
// custom field definitions. Admin-only, per-workspace.

router.get(
  '/sla-policies',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: slaPolicyService } = await import('../services/slaPolicyService.js');
    res.json({ success: true, data: await slaPolicyService.list(req.workspaceId) });
  }),
);

router.put(
  '/sla-policies',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: slaPolicyService } = await import('../services/slaPolicyService.js');
    const policy = await slaPolicyService.upsert(req.workspaceId, req.body || {}, req.session?.user || null);
    res.json({ success: true, data: policy });
  }),
);

router.delete(
  '/sla-policies/:priority',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: slaPolicyService } = await import('../services/slaPolicyService.js');
    res.json({ success: true, data: await slaPolicyService.remove(req.workspaceId, req.params.priority) });
  }),
);

router.get(
  '/macros',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
    res.json({ success: true, data: await ticketMacroService.list(req.workspaceId, { includeInactive: true }) });
  }),
);

router.post(
  '/macros',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
    const macro = await ticketMacroService.create(req.workspaceId, req.body || {}, req.session?.user || null);
    res.status(201).json({ success: true, data: macro });
  }),
);

router.patch(
  '/macros/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
    const macro = await ticketMacroService.update(req.workspaceId, req.params.id, req.body || {}, req.session?.user || null);
    res.json({ success: true, data: macro });
  }),
);

router.delete(
  '/macros/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
    res.json({ success: true, data: await ticketMacroService.remove(req.workspaceId, req.params.id) });
  }),
);

router.get(
  '/custom-fields',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: customFieldService } = await import('../services/customFieldService.js');
    res.json({ success: true, data: await customFieldService.listDefinitions(req.workspaceId, { includeInactive: true }) });
  }),
);

router.post(
  '/custom-fields',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: customFieldService } = await import('../services/customFieldService.js');
    const definition = await customFieldService.createDefinition(req.workspaceId, req.body || {});
    res.status(201).json({ success: true, data: definition });
  }),
);

router.patch(
  '/custom-fields/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: customFieldService } = await import('../services/customFieldService.js');
    const definition = await customFieldService.updateDefinition(req.workspaceId, req.params.id, req.body || {});
    res.json({ success: true, data: definition });
  }),
);

router.delete(
  '/custom-fields/:id',
  requireWorkspace,
  requireWorkspaceAccess,
  requireAdmin,
  asyncHandler(async (req, res) => {
    const { default: customFieldService } = await import('../services/customFieldService.js');
    res.json({ success: true, data: await customFieldService.removeDefinition(req.workspaceId, req.params.id) });
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
