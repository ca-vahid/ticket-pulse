/**
 * FreshService switch, per workspace (plans/FRESHSERVICE_SWITCH_PLAN.md, 25 Nov 2026).
 *
 *   GET  /api/workspaces/freshservice-modes      super admins: { [workspaceId]: { mode, changedAt } }
 *   GET  /api/workspaces/:id/freshservice        workspace admins + super admins: mode, record,
 *                                                Shadow counts, preflight, the Off job, canWrite
 *   PUT  /api/workspaces/:id/freshservice        super admins: { mode: 'connected' | 'shadow' }
 *   POST /api/workspaces/:id/freshservice/off    super admins: { confirmName } → starts the Off job
 *   GET  /api/workspaces/:id/freshservice/off    workspace admins + super admins: the job's progress
 *
 * Turning Off is one guided step: the typed workspace name confirms it, the
 * preflight's blockers refuse it, then a background job adopts every open
 * FreshService-born ticket (fsAdoptionService) and only then sets the mode Off.
 * A failed adoption leaves the workspace as it was (nothing is switched off);
 * adoption is idempotent, so "Try again" is safe. One job per workspace.
 * Progress lives in the app setting `freshservice_switch_job_ws<N>`.
 *
 * Mounted at /workspaces BEFORE workspace.routes.js (routes/index.js). Like
 * the /:id/access routes, the admin gate is bound to the TARGET workspace.
 */
import express from 'express';
import prisma from '../services/prisma.js';
import settingsRepository from '../services/settingsRepository.js';
import { requireAuth, requireAdmin, requireGlobalAdmin, sessionUser } from '../middleware/auth.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { recordAccessEvent, ACTIONS } from '../services/accessAuditService.js';
import { getMode, getModeRecord, getShadowReport, setMode } from '../services/fsModeService.js';
import autoCloseResolvedService from '../services/autoCloseResolvedService.js';
import logger from '../utils/logger.js';

const router = express.Router();

export const jobSettingKey = (ws) => `freshservice_switch_job_ws${Number(ws) || 0}`;
const RECENT_DAYS = 7;
const EMAIL_SOURCE = 1;
const PROGRESS_WRITE_MS = 1000;

// Workspaces with an Off job running in THIS process (one job at a time).
const runningJobs = new Map(); // ws -> Promise

const adoption = () => import('../services/fsAdoptionService.js').then((m) => m.default || m);

/** Same rule as workspace.routes.js scopeToTargetWorkspace: the admin gate checks the TARGET workspace. */
function scopeToTarget(req, res, next) {
  const targetId = Number(req.params.id);
  if (!Number.isInteger(targetId) || targetId <= 0) {
    return res.status(400).json({ success: false, message: 'Invalid workspace id' });
  }
  const user = sessionUser(req);
  if (user?.role !== 'admin') {
    const scopedRaw = req.headers['x-workspace-id'] ?? user?.selectedWorkspaceId ?? null;
    const scopedId = scopedRaw === null || scopedRaw === undefined || scopedRaw === '' ? null : Number(scopedRaw);
    if (scopedId !== null && !Number.isNaN(scopedId) && scopedId !== targetId) {
      return res.status(403).json({ success: false, message: 'You can only see FreshService settings for your current workspace', code: 'workspace_mismatch' });
    }
  }
  req.workspaceId = targetId;
  return next();
}

async function loadWorkspace(id) {
  const ws = await prisma.workspace.findUnique({ where: { id }, select: { id: true, name: true, freshserviceWorkspaceId: true, isActive: true } });
  if (!ws) return null;
  return { id: ws.id, name: ws.name, freshserviceWorkspaceId: ws.freshserviceWorkspaceId === null || ws.freshserviceWorkspaceId === undefined ? null : String(ws.freshserviceWorkspaceId), isActive: ws.isActive !== false };
}

function parseJob(raw) {
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj && typeof obj === 'object' && obj.state ? obj : null;
  } catch { return null; }
}

/** The stored job, with a "running" job that no process owns any more read as interrupted. */
export async function readJob(ws) {
  const job = parseJob(await settingsRepository.get(jobSettingKey(ws)).catch(() => null));
  if (job?.state === 'running' && !runningJobs.has(Number(ws))) {
    return { ...job, state: 'failed', error: job.error || 'The switch was interrupted (the server restarted). Nothing was switched off; try again.' };
  }
  return job;
}

async function writeJob(ws, job) {
  await settingsRepository.set(jobSettingKey(ws), JSON.stringify(job)).catch((err) => {
    logger.warn(`FreshService switch: could not save progress for workspace ${ws}: ${err.message}`);
  });
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * What Off needs, as facts plus one plain sentence per item.
 * state: 'ok' | 'warn' | 'block'. Only mail intake can block (no ingest
 * mailbox while FreshService-born mail arrived in the last 7 days).
 */
export async function buildPreflight(ws) {
  const since = new Date(Date.now() - RECENT_DAYS * 24 * 60 * 60 * 1000);
  const [preview, mailboxes, ingestMailboxes, recentFsBorn, recentFsBornMail, ackWorkflow, reminderWorkflow, autoClose] = await Promise.all([
    adoption().then((svc) => svc.previewWorkspace(ws)).catch((err) => ({ error: err.message })),
    prisma.mailboxConnection.count({ where: { workspaceId: ws, isEnabled: true } }),
    prisma.mailboxConnection.count({ where: { workspaceId: ws, isEnabled: true, mode: { in: ['ingest', 'both'] } } }),
    prisma.ticket.count({ where: { workspaceId: ws, origin: 'freshservice', createdAt: { gte: since } } }),
    prisma.ticket.count({ where: { workspaceId: ws, origin: 'freshservice', source: EMAIL_SOURCE, createdAt: { gte: since } } }),
    prisma.notificationWorkflow.findFirst({
      where: { workspaceId: ws, isEnabled: true, archivedAt: null, triggerType: 'ticket.created' },
      select: { id: true, name: true, mockModeEnabled: true },
    }),
    prisma.notificationWorkflow.findFirst({
      where: { workspaceId: ws, isEnabled: true, archivedAt: null, triggerType: 'ticket.requester_silent_for' },
      select: { id: true, name: true, mockModeEnabled: true },
    }),
    autoCloseResolvedService.getSettings(ws).catch(() => ({ enabled: false })),
  ]);

  const openFsBorn = Number(preview?.openFsBorn) || 0;
  const uncachedAttachments = Number(preview?.uncachedAttachments) || 0;
  const items = [];

  // Mail intake: the one item that can block.
  if (ingestMailboxes > 0) {
    items.push({ key: 'mail_intake', state: 'ok', text: `Mail reaches Ticket Pulse directly: ${plural(ingestMailboxes, 'mailbox', 'mailboxes')} connected.`, link: 'ticket-mailboxes' });
  } else if (recentFsBornMail > 0) {
    items.push({
      key: 'mail_intake', state: 'block',
      text: `No mailbox is connected to Ticket Pulse, and ${plural(recentFsBornMail, 'e-mail')} arrived through FreshService in the last ${RECENT_DAYS} days. Connect the team's mailbox in Ticket Mailboxes before turning FreshService off, or those e-mails stop becoming tickets.`,
      link: 'ticket-mailboxes',
    });
  } else {
    items.push({ key: 'mail_intake', state: 'warn', text: `No mailbox is connected to Ticket Pulse. No e-mail came through FreshService in the last ${RECENT_DAYS} days, so nothing is lost, but new mail will need a mailbox.`, link: 'ticket-mailboxes' });
  }

  // Tickets still born in FreshService.
  items.push(recentFsBorn > 0
    ? { key: 'recent_intake', state: 'warn', text: `${plural(recentFsBorn, 'ticket')} arrived through FreshService in the last ${RECENT_DAYS} days. After Off, anything still sent to FreshService won't reach Ticket Pulse.` }
    : { key: 'recent_intake', state: 'ok', text: `No tickets arrived through FreshService in the last ${RECENT_DAYS} days.` });

  // Adoption.
  if (preview?.error) {
    items.push({ key: 'adopt', state: 'warn', text: `The open FreshService tickets could not be counted (${preview.error}).` });
  } else {
    items.push(openFsBorn > 0
      ? { key: 'adopt', state: 'ok', text: `${plural(openFsBorn, 'open FreshService ticket')} will be adopted: each becomes a Ticket Pulse ticket (TP-number), fully editable here.` }
      : { key: 'adopt', state: 'ok', text: 'No open FreshService tickets to adopt.' });
  }

  // Attachments only FreshService holds.
  items.push(uncachedAttachments > 0
    ? { key: 'attachments', state: 'warn', text: `${plural(uncachedAttachments, 'FreshService attachment')} on imported tickets ${uncachedAttachments === 1 ? 'is' : 'are'} not stored in Ticket Pulse yet. Adopted tickets keep theirs; the rest go when FreshService ends unless the final import runs first.` }
    : { key: 'attachments', state: 'ok', text: 'Every FreshService attachment is already stored in Ticket Pulse.' });

  // What FreshService did for the requester, that Ticket Pulse now must.
  const wfItem = (key, wf, missingText, readyText) => {
    if (!wf) return { key, state: 'warn', text: missingText, link: 'notification-workflows' };
    if (wf.mockModeEnabled) return { key, state: 'warn', text: `${readyText} "${wf.name}" is still in Shadow, so it won't send yet.`, link: 'notification-workflows', workflowId: wf.id };
    return { key, state: 'ok', text: `${readyText} "${wf.name}" is on.`, link: 'notification-workflows', workflowId: wf.id };
  };
  items.push(wfItem('ack_workflow', ackWorkflow,
    'FreshService sent the "we got your ticket" e-mail for you. Ticket Pulse has no Ticket created workflow switched on to do it now.',
    'Ticket Pulse acknowledges new tickets:'));
  items.push(wfItem('reminder_workflow', reminderWorkflow,
    'FreshService reminded requesters who went quiet. Ticket Pulse has no Pending Response reminder (requester silent) workflow switched on.',
    'Ticket Pulse reminds quiet requesters:'));
  items.push(autoClose?.enabled
    ? { key: 'auto_close', state: 'ok', text: 'Ticket Pulse closes resolved tickets automatically.', link: 'ticket-ops' }
    : { key: 'auto_close', state: 'warn', text: 'FreshService closed resolved tickets for you. Auto-close of resolved tickets is off in Ticket Ops.', link: 'ticket-ops' });

  return {
    openFsBorn,
    uncachedAttachments,
    sample: Array.isArray(preview?.sample) ? preview.sample.slice(0, 20) : [],
    mailboxes: { enabled: mailboxes, ingest: ingestMailboxes },
    recentFsBorn,
    recentFsBornMail,
    ackWorkflow: ackWorkflow ? { id: ackWorkflow.id, name: ackWorkflow.name, shadow: ackWorkflow.mockModeEnabled === true } : null,
    reminderWorkflow: reminderWorkflow ? { id: reminderWorkflow.id, name: reminderWorkflow.name, shadow: reminderWorkflow.mockModeEnabled === true } : null,
    autoCloseResolved: autoClose?.enabled === true,
    items,
    blockers: items.filter((i) => i.state === 'block').map((i) => i.text),
    warnings: items.filter((i) => i.state === 'warn').map((i) => i.text),
  };
}

function publicRecord(record) {
  if (!record) return null;
  return {
    mode: record.mode,
    changedBy: record.changedBy || null,
    changedAt: record.changedAt || null,
    note: record.note || null,
    adoptedCount: record.adoptedCount ?? null,
    adoptedAt: record.adoptedAt || null,
    history: Array.isArray(record.history) ? record.history : [],
  };
}

/**
 * The Off job: adopt every open FreshService-born ticket, then set Off.
 * Exported for tests (the route starts it without awaiting).
 */
export async function runOffJob(ws, { actorEmail, workspaceName }) {
  const startedAt = new Date().toISOString();
  let job = { state: 'running', step: 'adopt', total: 0, done: 0, adopted: 0, failedCount: 0, failed: [], startedAt, finishedAt: null, actorEmail: actorEmail || null };
  let pendingWrite = Promise.resolve(); // throttled progress writes, in order
  try {
    const svc = await adoption();
    const preview = await svc.previewWorkspace(ws).catch(() => null);
    job.total = Number(preview?.openFsBorn) || 0;
    await writeJob(ws, job);

    let lastWrite = 0;
    const onProgress = (p = {}, maybeTotal) => {
      // fsAdoptionService reports { done, total, adopted, failed (a count) } per ticket.
      if (typeof p === 'number') { job.done = p; job.adopted = p; if (Number.isFinite(Number(maybeTotal))) job.total = Number(maybeTotal); }
      else {
        if (Number.isFinite(Number(p.done))) job.done = Number(p.done);
        if (Number.isFinite(Number(p.adopted))) job.adopted = Number(p.adopted);
        if (Number.isFinite(Number(p.total))) job.total = Number(p.total);
        if (Number.isFinite(Number(p.failed))) job.failedCount = Number(p.failed);
        else if (Array.isArray(p.failed)) job.failed = p.failed;
      }
      if (Date.now() - lastWrite >= PROGRESS_WRITE_MS) {
        lastWrite = Date.now();
        const snapshot = { ...job };
        pendingWrite = pendingWrite.then(() => writeJob(ws, snapshot));
      }
    };
    const result = await svc.adoptWorkspace(ws, { actorEmail, onProgress });
    await pendingWrite; // a late progress write must never land over the final state
    const adoptedList = result?.adopted;
    job.adopted = Array.isArray(adoptedList) ? adoptedList.length : (Number(adoptedList) || 0);
    job.failed = Array.isArray(result?.failed) ? result.failed.map((f) => ({ id: f?.id ?? null, error: String(f?.error || 'failed').slice(0, 300) })) : [];
    job.failedCount = job.failed.length;
    job.total = Math.max(job.total, Number(result?.total) || 0, job.adopted + job.failed.length);
    job.done = job.total;

    if (job.adopted > 0 || job.failed.length > 0) {
      await recordAccessEvent({
        workspaceId: ws, actorEmail, action: ACTIONS.FRESHSERVICE_TICKETS_ADOPTED,
        targetLabel: workspaceName || null, newValue: String(job.adopted),
        details: { adopted: job.adopted, failed: job.failed.length, reason: 'switch_off' },
      });
    }

    if (job.failed.length > 0) {
      job = { ...job, state: 'failed', step: 'adopt', finishedAt: new Date().toISOString(),
        error: `${plural(job.failed.length, 'ticket')} could not be adopted. Nothing was switched off; try again.` };
      await writeJob(ws, job);
      logger.warn(`FreshService switch: workspace ${ws} not switched off, ${job.failed.length} adoption(s) failed`);
      return job;
    }

    job.step = 'switch';
    await writeJob(ws, { ...job });
    const before = await getModeRecord(ws).catch(() => ({ mode: 'connected' }));
    await setMode(ws, 'off', { actorEmail, extra: { adoptedCount: job.adopted, adoptedAt: new Date().toISOString() } });
    await recordAccessEvent({
      workspaceId: ws, actorEmail, action: ACTIONS.FRESHSERVICE_MODE_CHANGED,
      targetLabel: workspaceName || null, oldValue: before?.mode || 'connected', newValue: 'off',
      details: { adoptedCount: job.adopted },
    });
    job = { ...job, state: 'done', step: 'done', finishedAt: new Date().toISOString() };
    await writeJob(ws, job);
    logger.info(`FreshService switch: workspace ${ws} is Off (${job.adopted} adopted) by ${actorEmail || 'unknown'}`);
    return job;
  } catch (err) {
    await pendingWrite;
    job = { ...job, state: 'failed', finishedAt: new Date().toISOString(), error: `${err.message || 'The switch failed'}. Nothing was switched off; try again.` };
    await writeJob(ws, job);
    logger.warn(`FreshService switch: workspace ${ws} Off job failed: ${err.message}`);
    return job;
  }
}

/** For tests: wait for a workspace's running job. */
export function _jobPromise(ws) { return runningJobs.get(Number(ws)) || null; }

// ------------------------------------------------------------------ routes

router.get('/freshservice-modes', requireAuth, requireGlobalAdmin, asyncHandler(async (_req, res) => {
  const rows = await prisma.workspace.findMany({ where: { isActive: true }, select: { id: true } });
  const out = {};
  for (const r of rows) {
    const mode = await getMode(r.id);
    const record = mode === 'never_connected' ? null : await getModeRecord(r.id).catch(() => null);
    out[r.id] = { mode, changedAt: record?.changedAt || null };
  }
  res.json({ success: true, data: out });
}));

router.get('/:id/freshservice', requireAuth, scopeToTarget, requireAdmin, asyncHandler(async (req, res) => {
  const ws = await loadWorkspace(req.workspaceId);
  if (!ws) return res.status(404).json({ success: false, message: 'Workspace not found' });
  const canWrite = sessionUser(req)?.role === 'admin';
  const mode = await getMode(ws.id);
  if (mode === 'never_connected') {
    return res.json({ success: true, data: { workspace: ws, mode, record: null, shadow: null, preflight: null, job: null, canWrite: false } });
  }
  const [record, shadow, preflight, job] = await Promise.all([
    getModeRecord(ws.id),
    getShadowReport(ws.id).catch(() => ({ since: null, counts: {}, total: 0 })),
    mode === 'off' ? Promise.resolve(null) : buildPreflight(ws.id),
    readJob(ws.id),
  ]);
  res.json({ success: true, data: { workspace: ws, mode, record: publicRecord(record), shadow, preflight, job, canWrite } });
}));

router.put('/:id/freshservice', requireAuth, scopeToTarget, requireGlobalAdmin, asyncHandler(async (req, res) => {
  const next = req.body?.mode;
  if (!['connected', 'shadow'].includes(next)) {
    return res.status(400).json({ success: false, message: 'mode must be connected or shadow (Off has its own guided step)', code: 'invalid_mode' });
  }
  const ws = await loadWorkspace(req.workspaceId);
  if (!ws) return res.status(404).json({ success: false, message: 'Workspace not found' });
  const before = await getMode(ws.id);
  if (before === 'never_connected') {
    return res.status(409).json({ success: false, message: 'This workspace was never connected to FreshService; there is nothing to switch.', code: 'never_connected' });
  }
  if (runningJobs.has(ws.id)) {
    return res.status(409).json({ success: false, message: 'FreshService is being switched off for this workspace; wait for it to finish.', code: 'switch_running' });
  }
  const actorEmail = sessionUser(req)?.email || null;
  const record = before === next ? await getModeRecord(ws.id) : await setMode(ws.id, next, { actorEmail });
  if (before !== next) {
    await recordAccessEvent({
      workspaceId: ws.id, actorEmail, action: ACTIONS.FRESHSERVICE_MODE_CHANGED,
      targetLabel: ws.name, oldValue: before, newValue: next,
    });
  }
  res.json({ success: true, data: { mode: next, record: publicRecord(record) } });
}));

router.get('/:id/freshservice/off', requireAuth, scopeToTarget, requireAdmin, asyncHandler(async (req, res) => {
  res.json({ success: true, data: await readJob(req.workspaceId) });
}));

router.post('/:id/freshservice/off', requireAuth, scopeToTarget, requireGlobalAdmin, asyncHandler(async (req, res) => {
  const ws = await loadWorkspace(req.workspaceId);
  if (!ws) return res.status(404).json({ success: false, message: 'Workspace not found' });
  const mode = await getMode(ws.id);
  if (mode === 'never_connected') {
    return res.status(409).json({ success: false, message: 'This workspace was never connected to FreshService; there is nothing to switch off.', code: 'never_connected' });
  }
  if (mode === 'off') {
    return res.status(409).json({ success: false, message: 'FreshService is already off for this workspace.', code: 'already_off' });
  }
  const typed = String(req.body?.confirmName ?? '').trim().toLowerCase();
  if (!typed || typed !== String(ws.name).trim().toLowerCase()) {
    return res.status(400).json({ success: false, message: `Type the workspace name, "${ws.name}", to confirm.`, code: 'confirm_name_mismatch' });
  }
  if (runningJobs.has(ws.id)) {
    return res.status(409).json({ success: false, message: 'FreshService is already being switched off for this workspace.', code: 'switch_running', data: await readJob(ws.id) });
  }
  const preflight = await buildPreflight(ws.id);
  if (preflight.blockers.length) {
    return res.status(409).json({ success: false, message: preflight.blockers[0], code: 'preflight_blocked', data: { blockers: preflight.blockers } });
  }
  const actorEmail = sessionUser(req)?.email || null;
  const initial = { state: 'running', step: 'check', total: preflight.openFsBorn, done: 0, adopted: 0, failedCount: 0, failed: [], startedAt: new Date().toISOString(), finishedAt: null, actorEmail };
  await writeJob(ws.id, initial);
  const promise = runOffJob(ws.id, { actorEmail, workspaceName: ws.name })
    .finally(() => { runningJobs.delete(ws.id); });
  runningJobs.set(ws.id, promise);
  logger.info(`FreshService switch: ${actorEmail || 'unknown'} started turning FreshService off for workspace ${ws.id} (${preflight.openFsBorn} to adopt)`);
  res.status(202).json({ success: true, data: initial });
}));

export default router;
