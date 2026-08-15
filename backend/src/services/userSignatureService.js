import prisma from './prisma.js';
import azureAdService from './azureAdService.js';
import {
  MAX_SIGNATURE_HTML_BYTES,
  sanitizeSignatureHtml,
  stripHtml,
} from './notificationWorkflowSignatureService.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import logger from '../utils/logger.js';

/**
 * Per-user outbound email signatures (QA 08-14 #1 / Mega 08-15 Phase D).
 *
 * Keyed by (workspaceId, ownerEmail) — the SavedFilterView identity model, no
 * User table. The signature is appended to the OUTBOUND reply email only (FS
 * createReply body + native requester email); the stored thread entry stays
 * clean. Replies only — never internal notes or forwards (locked decision;
 * forwards default off).
 *
 * Sanitization reuses the permissive workflow-signature allowlist
 * (EMAIL_SANITIZE_OPTIONS: tables/img/data-images ≤512KB) so a pasted Outlook
 * signature survives intact.
 */

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(name|title|email)\s*\}\}/gi;

function signatureClient(client = prisma) {
  // Optional-chained like the workflow service's blockClient: environments
  // whose Prisma client predates the migration degrade to "no signature".
  return client?.userEmailSignature || null;
}

function normalizeOwnerEmail(email) {
  const normalized = String(email || '').trim().toLowerCase();
  if (!normalized || !normalized.includes('@')) {
    throw new ValidationError('A valid owner email is required for signatures');
  }
  return normalized;
}

function normalizeWorkspaceId(workspaceId) {
  const id = Number.parseInt(workspaceId, 10);
  if (!Number.isFinite(id) || id <= 0) throw new ValidationError('Invalid workspace id');
  return id;
}

function actorEmail(actor = null) {
  return String(actor?.email || actor || '').trim() || null;
}

function hasContent(row = null) {
  if (!row) return false;
  return Boolean(String(row.html || '').trim() || String(row.text || '').trim());
}

export function serializeSignature(row = null, { workspaceId = null, ownerEmail = null } = {}) {
  if (!row) {
    return {
      workspaceId,
      ownerEmail,
      enabled: false,
      exists: false,
      html: '',
      text: '',
      updatedBy: null,
      updatedAt: null,
      maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
    };
  }
  return {
    workspaceId: row.workspaceId,
    ownerEmail: row.ownerEmail,
    enabled: row.enabled === true,
    exists: true,
    html: row.html || '',
    text: row.text || '',
    updatedBy: row.updatedBy || null,
    updatedAt: row.updatedAt || null,
    maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES,
  };
}

/**
 * Resolve which workspace a self-service request targets: an explicit
 * workspaceId wins (coordinators pass their selected workspace); otherwise
 * fall back to the caller's active technician profile (agent-portal pattern —
 * the Notifications page doesn't always carry a workspace).
 */
export async function resolveSignatureWorkspaceId(email, workspaceId = null) {
  if (workspaceId !== undefined && workspaceId !== null && String(workspaceId).trim() !== '') {
    return normalizeWorkspaceId(workspaceId);
  }
  const normalized = normalizeOwnerEmail(email);
  const technician = await prisma.technician?.findFirst?.({
    where: {
      email: { equals: normalized, mode: 'insensitive' },
      isActive: true,
      workspace: { isActive: true },
    },
    orderBy: [{ workspaceId: 'asc' }],
    select: { workspaceId: true },
  });
  if (!technician) {
    throw new ValidationError('workspaceId is required (no technician profile to infer it from)');
  }
  return technician.workspaceId;
}

export async function getSignature(workspaceId, ownerEmail) {
  const wsId = normalizeWorkspaceId(workspaceId);
  const email = normalizeOwnerEmail(ownerEmail);
  const client = signatureClient();
  const row = client?.findUnique
    ? await client.findUnique({ where: { workspaceId_ownerEmail: { workspaceId: wsId, ownerEmail: email } } })
    : null;
  return serializeSignature(row, { workspaceId: wsId, ownerEmail: email });
}

export async function saveSignature(workspaceId, ownerEmail, input = {}, actor = null) {
  const wsId = normalizeWorkspaceId(workspaceId);
  const email = normalizeOwnerEmail(ownerEmail);
  const client = signatureClient();
  if (!client?.upsert) throw new NotFoundError('User signatures are not available in this environment');

  const existing = client.findUnique
    ? await client.findUnique({ where: { workspaceId_ownerEmail: { workspaceId: wsId, ownerEmail: email } } })
    : null;

  const html = input.html !== undefined
    ? sanitizeSignatureHtml(input.html || '')
    : String(existing?.html || '');
  const text = input.text !== undefined
    ? String(input.text || '').trim()
    : (input.html !== undefined ? stripHtml(html) : String(existing?.text || ''));
  const enabled = input.enabled !== undefined
    ? input.enabled === true || input.enabled === 'true'
    : existing?.enabled !== false;
  const updatedBy = actorEmail(actor) || email;

  const row = await client.upsert({
    where: { workspaceId_ownerEmail: { workspaceId: wsId, ownerEmail: email } },
    create: { workspaceId: wsId, ownerEmail: email, enabled, html, text, updatedBy },
    update: { enabled, html, text, updatedBy },
  });
  return serializeSignature(row);
}

export async function setSignatureEnabled(workspaceId, ownerEmail, enabled, actor = null) {
  return saveSignature(workspaceId, ownerEmail, { enabled: enabled === true }, actor);
}

/**
 * The send-path lookup: returns { html, text } only when the owner has an
 * ENABLED signature with content in this workspace, else null. Never throws
 * for a missing model/row — a broken signature must not block a reply.
 */
export async function getEnabledSignatureForSend(workspaceId, ownerEmail) {
  try {
    const email = String(ownerEmail || '').trim().toLowerCase();
    if (!email || !email.includes('@')) return null;
    const wsId = Number.parseInt(workspaceId, 10);
    if (!Number.isFinite(wsId) || wsId <= 0) return null;
    const client = signatureClient();
    if (!client?.findUnique) return null;
    const row = await client.findUnique({
      where: { workspaceId_ownerEmail: { workspaceId: wsId, ownerEmail: email } },
    });
    if (!row || row.enabled !== true || !hasContent(row)) return null;
    return {
      html: String(row.html || '').trim(),
      text: String(row.text || stripHtml(row.html)).trim(),
    };
  } catch (err) {
    logger.warn(`Signature lookup failed for ${ownerEmail} in ws ${workspaceId} (reply sends unsigned): ${err.message}`);
    return null;
  }
}

/**
 * Append a signature to an outbound email body ({ html, text }). The html
 * gets a blank-line separator; the text variant uses the classic "-- "
 * signature delimiter. No-op when the signature is empty.
 */
export function appendSignatureToEmail(email = {}, signature = null) {
  const signatureHtml = String(signature?.html || '').trim();
  const signatureText = String(signature?.text || stripHtml(signatureHtml)).trim();
  if (!signatureHtml && !signatureText) return { ...email };

  const baseHtml = String(email.html || '').trim();
  const baseText = String(email.text || stripHtml(email.html)).trim();
  const html = baseHtml
    ? `${baseHtml}<br><br>${signatureHtml || signatureText}`
    : (signatureHtml || signatureText);
  const text = baseText
    ? `${baseText}\n\n-- \n${signatureText}`
    : signatureText;
  return { ...email, html, text };
}

// ------------------------------------------------------------ admin surface

/**
 * Workspace member list joined with signatures (Settings → Signatures).
 * Active members first — mirrors the Members panel's default emphasis.
 */
export async function listWorkspaceSignatures(workspaceId) {
  const wsId = normalizeWorkspaceId(workspaceId);
  const technicians = await prisma.technician.findMany({
    where: { workspaceId: wsId },
    select: {
      id: true,
      name: true,
      email: true,
      photoUrl: true,
      isActive: true,
      origin: true,
    },
    orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
  });
  const client = signatureClient();
  const rows = client?.findMany ? await client.findMany({ where: { workspaceId: wsId } }) : [];
  const byEmail = new Map(rows.map((row) => [String(row.ownerEmail || '').toLowerCase(), row]));

  const members = technicians.map((tech) => {
    const email = String(tech.email || '').trim().toLowerCase();
    const row = email ? byEmail.get(email) : null;
    if (row) byEmail.delete(email);
    return {
      technicianId: tech.id,
      name: tech.name,
      email: tech.email || null,
      photoUrl: tech.photoUrl || null,
      isActive: tech.isActive === true,
      origin: tech.origin || 'freshservice',
      signature: row ? serializeSignature(row) : null,
    };
  });

  // Signatures owned by non-technician users (coordinators/admins who reply).
  const others = [...byEmail.values()].map((row) => ({
    technicianId: null,
    name: row.ownerEmail,
    email: row.ownerEmail,
    photoUrl: null,
    isActive: true,
    origin: 'member',
    signature: serializeSignature(row),
  }));

  return { members: [...members, ...others], maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES };
}

/** Substitute {{name}} / {{title}} / {{email}} tokens (whitespace-tolerant). */
export function applySignatureTemplate(template, fields = {}) {
  return String(template || '').replace(TEMPLATE_VARIABLE_PATTERN, (match, key) => {
    const value = fields[String(key).toLowerCase()];
    return value === undefined || value === null ? '' : String(value);
  });
}

async function resolveTemplateTargets(workspaceId, technicianIds = []) {
  const ids = [...new Set((technicianIds || []).map((id) => Number.parseInt(id, 10)).filter((id) => Number.isFinite(id) && id > 0))];
  if (!ids.length) throw new ValidationError('Select at least one member to apply the template to');
  const technicians = await prisma.technician.findMany({
    where: { workspaceId, id: { in: ids } },
    select: { id: true, name: true, email: true },
  });
  if (!technicians.length) throw new ValidationError('None of the selected members belong to this workspace');
  return technicians;
}

async function buildTemplateFields(technician) {
  const email = String(technician.email || '').trim();
  let title = null;
  if (email && azureAdService.isConfigured?.()) {
    const profile = await azureAdService.getUserProfile(email).catch(() => null);
    title = profile?.jobTitle || null;
  }
  return {
    name: technician.name || email || '',
    title: title || '',
    email,
  };
}

/**
 * Mass-apply a signature template to selected workspace members.
 * `preview: true` renders per-member substituted signatures WITHOUT writing —
 * the admin sees exactly what each person gets before committing.
 */
export async function massApplySignatureTemplate(workspaceId, { template, technicianIds, preview = false } = {}, actor = null) {
  const wsId = normalizeWorkspaceId(workspaceId);
  const rawTemplate = String(template || '').trim();
  if (!rawTemplate) throw new ValidationError('A signature template is required');
  // Sanitize the template once up front so a bad paste fails before any write.
  sanitizeSignatureHtml(rawTemplate);

  const technicians = await resolveTemplateTargets(wsId, technicianIds);
  const results = [];
  const skipped = [];

  for (const technician of technicians) {
    if (!technician.email) {
      skipped.push({ technicianId: technician.id, name: technician.name, reason: 'No email on file' });
      continue;
    }
    const fields = await buildTemplateFields(technician);
    const html = sanitizeSignatureHtml(applySignatureTemplate(rawTemplate, fields));
    const text = stripHtml(html);
    if (preview) {
      results.push({ technicianId: technician.id, name: technician.name, email: fields.email, html, text });
      continue;
    }
    const saved = await saveSignature(wsId, technician.email, { html, text, enabled: true }, actor);
    results.push({ technicianId: technician.id, name: technician.name, email: fields.email, html: saved.html, text: saved.text });
  }

  return { preview: preview === true, applied: preview ? 0 : results.length, results, skipped };
}

export default {
  serializeSignature,
  resolveSignatureWorkspaceId,
  getSignature,
  saveSignature,
  setSignatureEnabled,
  getEnabledSignatureForSend,
  appendSignatureToEmail,
  listWorkspaceSignatures,
  applySignatureTemplate,
  massApplySignatureTemplate,
};
