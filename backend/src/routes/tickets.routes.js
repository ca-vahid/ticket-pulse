import express from 'express';
import multer from 'multer';
import { asyncHandler } from '../middleware/errorHandler.js';
import { requireWorkspace } from '../middleware/workspace.js';
import { AppError, AuthenticationError, AuthorizationError, ValidationError } from '../utils/errors.js';
import ticketService from '../services/ticketService.js';
import scheduledTicketService from '../services/scheduledTicketService.js';
import attachmentService, { MAX_ATTACHMENT_BYTES } from '../services/attachmentService.js';
import workspaceRepository from '../services/workspaceRepository.js';
import { heartbeatPresence, leavePresence, presenceSnapshot } from '../services/presenceService.js';
import prisma from '../services/prisma.js';
import logger from '../utils/logger.js';

const attachmentUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_ATTACHMENT_BYTES, files: 5 },
});

/**
 * Native ticketing API.
 *
 * Mounted BEFORE the global requireWorkspaceAccess chain (see routes/index.js)
 * because agents — who have no workspace_access rows — are first-class users
 * here: an active technician profile in the workspace grants access.
 */
const router = express.Router();

router.use(requireWorkspace);

async function resolveTicketActor(req, _res, next) {
  try {
    const user = (req.session?.user ?? req.user);
    const email = user?.email?.toLowerCase();
    if (!email) throw new AuthenticationError('Authentication required');

    const [workspaceRole, technician] = await Promise.all([
      user.role === 'admin'
        ? Promise.resolve('admin')
        : workspaceRepository.getAccessRole(email, req.workspaceId),
      prisma.technician.findFirst({
        where: {
          workspaceId: req.workspaceId,
          isActive: true,
          email: { equals: email, mode: 'insensitive' },
        },
        select: { id: true, name: true },
      }),
    ]);

    if (!workspaceRole && !technician) {
      logger.warn(`Ticketing access denied for ${email} in workspace ${req.workspaceId}`);
      // 403, not 401: authenticated-but-not-a-member must never trip the
      // frontend's credential recovery/sign-out loop (Phase A1).
      throw new AuthorizationError('You do not have access to tickets in this workspace', 'workspace_access_denied');
    }

    req.ticketActor = {
      email,
      name: user.name || technician?.name || email,
      role: user.role,
      workspaceRole: workspaceRole || null,
      technicianId: technician?.id || null,
      kind: user.role === 'admin' ? 'admin' : (workspaceRole ? 'member' : 'agent'),
    };
    next();
  } catch (err) {
    next(err);
  }
}

router.use(resolveTicketActor);

/** Gate for mutations: the workspace must have native ticketing switched on. */
const requireNativeTicketing = asyncHandler(async (req, _res, next) => {
  const workspace = await prisma.workspace.findUnique({
    where: { id: req.workspaceId },
    select: { nativeTicketingEnabled: true },
  });
  if (!workspace?.nativeTicketingEnabled) {
    throw new ValidationError('Native ticketing is not enabled for this workspace');
  }
  next();
});

function parseTicketId(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) throw new ValidationError('Invalid ticket id');
  return id;
}

// ------------------------------------------- autofill intake (Phase AF)
//
// POST /autofill-extract — multimodal "Autofill": the agent pastes a dump
// (Teams chat, email text, screenshots) and the model PROPOSES ticket fields.
// Declared before any `/:id` route so it is never shadowed. Any workspace
// member/agent may call it (intake is the agents' job) — NOT admin-gated —
// but the workspace must have native ticketing on. Own multer instance: the
// attachment uploader above allows 100 MB files, far too generous for a
// request that is forwarded to a paid vision model. Caps are duplicated in
// ticketIntakeExtractService (which is imported lazily, like summarize).
const AUTOFILL_MAX_TEXT_CHARS = 20000;
const AUTOFILL_MAX_IMAGES = 6;
const AUTOFILL_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const AUTOFILL_MAX_TOTAL_IMAGE_BYTES = 20 * 1024 * 1024;
const AUTOFILL_IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp']);
const AUTOFILL_RATE = Object.freeze({ perMinute: 10, perHour: 60 });

const autofillUpload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: AUTOFILL_MAX_IMAGE_BYTES,
    files: AUTOFILL_MAX_IMAGES,
    fields: 5,
    fieldSize: 256 * 1024,
  },
  fileFilter(_req, file, cb) {
    const type = String(file.mimetype || '').toLowerCase();
    if (!type.startsWith('image/') || !AUTOFILL_IMAGE_TYPES.has(type)) {
      cb(new ValidationError(`Only JPEG, PNG, GIF or WebP images are accepted (got ${type || 'unknown'})`));
      return;
    }
    cb(null, true);
  },
});

/** multer errors carry no statusCode (→ 500); translate them into 400s. */
function autofillUploadMiddleware(req, res, next) {
  autofillUpload.array('images', AUTOFILL_MAX_IMAGES)(req, res, (err) => {
    if (!err) return next();
    if (err instanceof multer.MulterError) {
      const messages = {
        LIMIT_FILE_SIZE: 'Each image must be 5 MB or smaller',
        LIMIT_FILE_COUNT: `Up to ${AUTOFILL_MAX_IMAGES} images per request`,
        LIMIT_UNEXPECTED_FILE: `Up to ${AUTOFILL_MAX_IMAGES} images per request, sent as the "images" field`,
        LIMIT_FIELD_VALUE: `Pasted text is limited to ${AUTOFILL_MAX_TEXT_CHARS.toLocaleString()} characters`,
        LIMIT_FIELD_COUNT: 'Too many form fields',
      };
      return next(new ValidationError(messages[err.code] || `Upload rejected: ${err.message}`));
    }
    return next(err);
  });
}

class AutofillRateLimitError extends AppError {
  constructor(message, retryAfterSec) {
    super(message, 429);
    this.code = 'rate_limited';
    this.retryAfterSec = retryAfterSec;
  }
}

// Per-actor sliding windows (in-memory; per instance). This is the one
// endpoint where a client loop burns dollars, so it is limited independently
// of any global limiter. Bounded: idle actors are pruned on each pass.
const autofillHits = new Map(); // actorKey -> number[] (timestamps, ascending)
const AUTOFILL_MAX_TRACKED_ACTORS = 5000;

function autofillRateLimit(req, res, next) {
  const now = Date.now();
  const key = String(req.ticketActor?.email || req.ip || 'anonymous').toLowerCase();
  const hourAgo = now - 60 * 60 * 1000;
  const minuteAgo = now - 60 * 1000;

  if (autofillHits.size >= AUTOFILL_MAX_TRACKED_ACTORS && !autofillHits.has(key)) {
    for (const [actor, stamps] of autofillHits) {
      if (!stamps.length || stamps[stamps.length - 1] < hourAgo) autofillHits.delete(actor);
    }
  }

  const stamps = (autofillHits.get(key) || []).filter((t) => t > hourAgo);
  const lastMinute = stamps.filter((t) => t > minuteAgo);

  let retryAfterSec = 0;
  if (lastMinute.length >= AUTOFILL_RATE.perMinute) {
    retryAfterSec = Math.max(1, Math.ceil((lastMinute[0] + 60 * 1000 - now) / 1000));
  } else if (stamps.length >= AUTOFILL_RATE.perHour) {
    retryAfterSec = Math.max(1, Math.ceil((stamps[0] + 60 * 60 * 1000 - now) / 1000));
  }

  if (retryAfterSec > 0) {
    autofillHits.set(key, stamps);
    res.set('Retry-After', String(retryAfterSec));
    return next(new AutofillRateLimitError(
      `Autofill is limited to ${AUTOFILL_RATE.perMinute} requests per minute and ${AUTOFILL_RATE.perHour} per hour — try again in ${retryAfterSec}s`,
      retryAfterSec,
    ));
  }

  stamps.push(now);
  autofillHits.set(key, stamps);
  return next();
}

/** Test hook: clear the per-actor windows between cases. */
export function __resetAutofillRateLimitForTests() {
  autofillHits.clear();
}

router.post(
  '/autofill-extract',
  requireNativeTicketing,
  autofillRateLimit,
  autofillUploadMiddleware,
  asyncHandler(async (req, res) => {
    const rawText = req.body?.text;
    const text = typeof rawText === 'string'
      ? rawText
      : (rawText === null || rawText === undefined ? '' : String(rawText));
    if (text.length > AUTOFILL_MAX_TEXT_CHARS) {
      throw new ValidationError(`Pasted text is limited to ${AUTOFILL_MAX_TEXT_CHARS.toLocaleString()} characters`);
    }
    const files = req.files || [];
    const totalBytes = files.reduce((sum, file) => sum + (file.size || file.buffer?.length || 0), 0);
    if (totalBytes > AUTOFILL_MAX_TOTAL_IMAGE_BYTES) {
      throw new ValidationError('Images total more than 20 MB — remove or downscale some');
    }
    if (!text.trim() && files.length === 0) {
      throw new ValidationError('Paste some text or add at least one image');
    }

    const images = files.map((file) => ({
      mimeType: file.mimetype,
      buffer: file.buffer,
      fileName: file.originalname,
    }));
    const { default: ticketIntakeExtractService } = await import('../services/ticketIntakeExtractService.js');
    const result = await ticketIntakeExtractService.extract({
      workspaceId: req.workspaceId,
      text,
      images,
      actorEmail: req.ticketActor?.email || null,
      actorTechnicianId: req.ticketActor?.technicianId || null,
    });
    // AF2: persist what the model returned (never the images). The id comes
    // back as meta.runId so the create form can link the run to the ticket it
    // produces (POST / with intakeRunId).
    const { default: ticketIntakeRunService } = await import('../services/ticketIntakeRunService.js');
    const runId = await ticketIntakeRunService.record({
      workspaceId: req.workspaceId,
      actor: req.ticketActor,
      text,
      images,
      data: result.data,
      meta: result.meta,
    });
    res.json({ success: true, data: result.data, meta: { ...result.meta, runId } });
  }),
);

// GET /intake-runs?limit=50 — recent Autofill runs for the workspace
// (Settings → AI Usage). Admin-gated: runs carry pasted-text previews and the
// model's proposal for anyone's request. Declared before `/:id`.
router.get('/intake-runs', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: ticketIntakeRunService } = await import('../services/ticketIntakeRunService.js');
  const runs = await ticketIntakeRunService.listRecent(req.workspaceId, req.query.limit);
  res.json({ success: true, data: runs });
}));

// ------------------------------------------------------------------- reads

router.get('/', asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(req.workspaceId, req.query);
  res.json({ success: true, data: result });
}));

router.get('/meta', asyncHandler(async (req, res) => {
  const meta = await ticketService.getMeta(req.workspaceId);
  res.json({ success: true, data: { ...meta, actor: req.ticketActor } });
}));

router.get('/stats', asyncHandler(async (req, res) => {
  const stats = await ticketService.getQueueStats(req.workspaceId);
  res.json({ success: true, data: stats });
}));

// Admin-chosen quick filter cards (Mega 08-23 Phase FC). Reads ride
// meta.queueCards; this PUT is the only write. Validation (exactly 6 known
// unique keys) lives in queueCardConfigService; the admin gate is the same
// requireTicketingAdmin the sibling ticket-ops routes use (declared below —
// function declarations hoist).
router.put('/queue-cards', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: queueCardConfigService } = await import('../services/queueCardConfigService.js');
  const cards = await queueCardConfigService.setCards(req.workspaceId, req.body?.cards, req.ticketActor.email);
  res.json({ success: true, data: { cards } });
}));

// ----------------------------------------------- saved filter views (per-user)

function actorIsAdmin(actor) {
  return actor?.role === 'admin' || actor?.workspaceRole === 'admin';
}

/** List the current user's own views + workspace-shared views. */
router.get('/saved-views', asyncHandler(async (req, res) => {
  const email = req.ticketActor.email;
  const views = await prisma.savedFilterView.findMany({
    where: { workspaceId: req.workspaceId, OR: [{ ownerEmail: email }, { shared: true }] },
    orderBy: [{ shared: 'asc' }, { name: 'asc' }],
  });
  res.json({
    success: true,
    data: views.map((v) => ({
      id: v.id, name: v.name, params: v.params, shared: v.shared,
      mine: v.ownerEmail === email, ownerEmail: v.ownerEmail,
    })),
  });
}));

router.post('/saved-views', asyncHandler(async (req, res) => {
  const email = req.ticketActor.email;
  const { name, params, shared } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ success: false, message: 'name is required' });
  if (params === null || params === undefined || typeof params !== 'object') return res.status(400).json({ success: false, message: 'params object is required' });
  const wantShared = shared === true && actorIsAdmin(req.ticketActor);
  const view = await prisma.savedFilterView.create({
    data: { workspaceId: req.workspaceId, ownerEmail: email, name: String(name).trim().slice(0, 160), params, shared: wantShared },
  });
  res.status(201).json({ success: true, data: { id: view.id, name: view.name, params: view.params, shared: view.shared, mine: true } });
}));

router.patch('/saved-views/:id', asyncHandler(async (req, res) => {
  const email = req.ticketActor.email;
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.savedFilterView.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) return res.status(404).json({ success: false, message: 'View not found' });
  const isOwner = existing.ownerEmail === email;
  const admin = actorIsAdmin(req.ticketActor);
  if (!isOwner && !admin) return res.status(403).json({ success: false, message: 'You can only edit your own views' });
  const data = {};
  if (req.body?.name !== undefined && isOwner) data.name = String(req.body.name).trim().slice(0, 160);
  if (req.body?.params !== undefined && isOwner) data.params = req.body.params;
  // Sharing is an admin-only action (owner or admin editing, but flag needs admin).
  if (req.body?.shared !== undefined) {
    if (!admin) return res.status(403).json({ success: false, message: 'Only admins can share views to the workspace' });
    data.shared = req.body.shared === true;
  }
  const view = await prisma.savedFilterView.update({ where: { id }, data });
  res.json({ success: true, data: { id: view.id, name: view.name, params: view.params, shared: view.shared, mine: view.ownerEmail === email } });
}));

router.delete('/saved-views/:id', asyncHandler(async (req, res) => {
  const email = req.ticketActor.email;
  const id = parseInt(req.params.id, 10);
  const existing = await prisma.savedFilterView.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) return res.status(404).json({ success: false, message: 'View not found' });
  if (existing.ownerEmail !== email && !actorIsAdmin(req.ticketActor)) {
    return res.status(403).json({ success: false, message: 'You can only delete your own views' });
  }
  await prisma.savedFilterView.delete({ where: { id } });
  res.json({ success: true });
}));

// -------------------------------------------- per-user UI preferences (QC1)
// Tiny JSON values keyed by (workspace, actor email, key) — queue column
// layout and friends. Keys are a hard allowlist (unknown key → 404, same
// posture as an unknown route) and values are size-capped: this is a
// preference store, not a document store.

const PREFERENCE_KEYS = new Set(['queue.columns', 'queue.columnWidths', 'ui.theme']);
// Closed-vocabulary keys get a value validator (Phase DM-A: 'ui.theme' is one
// of three strings — the cross-device seed for the theme choice).
const PREFERENCE_VALIDATORS = { 'ui.theme': (v) => ['system', 'light', 'dark'].includes(v) };
const PREFERENCE_VALUE_MAX_BYTES = 8 * 1024;

function parsePreferenceKey(req) {
  const key = String(req.params.key || '');
  return PREFERENCE_KEYS.has(key) ? key : null;
}

router.get('/preferences/:key', asyncHandler(async (req, res) => {
  const key = parsePreferenceKey(req);
  if (!key) return res.status(404).json({ success: false, message: 'Unknown preference key' });
  const row = await prisma.userPreference.findUnique({
    where: { workspaceId_ownerEmail_key: { workspaceId: req.workspaceId, ownerEmail: req.ticketActor.email, key } },
  });
  // No row = "never customized" — the client falls back to its defaults.
  res.json({ success: true, data: { key, value: row ? row.value : null } });
}));

router.put('/preferences/:key', asyncHandler(async (req, res) => {
  const key = parsePreferenceKey(req);
  if (!key) return res.status(404).json({ success: false, message: 'Unknown preference key' });
  const value = req.body?.value;
  // null is rejected too: the column is a required Json (a "cleared" pref is
  // simply the row never written — GET then returns value:null for defaults).
  if (value === undefined || value === null) return res.status(400).json({ success: false, message: 'value is required' });
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(value), 'utf8');
  } catch {
    return res.status(400).json({ success: false, message: 'value must be JSON-serializable' });
  }
  if (!Number.isFinite(bytes) || bytes > PREFERENCE_VALUE_MAX_BYTES) {
    return res.status(400).json({ success: false, message: `value too large (max ${PREFERENCE_VALUE_MAX_BYTES} bytes)` });
  }
  if (PREFERENCE_VALIDATORS[key] && !PREFERENCE_VALIDATORS[key](value)) {
    return res.status(400).json({ success: false, message: `value not allowed for ${key}` });
  }
  const where = { workspaceId_ownerEmail_key: { workspaceId: req.workspaceId, ownerEmail: req.ticketActor.email, key } };
  const row = await prisma.userPreference.upsert({
    where,
    update: { value },
    create: { workspaceId: req.workspaceId, ownerEmail: req.ticketActor.email, key, value },
  });
  res.json({ success: true, data: { key, value: row.value } });
}));

// Requester typeahead for the create flow: known requesters + Entra directory.
router.get('/requester-search', asyncHandler(async (req, res) => {
  const results = await ticketService.searchRequesters(String(req.query.q || ''));
  res.json({ success: true, data: results });
}));

// Compact requester history (counts) for the peek/detail requester cards.
router.get('/requester-stats', asyncHandler(async (req, res) => {
  const stats = await ticketService.requesterStats(req.query.requesterId, req.workspaceId);
  res.json({ success: true, data: stats });
}));

// Requester profile photo from Entra — cache + decoder live in userPhotoService (shared with the
// public approval page's photo route and the approval e-mails' inline avatars); re-exported here
// for existing importers.
import { getCachedUserPhoto, decodePhotoDataUri } from '../services/userPhotoService.js';

export { getCachedUserPhoto, decodePhotoDataUri };

router.get('/requester-photo', asyncHandler(async (req, res) => {
  const photo = await getCachedUserPhoto(req.query.email);
  res.json({ success: true, data: { photo } });
}));

// ------------------------------------------------------ scheduled tickets

router.get('/scheduled', asyncHandler(async (req, res) => {
  const [pending, recent] = await Promise.all([
    scheduledTicketService.list(req.workspaceId),
    scheduledTicketService.recentlyActivated(req.workspaceId),
  ]);
  res.json({ success: true, data: { pending, recent } });
}));

router.post('/scheduled', requireNativeTicketing, asyncHandler(async (req, res) => {
  const row = await scheduledTicketService.schedule(
    req.workspaceId,
    {
      payload: req.body?.payload || {},
      scheduledForAt: req.body?.scheduledForAt,
      recurrence: req.body?.recurrence || 'none',
      endAt: req.body?.endAt || null,
    },
    req.ticketActor,
  );
  res.status(201).json({ success: true, data: row });
}));

router.post('/scheduled/:sid/activate', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await scheduledTicketService.activate(Number(req.params.sid), req.workspaceId, req.ticketActor);
  res.json({ success: true, data: result });
}));

router.delete('/scheduled/:sid', requireNativeTicketing, asyncHandler(async (req, res) => {
  const row = await scheduledTicketService.cancel(Number(req.params.sid), req.workspaceId, req.ticketActor);
  res.json({ success: true, data: row });
}));

// Staged attachments on a schedule (gap plan 2 P2): adopted at activation.
router.get('/scheduled/:sid/attachments', requireNativeTicketing, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await attachmentService.listStaged(Number(req.params.sid), req.workspaceId) });
}));

router.post(
  '/scheduled/:sid/attachments',
  requireNativeTicketing,
  attachmentUpload.array('files', 5),
  asyncHandler(async (req, res) => {
    const sid = Number(req.params.sid);
    const row = await prisma.scheduledTicket.findFirst({ where: { id: sid, workspaceId: req.workspaceId } });
    if (!row) throw new ValidationError('Scheduled ticket not found in this workspace');
    if (!['pending', 'error'].includes(row.status)) throw new ValidationError(`This scheduled ticket is already ${row.status}`);
    const files = req.files || [];
    if (files.length === 0) throw new ValidationError('No files were uploaded');
    const stored = [];
    for (const file of files) {
      stored.push(await attachmentService.stageForSchedule({
        workspaceId: req.workspaceId,
        scheduledTicketId: sid,
        fileName: file.originalname,
        contentType: file.mimetype,
        buffer: file.buffer,
        uploadedBy: req.ticketActor.email,
      }));
    }
    res.status(201).json({ success: true, data: stored });
  }),
);

router.delete('/scheduled/:sid/attachments/:attachmentId', requireNativeTicketing, asyncHandler(async (req, res) => {
  res.json({
    success: true,
    data: await attachmentService.removeStaged(Number(req.params.attachmentId), Number(req.params.sid), req.workspaceId),
  });
}));

router.get('/export.csv', asyncHandler(async (req, res) => {
  const result = await ticketService.listTickets(
    req.workspaceId,
    { ...req.query, page: 1, pageSize: 5000 },
    { maxPageSize: 5000 },
  );
  // Custom-field columns (Custom Fields Activation Phase 2): one column per
  // ACTIVE definition, capped at 10 by sortOrder (listDefinitions' order),
  // header = the definition label. Appended whenever the workspace has any
  // definitions — unconditional is simpler and more predictable for people
  // diffing exports than appearing only when a cf_* filter is active.
  const { default: customFieldService } = await import('../services/customFieldService.js');
  const cfDefs = (await customFieldService.listDefinitions(req.workspaceId)).slice(0, 10);
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  // "SLA State" = the clock-side stateChip (overdue/response_due/…) that this
  // column has always carried; "State" (Phase QX, QA 08-27 #3) = the queue's
  // FS-style "who acts next" state — appended so existing column positions
  // keep working for anyone diffing exports (custom fields still trail).
  const header = ['Ref', 'Subject', 'Status', 'Priority', 'Type', 'SLA State', 'Requester', 'Requester Email', 'Assignee', 'Category', 'Subcategory', 'Tags', 'Origin', 'Created', 'Last Activity', 'State', ...cfDefs.map((d) => d.label)];
  const lines = [header.join(',')];
  for (const t of result.items) {
    lines.push([
      esc(t.displayRef), esc(t.subject), esc(t.status), esc(t.priority), esc(t.ticketType),
      esc(t.stateChip), esc(t.requester?.name), esc(t.requester?.email), esc(t.assignedTech?.name),
      // TP taxonomy first (canonical → tp custom fields), legacy single box last
      esc(t.internalCategory?.name || t.tpSkill || t.ticketCategory), esc(t.internalSubcategory?.name || t.tpSubskill),
      esc((t.tags || []).map((tag) => tag.name).join('; ')),
      esc(t.origin), esc(t.createdAt?.toISOString?.() || t.createdAt),
      esc(t.lastActivityAt?.toISOString?.() || t.lastActivityAt),
      esc(t.state),
      // Values stringified as stored (booleans → true/false, dates → ISO).
      ...cfDefs.map((d) => esc(t.customFields?.[d.key])),
    ].join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="tickets-export-${new Date().toISOString().slice(0, 10)}.csv"`);
  res.send(`${lines.join('\n')}\n`);
}));

// ------------------------------------------------- mailbox connections (admin)

function requireTicketingAdmin(req, _res, next) {
  const actor = req.ticketActor;
  if (actor.role !== 'admin' && actor.workspaceRole !== 'admin') {
    return next(new AuthenticationError('Admin access required'));
  }
  next();
}

/**
 * API shape for a MailboxConnection row (MB-2e): strips the webhook secret
 * (clientState) and the delta cursor, adds the instant-ingest summary the
 * Ticket Mailboxes panel renders — `instantIngest` is true only while the
 * Graph subscription is active and unexpired; otherwise the poller is the
 * lane and `pollIntervalSec` is the cadence.
 */
function presentMailbox(mb) {
  if (!mb) return mb;
  const rest = { ...mb };
  delete rest.clientState;
  delete rest.deltaLink;
  const expires = mb.subscriptionExpiresAt ? new Date(mb.subscriptionExpiresAt).getTime() : 0;
  const ingestCapable = mb.isEnabled && ['ingest', 'both'].includes(mb.mode);
  return {
    ...rest,
    instantIngest: Boolean(ingestCapable && mb.subscriptionId && mb.notificationStatus === 'active' && expires > Date.now()),
    hasDeltaCursor: Boolean(mb.deltaLink),
  };
}

/**
 * Outbound Graph lane state for the workspace (Phase RL, RL-2): the most
 * recent msgraph send-health event decides whether the send lane is granted.
 * `permission_denied` (403 on createReply / sendMail) means every send is
 * silently falling back to SendGrid as ticketpulse@ — the panel shows that
 * in red with the exact grant text. Null when Graph has never been tried.
 */
async function graphSendLane(workspaceId) {
  try {
    const { default: emailHealthService } = await import('../services/emailHealthService.js');
    return await emailHealthService.getGraphSendLane(workspaceId);
  } catch (err) {
    logger.debug(`graphSendLane lookup failed (non-fatal): ${err.message}`);
    return null;
  }
}

router.get('/mailboxes', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const [mailboxes, sendLane] = await Promise.all([
    prisma.mailboxConnection.findMany({
      where: { workspaceId: req.workspaceId },
      orderBy: { id: 'asc' },
    }),
    graphSendLane(req.workspaceId),
  ]);
  res.json({ success: true, data: mailboxes.map(presentMailbox), meta: { sendLane } });
}));

// ---------------------------------------------------------------- hold queue
// Phase RL (RL-4): inbound mail the ingest decision table parked for a human.
// Staff-gated (admins AND agents resolve held replies from the Tickets queue
// pill); mutations re-run the ordinary ingest paths.

function requireTicketingStaff(req, _res, next) {
  const actor = req.ticketActor;
  if (actor.role === 'admin' || actor.workspaceRole === 'admin' || actor.technicianId) return next();
  return next(new AuthenticationError('Agent or admin access required'));
}

router.get('/mailboxes/held', requireTicketingStaff, asyncHandler(async (req, res) => {
  const { default: mailboxHoldService } = await import('../services/mailboxHoldService.js');
  const status = String(req.query?.status || 'held');
  const rows = await mailboxHoldService.list(req.workspaceId, { status });
  const heldCount = status === 'held' ? rows.length : await mailboxHoldService.count(req.workspaceId, 'held');
  res.json({ success: true, data: rows, meta: { heldCount } });
}));

router.post('/mailboxes/held/:heldId/attach', requireTicketingStaff, asyncHandler(async (req, res) => {
  const ticketId = Number(req.body?.ticketId);
  if (!Number.isInteger(ticketId) || ticketId <= 0) throw new ValidationError('ticketId is required');
  const { default: mailboxHoldService } = await import('../services/mailboxHoldService.js');
  const result = await mailboxHoldService.attach(Number(req.params.heldId), ticketId, req.ticketActor, { workspaceId: req.workspaceId });
  res.json({ success: true, data: result });
}));

router.post('/mailboxes/held/:heldId/create', requireTicketingStaff, asyncHandler(async (req, res) => {
  const { default: mailboxHoldService } = await import('../services/mailboxHoldService.js');
  const result = await mailboxHoldService.createTicket(Number(req.params.heldId), {
    requesterEmail: req.body?.requesterEmail || null,
    actor: req.ticketActor,
    workspaceId: req.workspaceId,
  });
  res.status(201).json({ success: true, data: result });
}));

router.post('/mailboxes/held/:heldId/discard', requireTicketingStaff, asyncHandler(async (req, res) => {
  const { default: mailboxHoldService } = await import('../services/mailboxHoldService.js');
  const held = await mailboxHoldService.discard(Number(req.params.heldId), req.ticketActor, { workspaceId: req.workspaceId });
  res.json({ success: true, data: held });
}));

/** Validates the optional mailbox→group/type routing fields (T3.1). */
async function resolveMailboxRouting(req) {
  const out = {};
  if (req.body?.defaultGroupId !== undefined) {
    const raw = req.body.defaultGroupId;
    if (raw === null || raw === '') {
      out.defaultGroupId = null;
    } else {
      if (!/^\d+$/.test(String(raw))) throw new ValidationError('defaultGroupId must be a group id');
      const groupFsId = BigInt(String(raw));
      const group = await prisma.group.findFirst({
        where: { workspaceId: req.workspaceId, freshserviceId: groupFsId, isActive: true },
      });
      if (!group) throw new ValidationError('Group not found in this workspace');
      out.defaultGroupId = groupFsId;
    }
  }
  if (req.body?.defaultInternalGroupId !== undefined) {
    const raw = req.body.defaultInternalGroupId;
    if (raw === null || raw === '') {
      out.defaultInternalGroupId = null;
    } else {
      const id = parseInt(raw, 10);
      if (!Number.isInteger(id)) throw new ValidationError('defaultInternalGroupId must be a group id');
      const group = await prisma.group.findFirst({
        where: { id, workspaceId: req.workspaceId, origin: 'local', isActive: true },
      });
      if (!group) throw new ValidationError('Internal group not found in this workspace');
      out.defaultInternalGroupId = id;
    }
  }
  if (req.body?.defaultTicketType !== undefined) {
    const type = req.body.defaultTicketType;
    if (type === null || type === '') out.defaultTicketType = null;
    else {
      // Validated against the workspace's ticket-type registry (normalizes
      // aliases/case to the canonical name; throws with the valid list).
      const { default: ticketTypeService } = await import('../services/ticketTypeService.js');
      out.defaultTicketType = await ticketTypeService.normalizeTypeName(req.workspaceId, type);
    }
  }
  return out;
}

router.post('/mailboxes', requireTicketingAdmin, requireNativeTicketing, asyncHandler(async (req, res) => {
  const address = String(req.body?.address || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) throw new ValidationError('A valid mailbox address is required');
  const mode = ['ingest', 'send', 'both'].includes(req.body?.mode) ? req.body.mode : 'both';
  const routing = await resolveMailboxRouting(req);
  const wantsPrimary = req.body?.isPrimary === true;
  let mailbox = await prisma.mailboxConnection.create({
    data: {
      workspaceId: req.workspaceId,
      address,
      displayName: req.body?.displayName?.trim() || null,
      mode,
      pollIntervalSec: Math.max(15, Math.min(3600, Number(req.body?.pollIntervalSec) || 60)),
      createdBy: req.ticketActor.email,
      ...routing,
    },
  }).catch((err) => {
    if (err.code === 'P2002') throw new ValidationError('That mailbox is already connected to this workspace');
    throw err;
  });
  if (wantsPrimary) {
    // "Set primary" semantics (MB-1g): exactly one primary per workspace —
    // the transaction clears the previous one.
    const { setPrimaryMailbox } = await import('../services/mailboxPicker.js');
    mailbox = await setPrimaryMailbox(req.workspaceId, mailbox.id, true);
  }
  res.status(201).json({ success: true, data: presentMailbox(mailbox) });
}));

router.patch('/mailboxes/:mailboxId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  const data = await resolveMailboxRouting(req);
  if (req.body?.mode && ['ingest', 'send', 'both'].includes(req.body.mode)) data.mode = req.body.mode;
  if (req.body?.isEnabled !== undefined) data.isEnabled = req.body.isEnabled === true;
  if (req.body?.displayName !== undefined) data.displayName = req.body.displayName?.trim() || null;
  if (req.body?.pollIntervalSec !== undefined) data.pollIntervalSec = Math.max(15, Math.min(3600, Number(req.body.pollIntervalSec) || 60));
  // Phase RL (RL-4): per-mailbox safety switch + agent Cc intake toggle.
  if (req.body?.newTicketPolicy !== undefined) {
    const { NEW_TICKET_POLICIES } = await import('../services/mailboxHoldService.js');
    if (!NEW_TICKET_POLICIES.includes(req.body.newTicketPolicy)) {
      throw new ValidationError(`newTicketPolicy must be one of ${NEW_TICKET_POLICIES.join(', ')}`);
    }
    data.newTicketPolicy = req.body.newTicketPolicy;
  }
  if (req.body?.agentCcIntake !== undefined) data.agentCcIntake = req.body.agentCcIntake === true;
  let mailbox = Object.keys(data).length > 0
    ? await prisma.mailboxConnection.update({ where: { id }, data })
    : existing;
  if (req.body?.isPrimary !== undefined) {
    // "Set primary" semantics (MB-1g): `true` makes this the workspace's
    // outbound sender and clears any other primary in one transaction;
    // `false` just un-stars this row (the picker then falls back to id asc).
    const { setPrimaryMailbox } = await import('../services/mailboxPicker.js');
    mailbox = await setPrimaryMailbox(req.workspaceId, id, req.body.isPrimary === true);
  }
  res.json({ success: true, data: presentMailbox(mailbox) });
}));

router.delete('/mailboxes/:mailboxId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  await prisma.mailboxConnection.delete({ where: { id } });
  res.json({ success: true });
}));

// ---------------------------------- category↔group affinity (T3.3 groundwork)
// Admin API only for now — the full mapping UX ships with per-group taxonomies.

router.get('/category-group-links', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const links = await prisma.categoryGroupLink.findMany({
    where: { workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
  });
  res.json({ success: true, data: links });
}));

router.put('/category-group-links', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const entries = Array.isArray(req.body?.links) ? req.body.links : [];
  const cleaned = [];
  for (const entry of entries) {
    const categoryId = Number(entry?.categoryId);
    const groupRaw = String(entry?.groupId ?? '');
    if (!Number.isInteger(categoryId) || !/^\d+$/.test(groupRaw)) {
      throw new ValidationError('Each link needs a categoryId and a groupId');
    }
    cleaned.push({ categoryId, groupId: BigInt(groupRaw) });
  }
  const catIds = [...new Set(cleaned.map((c) => c.categoryId))];
  if (catIds.length) {
    const owned = await prisma.competencyCategory.count({ where: { id: { in: catIds }, workspaceId: req.workspaceId } });
    if (owned !== catIds.length) throw new ValidationError('A category does not belong to this workspace');
  }
  const groupIds = [...new Set(cleaned.map((c) => c.groupId))];
  if (groupIds.length) {
    const owned = await prisma.group.count({ where: { workspaceId: req.workspaceId, freshserviceId: { in: groupIds } } });
    if (owned !== groupIds.length) throw new ValidationError('A group does not belong to this workspace');
  }
  await prisma.$transaction([
    prisma.categoryGroupLink.deleteMany({ where: { workspaceId: req.workspaceId } }),
    ...(cleaned.length ? [prisma.categoryGroupLink.createMany({
      data: cleaned.map((c) => ({ workspaceId: req.workspaceId, ...c, createdBy: req.ticketActor.email })),
    })] : []),
  ]);
  const links = await prisma.categoryGroupLink.findMany({ where: { workspaceId: req.workspaceId }, orderBy: { id: 'asc' } });
  res.json({ success: true, data: links });
}));

// ------------------------------------------------------ reply templates (T3.7)

router.get('/templates', asyncHandler(async (req, res) => {
  const templates = await prisma.replyTemplate.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: templates });
}));

router.post('/templates', asyncHandler(async (req, res) => {
  const name = String(req.body?.name || '').trim();
  const bodyText = String(req.body?.bodyText || '').trim();
  const bodyHtml = req.body?.bodyHtml ? String(req.body.bodyHtml) : null;
  if (!name || name.length > 120) throw new ValidationError('Template name is required (max 120 characters)');
  if (!bodyText) throw new ValidationError('Template body is required');
  const categoryId = req.body?.categoryId ? Number(req.body.categoryId) : null;
  if (categoryId) {
    const category = await prisma.competencyCategory.findFirst({ where: { id: categoryId, workspaceId: req.workspaceId } });
    if (!category) throw new ValidationError('Category not found in this workspace');
  }
  const template = await prisma.replyTemplate.create({
    data: { workspaceId: req.workspaceId, name, bodyText, bodyHtml, categoryId, createdBy: req.ticketActor.email },
  });
  res.status(201).json({ success: true, data: template });
}));

router.delete('/templates/:templateId', asyncHandler(async (req, res) => {
  const id = Number(req.params.templateId);
  const existing = await prisma.replyTemplate.findFirst({ where: { id, workspaceId: req.workspaceId, isActive: true } });
  if (!existing) throw new ValidationError('Template not found');
  const isOwner = existing.createdBy === req.ticketActor.email;
  const isAdmin = req.ticketActor.role === 'admin' || req.ticketActor.workspaceRole === 'admin';
  if (!isOwner && !isAdmin) throw new ValidationError('Only the creator or an admin can remove a template');
  await prisma.replyTemplate.update({ where: { id }, data: { isActive: false } });
  res.json({ success: true });
}));

// --------------------------------------------------- presence (gap plan 2 P4)
// In-memory "also viewing" only — nothing stored, no durations (team-safe).
// Works for both origins; not gated on the native-ticketing flag.

router.get('/presence', asyncHandler(async (req, res) => {
  res.json({ success: true, data: presenceSnapshot(req.workspaceId) });
}));

router.post('/:id/presence', asyncHandler(async (req, res) => {
  const ticketId = parseTicketId(req);
  const { email, name } = req.ticketActor;
  if (req.body?.leaving) {
    leavePresence(req.workspaceId, ticketId, email);
    res.json({ success: true, data: { viewers: [] } });
    return;
  }
  const viewers = heartbeatPresence(req.workspaceId, ticketId, { email, name });
  res.json({ success: true, data: { viewers: viewers.filter((v) => v.email !== email) } });
}));

// --------------------------------------------------------- tags (gap plan P1)
// TP-side tag layer for BOTH origins — never written back to FreshService.
// CRUD is admin-only (Settings → Ticket Ops); linking is any ticket actor.

router.get('/tags', asyncHandler(async (req, res) => {
  const tags = await prisma.ticketTag.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, color: true },
    orderBy: { name: 'asc' },
  });
  res.json({ success: true, data: tags });
}));

router.put('/:id/tags', asyncHandler(async (req, res) => {
  const result = await ticketService.setTags(
    parseTicketId(req), req.workspaceId, req.body?.tagIds, req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// ---------------------------------------------- bulk by query (gap plan P2.2)
// Apply one action to EVERYTHING matching the current filter (not just the
// page). Preview first for the confirm count; expectedTotal guards staleness.

router.post('/bulk-by-query', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') {
    throw new ValidationError('Bulk editing requires coordinator or admin access');
  }
  const result = await ticketService.bulkByQuery(req.workspaceId, {
    query: req.body?.query || {},
    action: req.body?.action,
    preview: req.body?.preview === true,
    expectedTotal: req.body?.expectedTotal ?? null,
  }, req.ticketActor);
  res.json({ success: true, data: result });
}));

// ---------------------------------------------------- merge (gap plan P2.1)
// True merge: copies the source conversation onto the target, unions tags,
// links + closes the source. Members/admins only — agents cannot merge.

router.post('/:id/merge', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') {
    throw new ValidationError('Merging tickets requires coordinator or admin access');
  }
  const { default: ticketMergeService } = await import('../services/ticketMergeService.js');
  let targetTicketId = req.body?.targetTicketId;
  if (req.body?.targetTicketRef !== undefined) {
    const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
    targetTicketId = (await resolveTicketRefOrThrow(req.body.targetTicketRef, req.workspaceId)).id;
  }
  const result = await ticketMergeService.merge(parseTicketId(req), req.workspaceId, {
    targetTicketId,
    notifyRequester: req.body?.notifyRequester === true,
  }, req.ticketActor);
  res.json({ success: true, data: result });
}));

// Multi-merge (QA 07-13 #1): :id is the PRIMARY that survives; body.ticketIds
// are merged into it one by one (validated as a batch first).
router.post('/:id/merge-many', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') {
    throw new ValidationError('Merging tickets requires coordinator or admin access');
  }
  const { default: ticketMergeService } = await import('../services/ticketMergeService.js');
  const result = await ticketMergeService.mergeMany(parseTicketId(req), req.workspaceId, {
    ticketIds: Array.isArray(req.body?.ticketIds) ? req.body.ticketIds : [],
    notifyRequester: req.body?.notifyRequester === true,
  }, req.ticketActor);
  res.json({ success: true, data: result });
}));

// ---------------------------------------------------- quick notes (QA 07-06 #12)
// Active canned INTERNAL notes for the composer's note mode. The client
// filters by the ticket's top category (empty internalCategoryIds = always
// shown). CRUD is admin-only in Settings → Ticket Ops.

router.get('/quick-notes', asyncHandler(async (req, res) => {
  const notes = await prisma.quickNote.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    select: { id: true, name: true, bodyText: true, bodyHtml: true, internalCategoryIds: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  });
  res.json({ success: true, data: notes });
}));

// ------------------------------- "Also for" additional requesters (Phase MR6)
// Per-workspace toggle: when ON, requester-facing lifecycle mails (created /
// status / resolution workflow sends) cc the ticket's "Also for" list. Replies
// ALWAYS reach the list; CSAT stays primary-only. Stored in app_settings
// (workspace-scoped key) — read by any member, written by admins.

router.get('/also-for-settings', asyncHandler(async (req, res) => {
  const { isAlsoForNotifyEnabled } = await import('../services/alsoForNotifyService.js');
  res.json({ success: true, data: { notifyAdditionalRequesters: await isAlsoForNotifyEnabled(req.workspaceId) } });
}));

router.put('/also-for-settings', asyncHandler(async (req, res) => {
  const actor = req.ticketActor;
  if (!(actor?.role === 'admin' || actor?.workspaceRole === 'admin')) {
    return res.status(403).json({ success: false, message: 'Changing requester notification settings requires admin access.' });
  }
  if (typeof req.body?.notifyAdditionalRequesters !== 'boolean') {
    throw new ValidationError('notifyAdditionalRequesters must be true or false');
  }
  const { setAlsoForNotifyEnabled } = await import('../services/alsoForNotifyService.js');
  const enabled = await setAlsoForNotifyEnabled(req.workspaceId, req.body.notifyAdditionalRequesters);
  logger.info(`Also-notify additional requesters ${enabled ? 'ON' : 'OFF'} for workspace ${req.workspaceId} by ${actor?.email || 'unknown'}`);
  res.json({ success: true, data: { notifyAdditionalRequesters: enabled } });
}));

// ------------------------- FS replies posted as the acting agent (Phase DR4)
// Per-workspace flag, DEFAULT OFF: when ON, replies/notes Ticket Pulse posts
// to FS-born tickets carry `user_id: technicians.freshservice_id` so
// FreshService attributes (and addresses) them as the agent instead of the
// API-key owner. Same app_settings storage as the "Also for" toggle. Admin
// write; any member may read. Enable → send ONE test reply → verify (see
// qa/evidence-0830/phaseDRSN/FINDINGS.md) before leaving it on.

router.get('/fs-reply-as-agent-settings', asyncHandler(async (req, res) => {
  const { isFsReplyAsAgentEnabled } = await import('../services/fsReplyAsAgentService.js');
  res.json({ success: true, data: { fsReplyAsAgent: await isFsReplyAsAgentEnabled(req.workspaceId) } });
}));

router.put('/fs-reply-as-agent-settings', asyncHandler(async (req, res) => {
  const actor = req.ticketActor;
  if (!(actor?.role === 'admin' || actor?.workspaceRole === 'admin')) {
    return res.status(403).json({ success: false, message: 'Changing FreshService attribution settings requires admin access.' });
  }
  if (typeof req.body?.fsReplyAsAgent !== 'boolean') {
    throw new ValidationError('fsReplyAsAgent must be true or false');
  }
  const { setFsReplyAsAgentEnabled } = await import('../services/fsReplyAsAgentService.js');
  const enabled = await setFsReplyAsAgentEnabled(req.workspaceId, req.body.fsReplyAsAgent);
  logger.info(`FS reply-as-agent ${enabled ? 'ON' : 'OFF'} for workspace ${req.workspaceId} by ${actor?.email || 'unknown'}`);
  res.json({ success: true, data: { fsReplyAsAgent: enabled } });
}));

// ------------------------------------------------- watch subscriptions (T3.6)
// Per-category or per-group, never per-ticket (decision d7).

router.get('/watch-subscriptions', asyncHandler(async (req, res) => {
  const subs = await prisma.ticketWatchSubscription.findMany({
    where: { workspaceId: req.workspaceId, userEmail: req.ticketActor.email },
    orderBy: { id: 'asc' },
  });
  res.json({ success: true, data: subs });
}));

router.post('/watch-subscriptions', asyncHandler(async (req, res) => {
  const scopeType = req.body?.scopeType;
  const watch = req.body?.watch !== false;
  const notifyRequesterReply = req.body?.notifyRequesterReply === true;
  if (!['category', 'group'].includes(scopeType)) throw new ValidationError('scopeType must be category or group');

  let categoryId = null;
  let groupId = null;
  if (scopeType === 'category') {
    categoryId = Number(req.body?.categoryId);
    if (!Number.isInteger(categoryId) || categoryId <= 0) throw new ValidationError('categoryId is required for category scope');
    const category = await prisma.competencyCategory.findFirst({ where: { id: categoryId, workspaceId: req.workspaceId } });
    if (!category) throw new ValidationError('Category not found in this workspace');
  } else {
    const raw = String(req.body?.groupId ?? '');
    if (!/^\d+$/.test(raw)) throw new ValidationError('groupId is required for group scope');
    groupId = BigInt(raw);
    const group = await prisma.group.findFirst({ where: { workspaceId: req.workspaceId, freshserviceId: groupId } });
    if (!group) throw new ValidationError('Group not found in this workspace');
  }

  const where = { workspaceId: req.workspaceId, userEmail: req.ticketActor.email, scopeType, categoryId, groupId };
  const existing = await prisma.ticketWatchSubscription.findFirst({ where });
  if (!watch) {
    if (existing) await prisma.ticketWatchSubscription.delete({ where: { id: existing.id } });
    return res.json({ success: true, data: null });
  }
  const sub = existing
    ? await prisma.ticketWatchSubscription.update({ where: { id: existing.id }, data: { notifyRequesterReply } })
    : await prisma.ticketWatchSubscription.create({
      data: { ...where, userName: req.ticketActor.name, notifyCreated: true, notifyRequesterReply },
    });
  res.json({ success: true, data: sub });
}));

// ------------------------------------------------------ API keys (admin)

router.get('/api-keys', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  res.json({ success: true, data: await apiKeyService.list(req.workspaceId) });
}));

router.get('/api-keys/scopes', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { API_KEY_SCOPES } = await import('../services/apiKeyService.js');
  res.json({ success: true, data: API_KEY_SCOPES });
}));

router.post('/api-keys', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  const key = await apiKeyService.create(req.workspaceId, {
    name: req.body?.name,
    scopes: req.body?.scopes,
    mode: req.body?.mode,
    expiresInDays: req.body?.expiresInDays,
    ipAllowlist: req.body?.ipAllowlist,
    rateLimitPerMin: req.body?.rateLimitPerMin,
  }, req.ticketActor);
  // The raw key is returned exactly once — only its hash is stored.
  res.status(201).json({ success: true, data: { ...key, apiKey: key.key } });
}));

router.patch('/api-keys/:keyId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  res.json({ success: true, data: await apiKeyService.update(Number(req.params.keyId), req.workspaceId, req.body || {}) });
}));

router.post('/api-keys/:keyId/rotate', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  const key = await apiKeyService.rotate(Number(req.params.keyId), req.workspaceId);
  res.json({ success: true, data: { ...key, apiKey: key.key } });
}));

router.post('/api-keys/:keyId/revoke', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  res.json({ success: true, data: await apiKeyService.revoke(Number(req.params.keyId), req.workspaceId) });
}));

router.get('/api-keys/:keyId/usage', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.keyId);
  const since = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const [total24h, total7d, recent] = await Promise.all([
    prisma.apiRequestLog.count({ where: { apiKeyId: id, createdAt: { gte: new Date(Date.now() - 86400000) } } }),
    prisma.apiRequestLog.count({ where: { apiKeyId: id, createdAt: { gte: since } } }),
    prisma.apiRequestLog.findMany({
      where: { apiKeyId: id }, orderBy: { createdAt: 'desc' }, take: 20,
      select: { method: true, path: true, statusCode: true, durationMs: true, createdAt: true },
    }),
  ]);
  res.json({ success: true, data: { calls24h: total24h, calls7d: total7d, recent } });
}));

router.delete('/api-keys/:keyId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: apiKeyService } = await import('../services/apiKeyService.js');
  res.json({ success: true, data: await apiKeyService.remove(Number(req.params.keyId), req.workspaceId) });
}));

// ----------------------------------------- OAuth2 clients (admin)

router.get('/oauth-clients', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  res.json({ success: true, data: await oauthClientService.list(req.workspaceId) });
}));

router.post('/oauth-clients', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  const client = await oauthClientService.create(req.workspaceId, {
    name: req.body?.name, scopes: req.body?.scopes, expiresInDays: req.body?.expiresInDays,
  }, req.ticketActor);
  // client_secret returned exactly once.
  res.status(201).json({ success: true, data: client });
}));

router.patch('/oauth-clients/:clientId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  res.json({ success: true, data: await oauthClientService.update(Number(req.params.clientId), req.workspaceId, req.body || {}) });
}));

router.post('/oauth-clients/:clientId/rotate', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  res.json({ success: true, data: await oauthClientService.rotate(Number(req.params.clientId), req.workspaceId) });
}));

router.post('/oauth-clients/:clientId/revoke', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  res.json({ success: true, data: await oauthClientService.revoke(Number(req.params.clientId), req.workspaceId) });
}));

router.delete('/oauth-clients/:clientId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { default: oauthClientService } = await import('../services/oauthClientService.js');
  res.json({ success: true, data: await oauthClientService.remove(Number(req.params.clientId), req.workspaceId) });
}));

// ------------------------------------- outbound webhooks (gap plan 2 P3)

router.get('/webhook-subscriptions', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const subs = await prisma.webhookSubscription.findMany({
    where: { workspaceId: req.workspaceId },
    orderBy: { id: 'asc' },
    select: {
      id: true, url: true, events: true, isEnabled: true, failureCount: true,
      lastDeliveryAt: true, lastError: true, recentDeliveries: true, createdBy: true, createdAt: true,
    },
  });
  res.json({ success: true, data: subs });
}));

router.post('/webhook-subscriptions', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { WEBHOOK_EVENTS, webhookUrlProblem, invalidateWebhookCache } = await import('../services/webhookDispatchService.js');
  const url = String(req.body?.url || '').trim();
  const problem = webhookUrlProblem(url);
  if (problem) throw new ValidationError(problem);
  const events = (Array.isArray(req.body?.events) ? req.body.events : []).filter((e) => WEBHOOK_EVENTS.includes(e));
  if (events.length === 0) throw new ValidationError(`Pick at least one event: ${WEBHOOK_EVENTS.join(', ')}`);
  const crypto = await import('node:crypto');
  // Standard base64 (not base64url): the Standard Webhooks convention decodes
  // the portion after `whsec_` as standard base64, so a base64url secret with
  // `-`/`_` fails verification in strict consumer libs (e.g. Python).
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  const sub = await prisma.webhookSubscription.create({
    data: { workspaceId: req.workspaceId, url, secret, events, createdBy: req.ticketActor.email },
    select: { id: true, url: true, events: true, isEnabled: true, createdAt: true },
  });
  invalidateWebhookCache(req.workspaceId);
  // The signing secret is returned exactly once.
  res.status(201).json({ success: true, data: { ...sub, secret } });
}));

router.patch('/webhook-subscriptions/:subId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { WEBHOOK_EVENTS, webhookUrlProblem, invalidateWebhookCache } = await import('../services/webhookDispatchService.js');
  const id = Number(req.params.subId);
  const existing = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Webhook subscription not found');
  const data = {};
  if (req.body?.url !== undefined) {
    const problem = webhookUrlProblem(String(req.body.url).trim());
    if (problem) throw new ValidationError(problem);
    data.url = String(req.body.url).trim();
  }
  if (Array.isArray(req.body?.events)) {
    data.events = req.body.events.filter((e) => WEBHOOK_EVENTS.includes(e));
    if (data.events.length === 0) throw new ValidationError('Pick at least one event');
  }
  if (req.body?.isEnabled !== undefined) {
    data.isEnabled = req.body.isEnabled === true;
    if (data.isEnabled) data.failureCount = 0; // manual re-enable resets the strike counter
  }
  const sub = await prisma.webhookSubscription.update({
    where: { id },
    data,
    select: { id: true, url: true, events: true, isEnabled: true, failureCount: true },
  });
  invalidateWebhookCache(req.workspaceId);
  res.json({ success: true, data: sub });
}));

router.delete('/webhook-subscriptions/:subId', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.subId);
  const existing = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Webhook subscription not found');
  await prisma.webhookSubscription.delete({ where: { id } });
  const { invalidateWebhookCache } = await import('../services/webhookDispatchService.js');
  invalidateWebhookCache(req.workspaceId);
  res.json({ success: true });
}));

router.post('/webhook-subscriptions/:subId/test', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { testWebhookSubscription } = await import('../services/webhookDispatchService.js');
  res.json({ success: true, data: await testWebhookSubscription(Number(req.params.subId), req.workspaceId) });
}));

// Rotate the signing secret with a 24h grace window: the old secret keeps
// signing alongside the new one so consumers can switch without dropped events.
router.post('/webhook-subscriptions/:subId/rotate-secret', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { invalidateWebhookCache } = await import('../services/webhookDispatchService.js');
  const id = Number(req.params.subId);
  const existing = await prisma.webhookSubscription.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Webhook subscription not found');
  const crypto = await import('node:crypto');
  const secret = `whsec_${crypto.randomBytes(24).toString('base64')}`;
  await prisma.webhookSubscription.update({
    where: { id: existing.id },
    data: { secret, secretPrevious: existing.secret, secretRotatedAt: new Date() },
  });
  invalidateWebhookCache(req.workspaceId);
  // The new secret is returned exactly once; both sign for the next 24h.
  res.json({ success: true, data: { id: existing.id, secret, graceHours: 24 } });
}));

router.get('/webhook-subscriptions/:subId/deliveries', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { listDeliveries } = await import('../services/webhookDispatchService.js');
  res.json({ success: true, data: await listDeliveries(Number(req.params.subId), req.workspaceId, req.query.limit) });
}));

router.post('/webhook-deliveries/:deliveryId/redeliver', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const { redeliver } = await import('../services/webhookDispatchService.js');
  res.json({ success: true, data: await redeliver(Number(req.params.deliveryId), req.workspaceId) });
}));

router.post('/mailboxes/:mailboxId/test', requireTicketingAdmin, asyncHandler(async (req, res) => {
  const id = Number(req.params.mailboxId);
  const existing = await prisma.mailboxConnection.findFirst({ where: { id, workspaceId: req.workspaceId } });
  if (!existing) throw new ValidationError('Mailbox not found in this workspace');
  const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
  if (!graphMailClient.isConfigured()) {
    return res.json({ success: true, data: { success: false, message: 'Azure Graph credentials are not configured on the server' } });
  }
  // Phase RL (RL-7): the test proves READ and SEND capability — the app
  // token's roles decide canRead / canSend / canThread for this mode.
  const result = await graphMailClient.testConnection(existing.address, { mode: existing.mode });
  res.json({ success: true, data: result });
}));

// Static collection routes — MUST stay above /:id or Express eats them.
// Create-form presets (active only; '/templates' is taken by reply templates).
router.get('/create-templates', asyncHandler(async (req, res) => {
  const templates = await prisma.ticketTemplate.findMany({
    where: { workspaceId: req.workspaceId, isActive: true },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    select: {
      id: true, name: true, subject: true, description: true, priority: true,
      ticketType: true, internalCategoryId: true, internalSubcategoryId: true,
    },
  });
  res.json({ success: true, data: templates });
}));

router.get('/macros', asyncHandler(async (req, res) => {
  const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
  const macros = await ticketMacroService.list(req.workspaceId);
  res.json({ success: true, data: macros });
}));

router.get('/custom-fields/definitions', asyncHandler(async (req, res) => {
  const { default: customFieldService } = await import('../services/customFieldService.js');
  const definitions = await customFieldService.listDefinitions(req.workspaceId);
  res.json({ success: true, data: definitions });
}));

router.get('/:id', asyncHandler(async (req, res) => {
  // The peek preview passes ?reconcile=0 to skip the live FreshService check
  // (which otherwise fires a FS API call on every rapid step through tickets).
  const reconcile = req.query.reconcile !== '0';
  const ticket = await ticketService.getTicket(parseTicketId(req), req.workspaceId, { reconcile });
  res.json({ success: true, data: ticket });
}));

// --------------------------------------------------------------- mutations

// GET /:id/intake-runs — the Autofill runs that produced this ticket (AI &
// Routing tab). Same gate as any ticket read: the ticket must belong to the
// workspace the actor is in.
router.get('/:id/intake-runs', asyncHandler(async (req, res) => {
  const ticketId = parseTicketId(req);
  const ticket = await prisma.ticket.findFirst({ where: { id: ticketId, workspaceId: req.workspaceId }, select: { id: true } });
  if (!ticket) throw new AppError('Ticket not found', 404);
  const { default: ticketIntakeRunService } = await import('../services/ticketIntakeRunService.js');
  const runs = await ticketIntakeRunService.listForTicket(ticketId, req.workspaceId);
  res.json({ success: true, data: runs });
}));

router.post('/', requireNativeTicketing, asyncHandler(async (req, res) => {
  const { intakeRunId, ...body } = req.body || {};
  // AF2: an Autofill run id links the proposal to the ticket it produces.
  // Validated BEFORE the create so a stale/foreign id is a 400, not a ticket
  // with a dangling link.
  let linkRunId = null;
  if (intakeRunId !== undefined && intakeRunId !== null && intakeRunId !== '') {
    const { default: ticketIntakeRunService } = await import('../services/ticketIntakeRunService.js');
    linkRunId = (await ticketIntakeRunService.assertLinkable(intakeRunId, req.workspaceId)).id;
  }
  // enforceRequired: the interactive composer binds the workspace's ticket-form
  // required fields (built-ins + custom) — automated intakes stay exempt
  // (contract in ticketFormConfigService).
  const ticket = await ticketService.createTicket(req.workspaceId, body, req.ticketActor, {
    enforceRequired: true,
    ...(linkRunId ? { intakeRunId: linkRunId } : {}),
  });
  res.status(201).json({ success: true, data: ticket });
}));

router.patch('/:id', requireNativeTicketing, asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateTicketFields(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

router.post('/:id/status', requireNativeTicketing, asyncHandler(async (req, res) => {
  const status = String(req.body?.status || '').trim();
  const ticket = await ticketService.changeStatus(
    parseTicketId(req), req.workspaceId, status, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

router.post('/:id/clone', requireNativeTicketing, asyncHandler(async (req, res) => {
  const ticket = await ticketService.cloneTicket(parseTicketId(req), req.workspaceId, req.ticketActor);
  res.status(201).json({ success: true, data: ticket });
}));

// Delete a TP-born ticket (soft-delete → status 'Deleted'). Reviewer/admin only;
// TP-owned tickets only (the service rejects FS-born ones).
router.delete('/:id', requireNativeTicketing, asyncHandler(async (req, res) => {
  const actor = req.ticketActor;
  const allowed = actor.role === 'admin' || actor.workspaceRole === 'admin' || actor.workspaceRole === 'reviewer';
  if (!allowed) {
    return res.status(403).json({ success: false, message: 'Deleting tickets requires reviewer or admin access.' });
  }
  const ticket = await ticketService.deleteTicket(parseTicketId(req), req.workspaceId, actor);
  res.json({ success: true, data: ticket });
}));

router.post('/:id/assign', requireNativeTicketing, asyncHandler(async (req, res) => {
  const technicianId = req.body?.technicianId ?? null;
  const ticket = await ticketService.assignTicket(
    parseTicketId(req), req.workspaceId, technicianId, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

// FS-born field write-back: PUT to FreshService first, verify the echo, only
// then update Ticket Pulse — an FS failure changes nothing locally.
// Deliberately NOT behind requireNativeTicketing (it's an FS feature).
router.post('/:id/fs-update', asyncHandler(async (req, res) => {
  const ticket = await ticketService.updateFsTicket(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

// Manual AI-triage trigger (semi-manual assignment): fires the normal
// assignment pipeline for this ticket; results land in Assignment Review.
router.post('/:id/triage', asyncHandler(async (req, res) => {
  const result = await ticketService.requestTriage(parseTicketId(req), req.workspaceId, req.ticketActor);
  res.status(202).json({ success: true, data: result });
}));

// Related tickets: provable relations + clearly-labeled near-duplicate hints.
router.get('/:id/related', asyncHandler(async (req, res) => {
  const related = await ticketService.relatedTickets(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: related });
}));

// On-demand AI thread summary for the handling agent (read-only, never stored).
router.post('/:id/summarize', asyncHandler(async (req, res) => {
  const { default: ticketSummaryService } = await import('../services/ticketSummaryService.js');
  const summary = await ticketSummaryService.summarize(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: summary });
}));

// Explicit ticket links (duplicate_of / related_to / parent_of) + duplicate-close.
router.get('/:id/links', asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const links = await ticketLinkService.listForTicket(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: links });
}));

router.post('/:id/links', asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  // Users type visible refs (TP-1042 / #231164), not database ids (QA 07-07 #6).
  let relatedTicketId = req.body?.relatedTicketId;
  let resolved = null;
  if (req.body?.relatedTicketRef !== undefined) {
    const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
    resolved = await resolveTicketRefOrThrow(req.body.relatedTicketRef, req.workspaceId);
    relatedTicketId = resolved.id;
  }
  const link = await ticketLinkService.link(
    parseTicketId(req), req.workspaceId,
    { relatedTicketId, kind: req.body?.kind || 'related_to' },
    req.ticketActor,
  );
  res.status(201).json({ success: true, data: { ...link, resolvedTarget: resolved } });
}));

router.delete('/:id/links/:linkId', asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const result = await ticketLinkService.unlink(parseTicketId(req), req.workspaceId, req.params.linkId);
  res.json({ success: true, data: result });
}));

router.post('/:id/duplicate-of/:targetId', asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  // The path segment accepts a visible ref (TP-1042 / #231164 / bare number).
  const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
  const target = await resolveTicketRefOrThrow(req.params.targetId, req.workspaceId);
  const result = await ticketLinkService.markDuplicate(
    parseTicketId(req), req.workspaceId, target.id, req.ticketActor,
  );
  res.json({ success: true, data: { ...result, resolvedTarget: target } });
}));

// Parent / child ticket relationship (QA 07-16 #4).
router.get('/:id/family', asyncHandler(async (req, res) => {
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const family = await ticketLinkService.family(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: family });
}));

router.post('/:id/parent', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') throw new ValidationError('Linking tickets requires coordinator or admin access');
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  let parentTicketId = req.body?.parentTicketId;
  if (req.body?.parentTicketRef !== undefined) {
    const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
    parentTicketId = (await resolveTicketRefOrThrow(req.body.parentTicketRef, req.workspaceId)).id;
  }
  const family = await ticketLinkService.setParent(parseTicketId(req), req.workspaceId, { parentTicketId }, req.ticketActor);
  res.status(201).json({ success: true, data: family });
}));

router.delete('/:id/parent', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') throw new ValidationError('Linking tickets requires coordinator or admin access');
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  const result = await ticketLinkService.removeParent(parseTicketId(req), req.workspaceId, req.ticketActor);
  res.json({ success: true, data: result });
}));

// Add a child to THIS (parent) ticket by its visible ref.
router.post('/:id/children', asyncHandler(async (req, res) => {
  if (req.ticketActor.kind === 'agent') throw new ValidationError('Linking tickets requires coordinator or admin access');
  const { default: ticketLinkService } = await import('../services/ticketLinkService.js');
  let childTicketId = req.body?.childTicketId;
  if (req.body?.childTicketRef !== undefined) {
    const { resolveTicketRefOrThrow } = await import('../services/ticketRefResolver.js');
    childTicketId = (await resolveTicketRefOrThrow(req.body.childTicketRef, req.workspaceId)).id;
  }
  const family = await ticketLinkService.addChild(parseTicketId(req), req.workspaceId, { childTicketId }, req.ticketActor);
  res.status(201).json({ success: true, data: family });
}));

// Ticket tasks (QA 07-16 #3).
router.get('/:id/tasks', asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const tasks = await ticketTaskService.listForTicket(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: tasks });
}));

router.post('/:id/tasks', asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.create(parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor);
  res.status(201).json({ success: true, data: task });
}));

router.patch('/:id/tasks/:taskId', asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const task = await ticketTaskService.update(Number(req.params.taskId), req.workspaceId, req.body || {}, req.ticketActor, parseTicketId(req));
  res.json({ success: true, data: task });
}));

router.delete('/:id/tasks/:taskId', asyncHandler(async (req, res) => {
  const { default: ticketTaskService } = await import('../services/ticketTaskService.js');
  const result = await ticketTaskService.remove(Number(req.params.taskId), req.workspaceId, req.ticketActor, parseTicketId(req));
  res.json({ success: true, data: result });
}));

// Apply a macro (quick-action bundle) to this ticket.
router.post('/:id/macros/:macroId/apply', asyncHandler(async (req, res) => {
  const { default: ticketMacroService } = await import('../services/ticketMacroService.js');
  const result = await ticketMacroService.apply(
    parseTicketId(req), req.workspaceId, req.params.macroId, req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// Set custom-field values on a ticket (definitions are listed pre-/:id above).
router.patch('/:id/custom-fields', asyncHandler(async (req, res) => {
  const { default: customFieldService } = await import('../services/customFieldService.js');
  const result = await customFieldService.setValues(
    parseTicketId(req), req.workspaceId, req.body?.values || {}, req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// AI-proposed replies (draft→approve): list open proposals, approve & send
// (optionally edited), or dismiss. Sending goes through the normal reply path
// so threading/mirroring/events behave like a hand-written reply.
router.get('/:id/proposed-replies', asyncHandler(async (req, res) => {
  const { default: ticketProposedReplyService } = await import('../services/ticketProposedReplyService.js');
  const proposals = await ticketProposedReplyService.listForTicket(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: proposals });
}));

router.post('/:id/proposed-replies/:proposalId/send', asyncHandler(async (req, res) => {
  const { default: ticketProposedReplyService } = await import('../services/ticketProposedReplyService.js');
  const result = await ticketProposedReplyService.send(
    parseTicketId(req), req.workspaceId, req.params.proposalId,
    { bodyHtml: req.body?.bodyHtml, bodyText: req.body?.bodyText },
    req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

router.post('/:id/proposed-replies/:proposalId/dismiss', asyncHandler(async (req, res) => {
  const { default: ticketProposedReplyService } = await import('../services/ticketProposedReplyService.js');
  const proposal = await ticketProposedReplyService.dismiss(
    parseTicketId(req), req.workspaceId, req.params.proposalId, req.ticketActor,
  );
  res.json({ success: true, data: proposal });
}));

// Dismiss a pinned workflow card (Custom Fields Activation Phase 1). Ticket-
// level (any actor with ticket access), idempotent, audited. Deliberately NOT
// behind requireNativeTicketing — workflow cards annotate BOTH origins, like
// custom fields themselves.
router.post('/:id/pinned-cards/:cardId/dismiss', asyncHandler(async (req, res) => {
  const result = await ticketService.dismissPinnedCard(
    parseTicketId(req), req.workspaceId, req.params.cardId, req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// Forward the public thread to any address, recorded as a private entry.
router.post('/:id/forward', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await ticketService.forwardTicket(
    parseTicketId(req), req.workspaceId,
    { to: req.body?.to, note: req.body?.note },
    req.ticketActor,
  );
  res.status(201).json({ success: true, data: result });
}));

// Noise flag works for any origin (it's Ticket Pulse's own classification),
// so it deliberately skips requireNativeTicketing.
router.post('/:id/noise', asyncHandler(async (req, res) => {
  const ticket = await ticketService.setNoise(
    parseTicketId(req), req.workspaceId,
    { noise: req.body?.noise, resolve: req.body?.resolve === true },
    req.ticketActor,
  );
  res.json({ success: true, data: ticket });
}));

// Multipart (files + fields) or plain JSON — multer only engages on multipart.
// `Idempotency-Key` (Phase DR3): the composer mints one per session; a replay
// (double-click, retry after a dropped response) returns the entry that
// already exists — 200, not 201 — and never sends twice.
function threadInput(req) {
  const idempotencyKey = String(req.headers['idempotency-key'] || '').trim();
  return { ...(req.body || {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
}

router.post('/:id/replies', requireNativeTicketing, attachmentUpload.array('files', 5), asyncHandler(async (req, res) => {
  const result = await ticketService.addReply(
    parseTicketId(req), req.workspaceId, threadInput(req), req.ticketActor, req.files || [],
  );
  if (result.deduped) res.set('Idempotent-Replayed', 'true');
  res.status(result.deduped ? 200 : 201).json({ success: true, data: result });
}));

router.post('/:id/notes', requireNativeTicketing, attachmentUpload.array('files', 5), asyncHandler(async (req, res) => {
  const result = await ticketService.addPrivateNote(
    parseTicketId(req), req.workspaceId, threadInput(req), req.ticketActor, req.files || [],
  );
  if (result.deduped) res.set('Idempotent-Replayed', 'true');
  res.status(result.deduped ? 200 : 201).json({ success: true, data: result });
}));

// Manual "Mirror now" — force this native ticket's pending/failed FreshService
// mirror jobs to run immediately (the worker otherwise drains every ~60s).
router.post('/:id/mirror/retry', requireNativeTicketing, asyncHandler(async (req, res) => {
  const ticketId = parseTicketId(req);
  const ticket = await prisma.ticket.findFirst({
    where: { id: ticketId, workspaceId: req.workspaceId },
    select: { id: true, origin: true },
  });
  if (!ticket) throw new ValidationError('Ticket not found in this workspace');
  if (!actorIsAdmin(req.ticketActor)) throw new ValidationError('Only an admin can trigger a mirror');
  const { default: mirrorService } = await import('../services/mirrorService.js');
  // Mirroring calls FreshService through the shared rate limiter, whose queue
  // wait is unbounded — under pressure the drain can outlive the client's 30s
  // timeout, which surfaced as "network error" while the mirror kept running
  // server-side (QA 07-08). Time-box the response: if the drain is still going
  // after 20s, answer 202 and let it finish in the background (the per-ticket
  // in-flight lock in mirrorService makes a follow-up click safe).
  const drain = mirrorService.drainForTicket(ticketId, req.workspaceId);
  drain.catch((err) => logger.warn(`Mirror-now drain failed for ticket ${ticketId}: ${err.message}`));
  let timer;
  const timeoutMark = new Promise((resolve) => { timer = setTimeout(() => resolve('__timeout__'), 20_000); timer.unref?.(); });
  const result = await Promise.race([drain, timeoutMark]);
  clearTimeout(timer);
  if (result === '__timeout__') {
    res.status(202).json({ success: true, data: { inProgress: true } });
    return;
  }
  res.json({ success: true, data: result });
}));

// Admin-only: delete an internal note (native tickets; also removes the FS
// fallback copy via the mirror). Guarded again inside the service.
router.delete('/:id/notes/:entryId', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await ticketService.deleteNote(
    parseTicketId(req), req.workspaceId, Number(req.params.entryId), req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// Edit an internal note (author-or-admin). Deliberately NOT behind
// requireNativeTicketing: TP-authored notes on FS-BORN tickets are editable
// too — the service gates by entry provenance (eventType/author/system).
router.patch('/:id/notes/:entryId', asyncHandler(async (req, res) => {
  const result = await ticketService.updateNote(
    parseTicketId(req), req.workspaceId, Number(req.params.entryId),
    { bodyHtml: req.body?.bodyHtml, bodyText: req.body?.bodyText },
    req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// -------------------------------------------------------------- attachments

router.get('/:id/attachments', asyncHandler(async (req, res) => {
  const attachments = await attachmentService.listForTicket(parseTicketId(req), req.workspaceId);
  res.json({ success: true, data: attachments });
}));

router.post(
  '/:id/attachments',
  requireNativeTicketing,
  attachmentUpload.array('files', 5),
  asyncHandler(async (req, res) => {
    const ticketId = parseTicketId(req);
    const ticket = await prisma.ticket.findFirst({
      where: { id: ticketId, workspaceId: req.workspaceId },
      select: { id: true },
    });
    if (!ticket) throw new ValidationError('Ticket not found in this workspace');
    const files = req.files || [];
    if (files.length === 0) throw new ValidationError('No files were uploaded');

    const stored = [];
    for (const file of files) {
      stored.push(await attachmentService.upload({
        workspaceId: req.workspaceId,
        ticketId,
        fileName: file.originalname,
        contentType: file.mimetype,
        buffer: file.buffer,
        uploadedBy: req.ticketActor.email,
      }));
    }
    // WS-A.5: push ticket-level uploads to the FS fallback copy (TP-born only;
    // best-effort — a failed mirror never fails the upload).
    const full = await prisma.ticket.findUnique({ where: { id: ticketId }, select: { origin: true } });
    if (full?.origin === 'ticketpulse') {
      const { default: mirrorService } = await import('../services/mirrorService.js');
      for (const s of stored) {
        mirrorService.enqueueAttachment(req.workspaceId, ticketId, s.id).catch(() => {});
      }
    }
    res.status(201).json({ success: true, data: stored });
  }),
);

router.get('/:id/attachments/:attachmentId/download', asyncHandler(async (req, res) => {
  const { attachment, stream } = await attachmentService.openDownload(
    Number(req.params.attachmentId), parseTicketId(req), req.workspaceId,
  );
  res.setHeader('Content-Type', attachment.contentType || 'application/octet-stream');
  res.setHeader('Content-Length', attachment.sizeBytes);
  res.setHeader('Content-Disposition', `attachment; filename="${attachment.fileName.replace(/"/g, '')}"`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  stream.pipe(res);
}));

router.delete('/:id/attachments/:attachmentId', requireNativeTicketing, asyncHandler(async (req, res) => {
  const result = await attachmentService.remove(
    Number(req.params.attachmentId), parseTicketId(req), req.workspaceId, req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

// ---------------------------------------------------------------- approvals
// Approvals are a TP-only layer that works on any ticket in the workspace
// (TP-born AND FS-born synced) — they never touch FreshService, so they are
// NOT gated by requireNativeTicketing.

// Cross-ticket approver inbox for the current actor (pending decisions for me).
router.get('/approvals/inbox', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const data = await ticketApprovalService.inboxFor(req.workspaceId, req.ticketActor);
  res.json({ success: true, data });
}));

// Lightweight count for the nav badge.
router.get('/approvals/inbox/count', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const count = await ticketApprovalService.inboxCountFor(req.workspaceId, req.ticketActor);
  res.json({ success: true, data: { count } });
}));

// Approvals I requested that are awaiting my clarification ("Needs your info").
router.get('/approvals/mine', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const data = await ticketApprovalService.needsMyInfo(req.workspaceId, req.ticketActor);
  res.json({ success: true, data });
}));

// Admin/reviewer overview: stats + all approvals in the workspace (history).
router.get('/approvals/all', asyncHandler(async (req, res) => {
  const a = req.ticketActor;
  const canReview = a?.role === 'admin' || a?.workspaceRole === 'admin' || a?.workspaceRole === 'reviewer';
  if (!canReview) throw new AuthenticationError('Approvals overview is for reviewers and admins');
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const data = await ticketApprovalService.overview(req.workspaceId, {
    status: req.query.status || null,
    categoryId: req.query.categoryId || null,
  });
  res.json({ success: true, data });
}));

router.post('/:id/approvals', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const result = await ticketApprovalService.request(
    parseTicketId(req), req.workspaceId, req.body || {}, req.ticketActor,
  );
  res.status(201).json({ success: true, data: result });
}));

router.post('/:id/approvals/:approvalId/decide', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.decideInApp(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId),
    req.body?.decision, req.body?.note || null, req.ticketActor, req.body?.noteHtml || null,
  );
  res.json({ success: true, data: approval });
}));

router.post('/:id/approvals/:approvalId/clarify', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.requestClarification(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId),
    req.body?.note || null, req.ticketActor,
  );
  res.json({ success: true, data: approval });
}));

router.post('/:id/approvals/:approvalId/resubmit', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.resubmit(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId), req.ticketActor,
    { note: req.body?.note },
  );
  res.json({ success: true, data: approval });
}));

router.post('/:id/approvals/:approvalId/cancel', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.cancel(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId), req.ticketActor,
  );
  res.json({ success: true, data: approval });
}));

// Approver (or admin) flips a decided approval: approved ↔ rejected.
router.post('/:id/approvals/:approvalId/change', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.changeDecision(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId),
    req.body?.decision, req.body?.note || null, req.ticketActor,
  );
  res.json({ success: true, data: approval });
}));

// Requester (or admin) deletes a request entirely (whole group).
router.delete('/:id/approvals/:approvalId', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const result = await ticketApprovalService.deleteRequest(
    parseTicketId(req), req.workspaceId, Number(req.params.approvalId), req.ticketActor,
  );
  res.json({ success: true, data: result });
}));

/**
 * Public magic-link router (no app auth — the token IS the credential).
 * Mounted pre-auth in routes/index.js at /api/ticket-approvals/public.
 */
export const ticketApprovalPublicRouter = express.Router();

// Light in-memory rate limit (Phase AP): 60 requests / minute per client IP
// per token prefix. Enough for a human plus the page's photo fetches; stops
// token-guessing sweeps and reload storms. Problem-style 429 body.
export const PUBLIC_APPROVAL_RATE_LIMIT = { windowMs: 60 * 1000, max: 60 };
const publicApprovalHits = new Map(); // `${ip}:${tokenPrefix}` -> { count, resetAt }

export function publicApprovalRateLimit(req, res, next) {
  const now = Date.now();
  const ip = String(req.ip || req.socket?.remoteAddress || 'unknown');
  const prefix = String(req.params?.token || '').slice(0, 12);
  const key = `${ip}:${prefix}`;
  let entry = publicApprovalHits.get(key);
  if (!entry || entry.resetAt <= now) {
    entry = { count: 0, resetAt: now + PUBLIC_APPROVAL_RATE_LIMIT.windowMs };
    publicApprovalHits.set(key, entry);
  }
  entry.count += 1;
  // Opportunistic pruning keeps the map bounded without a timer.
  if (publicApprovalHits.size > 5000) {
    for (const [k, v] of publicApprovalHits) if (v.resetAt <= now) publicApprovalHits.delete(k);
  }
  const remaining = Math.max(0, PUBLIC_APPROVAL_RATE_LIMIT.max - entry.count);
  res.setHeader('X-RateLimit-Limit', String(PUBLIC_APPROVAL_RATE_LIMIT.max));
  res.setHeader('X-RateLimit-Remaining', String(remaining));
  if (entry.count > PUBLIC_APPROVAL_RATE_LIMIT.max) {
    const retryAfterSec = Math.max(1, Math.ceil((entry.resetAt - now) / 1000));
    res.setHeader('Retry-After', String(retryAfterSec));
    return res.status(429).json({
      success: false,
      type: 'about:blank',
      title: 'Too many requests',
      status: 429,
      detail: `Slow down — this approval link allows ${PUBLIC_APPROVAL_RATE_LIMIT.max} requests per minute. Try again in ${retryAfterSec}s.`,
      retryAfter: retryAfterSec,
      error: 'rate_limited',
    });
  }
  return next();
}

/** Test/ops hook — clears the limiter's counters. */
export function resetPublicApprovalRateLimit() {
  publicApprovalHits.clear();
}

ticketApprovalPublicRouter.use('/:token', publicApprovalRateLimit);

ticketApprovalPublicRouter.get('/:token', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const data = await ticketApprovalService.getByToken(req.params.token);
  res.setHeader('Cache-Control', 'no-store');
  res.json({ success: true, data });
}));

// Directory photo for the people on the page. The address is resolved from the
// approval row server-side — `who` picks WHICH person, never an email.
ticketApprovalPublicRouter.get('/:token/photo', asyncHandler(async (req, res) => {
  const who = String(req.query.who || '').trim();
  if (!['requester', 'requestedBy'].includes(who)) {
    throw new ValidationError('who must be "requester" or "requestedBy"');
  }
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const email = await ticketApprovalService.photoSubjectEmail(req.params.token, who);
  const decoded = email ? decodePhotoDataUri(await getCachedUserPhoto(email)) : null;
  // The public page lives on the app host and this API answers from api.<domain>; helmet's default
  // Cross-Origin-Resource-Policy: same-origin makes browsers refuse to paint the <img>. The response is
  // already token-gated (no email in the URL, no auth reuse), so opening it cross-origin is safe.
  res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');
  if (!decoded) {
    res.setHeader('Cache-Control', 'private, max-age=600');
    return res.status(404).json({ success: false, error: 'No photo available' });
  }
  res.setHeader('Content-Type', decoded.contentType);
  res.setHeader('Content-Length', String(decoded.buffer.length));
  res.setHeader('Cache-Control', 'private, max-age=3600');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.end(decoded.buffer);
}));

ticketApprovalPublicRouter.post('/:token/decide', asyncHandler(async (req, res) => {
  const { default: ticketApprovalService } = await import('../services/ticketApprovalService.js');
  const approval = await ticketApprovalService.decideByToken(
    req.params.token, req.body?.decision, req.body?.note || null, req.body?.noteHtml || null,
  );
  res.json({
    success: true,
    data: { status: approval.status, decidedAt: approval.decidedAt || null, approverName: approval.approverName || null },
  });
}));

/**
 * Post-outage recovery: import FS-side deltas on TP-born mirrored tickets and
 * surface conflicts. Admin-only (global or workspace admin).
 */
router.post('/mirror/reconcile', asyncHandler(async (req, res) => {
  const actor = req.ticketActor;
  if (actor.role !== 'admin' && actor.workspaceRole !== 'admin') {
    throw new AuthenticationError('Admin access required for mirror reconciliation');
  }
  const { default: mirrorService } = await import('../services/mirrorService.js');
  const result = await mirrorService.reconcile(req.workspaceId, req.body || {});
  res.json({ success: true, data: result });
}));

export default router;
