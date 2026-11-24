import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import anthropicProvider from './aiProviders/anthropicProvider.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import {
  emailDomain, extractFromRules, fileExtension, formatAttachmentName, isFreeMailDomain,
  isInternalDomain, isNameableDocument, isPaymentPlatformDomain, isPdf, normaliseEditedName,
  pacificDate, shownName, uniqueName, validIsoDate, vendorFromEditedName, withNameFields,
} from './attachmentNamingRules.js';

export { withNameFields };

/**
 * Attachment display names (4.4.08): automatic vendor names for documents that
 * arrive by e-mail, with Revert and Edit.
 *
 * - Runs in the background after mailboxIngestService stores an e-mail file.
 *   Mail intake never waits for it. At most 2 jobs run at a time, and a
 *   ticket's files are named one after another so two of them never get the
 *   same name.
 * - The first pass uses rules (attachmentNamingRules.js) and the learned vendor
 *   list. For a PDF, Claude reads the document unless the rules alone give a
 *   vendor AND an invoice number with high confidence.
 * - Only `display_name` and friends change. `file_name`, the stored blob and
 *   the FreshService mirror keep the original name.
 *
 * Claude is called through the official SDK directly (structured output with a
 * PDF document block), using the AI provider layer's Anthropic client and key
 * (anthropicProvider.getClient()). The provider gateway's failover can fall
 * back to OpenAI, which has no document blocks in this shape, so it is not
 * used. Usage is recorded in ai_provider_attempts (operation
 * 'attachment_naming'), which feeds the token usage report.
 */

export const OPERATION = 'attachment_naming';
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MAX_AI_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_CONCURRENT = 2;
const ACTOR_NAME = 'Ticket Pulse';

export const modeKey = (workspaceId) => `attachment_naming_ws${Number(workspaceId) || 0}`;
export const aliasesKey = (workspaceId) => `attachment_vendor_aliases_ws${Number(workspaceId) || 0}`;
export const MODEL_KEY = 'attachment_naming_model';

const soft = async (fn, fallback) => {
  try { return await fn(); } catch { return fallback; }
};

// --------------------------------------------------------------- settings

export async function namingMode(workspaceId) {
  const raw = await soft(() => settingsRepository.get(modeKey(workspaceId)), null);
  return String(raw || '').trim().toLowerCase() === 'live' ? 'live' : 'off';
}

export async function readAliases(workspaceId) {
  const raw = await soft(() => settingsRepository.get(aliasesKey(workspaceId)), null);
  if (!raw) return {};
  try {
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

async function namingModel() {
  const raw = await soft(() => settingsRepository.get(MODEL_KEY), null);
  return String(raw || '').trim() || DEFAULT_MODEL;
}

async function internalDomainsFor(workspaceId) {
  const ws = await soft(() => prisma.workspace.findUnique({ where: { id: workspaceId }, select: { internalDomains: true } }), null);
  return (ws?.internalDomains || []).map((d) => String(d).toLowerCase());
}

// ------------------------------------------------------------- Claude read

const AI_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['vendor', 'invoiceNumber', 'documentDate', 'confidence'],
  properties: {
    vendor: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    invoiceNumber: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    documentDate: { anyOf: [{ type: 'string' }, { type: 'null' }] },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] },
  },
};

export function buildPrompt({ subject, senderName, senderDomain, fileName, rules, internalDomains = [] }) {
  const guess = [
    rules?.vendor ? `vendor "${rules.vendor.value}"` : null,
    rules?.invoice ? `invoice "${rules.invoice.value}"` : null,
  ].filter(Boolean).join(', ') || 'nothing';
  const us = internalDomains.length ? ` (our company, e-mail domain ${internalDomains.slice(0, 3).join(', ')})` : '';
  return [
    'This PDF arrived by e-mail in an accounts inbox. Read it and say who issued it.',
    `E-mail subject: ${String(subject || '').slice(0, 300) || '(none)'}`,
    `Sender: ${senderName || '(no name)'}${senderDomain ? ` <${senderDomain}>` : ''}`,
    `Original file name: ${fileName}`,
    `First guess from simple rules (may be wrong): ${guess}`,
    '',
    'Return:',
    `- vendor: the company that issued the document, written as on the document (its letterhead or "from"). Never the recipient${us}, and never a payment or billing platform such as Balance, QuickBooks, Bill.com or Xero: name the business it was sent for. null when unclear.`,
    '- invoiceNumber: the invoice or document number exactly as printed, or null.',
    '- documentDate: the invoice or statement date as YYYY-MM-DD, or null.',
    '- confidence: high, medium or low, for the vendor.',
  ].join('\n');
}

/** Validate Claude's parsed answer. Returns the clean object, or null when it isn't one. */
export function validateAiAnswer(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!['high', 'medium', 'low'].includes(value.confidence)) return null;
  const str = (v, max) => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') return undefined;
    const t = v.trim();
    return t && t.length <= max ? t : null;
  };
  const vendor = str(value.vendor, 120);
  const invoiceNumber = str(value.invoiceNumber, 60);
  if (vendor === undefined || invoiceNumber === undefined) return null;
  if (value.documentDate !== null && value.documentDate !== undefined && typeof value.documentDate !== 'string') return null;
  return { vendor, invoiceNumber, documentDate: validIsoDate(value.documentDate), confidence: value.confidence };
}

function classifyAnthropicError(err) {
  // Most specific first. APIConnectionError extends APIError (with no status),
  // so the status branch only takes errors that carry one.
  if (err instanceof Anthropic.RateLimitError) return { errorClass: 'rate_limit', retryable: true };
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return { errorClass: `api_${err.status}`, retryable: err.status >= 500 || err.status === 408 || err.status === 409 };
  }
  if (err instanceof Anthropic.APIConnectionError) return { errorClass: 'connection', retryable: true };
  return { errorClass: 'unknown', retryable: false };
}

async function recordAttempt({ workspaceId, model, status, startedAt, response = null, errorClass = null, errorMessage = null, meta = {} }) {
  const usage = response?.usage || {};
  await soft(() => prisma.aiProviderAttempt.create({
    data: {
      workspaceId,
      operation: OPERATION,
      provider: 'anthropic',
      model,
      attemptNumber: 1,
      status,
      errorClass,
      errorMessage: errorMessage ? String(errorMessage).slice(0, 1000) : null,
      startedAt,
      completedAt: new Date(),
      durationMs: Date.now() - startedAt.getTime(),
      inputTokens: usage.input_tokens ?? null,
      outputTokens: usage.output_tokens ?? null,
      cacheCreationInputTokens: usage.cache_creation_input_tokens ?? null,
      cacheReadInputTokens: usage.cache_read_input_tokens ?? null,
      rawMetadata: { stopReason: response?.stop_reason ?? null, ...meta },
    },
  }), null);
}

let retryDelayMs = 4000;
/** Tests shorten the pause before the one retry. */
export function _setRetryDelayForTests(ms) { retryDelayMs = ms; }

/**
 * Ask Claude to read one PDF. Returns { ok: true, answer, model } or
 * { ok: false, reason } and never throws. One retry on a retryable failure.
 */
export async function readPdfWithClaude({ workspaceId, buffer, prompt, model, meta = {} }) {
  let client;
  try {
    client = anthropicProvider.getClient();
  } catch (err) {
    return { ok: false, reason: 'not_configured', message: err.message };
  }
  const request = {
    model,
    max_tokens: 1024,
    output_config: { effort: 'low', format: { type: 'json_schema', schema: AI_SCHEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: buffer.toString('base64') } },
        { type: 'text', text: prompt },
      ],
    }],
  };
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const startedAt = new Date();
    let response;
    try {
      response = await client.messages.create(request);
    } catch (err) {
      const { errorClass, retryable } = classifyAnthropicError(err);
      await recordAttempt({ workspaceId, model, status: 'failed', startedAt, errorClass, errorMessage: err?.message, meta: { ...meta, attempt } });
      logger.warn(`Attachment naming: Claude call failed (${errorClass}, attempt ${attempt}): ${err?.message}`);
      if (retryable && attempt === 1) {
        await new Promise((r) => { setTimeout(r, retryDelayMs); });
        continue;
      }
      return { ok: false, reason: errorClass };
    }
    // Check why it stopped before reading anything.
    if (response?.stop_reason === 'refusal' || response?.stop_reason === 'max_tokens') {
      await recordAttempt({ workspaceId, model, status: 'failed', startedAt, response, errorClass: response.stop_reason, meta: { ...meta, attempt } });
      return { ok: false, reason: response.stop_reason };
    }
    const text = (response?.content || []).find((b) => b?.type === 'text')?.text;
    let answer = null;
    try {
      answer = validateAiAnswer(JSON.parse(text));
    } catch {
      answer = null;
    }
    if (!answer) {
      await recordAttempt({ workspaceId, model, status: 'failed', startedAt, response, errorClass: 'invalid_output', meta: { ...meta, attempt } });
      return { ok: false, reason: 'invalid_output' };
    }
    await recordAttempt({ workspaceId, model, status: 'succeeded', startedAt, response, meta: { ...meta, attempt } });
    return { ok: true, answer, model };
  }
  return { ok: false, reason: 'exhausted' };
}

// ----------------------------------------------------------------- decide

/**
 * Combine the rules and Claude's reading into one decision. Returns null when
 * there is no vendor (leave the original name).
 * Vendor: the learned list (people's spelling) > Claude (unless low) > rules (medium or better).
 */
export function decideName({ rules, ai = null, aiModel = null, fileName, receivedAt, now = new Date() }) {
  const aiUsable = ai && ai.confidence !== 'low';
  let vendor = null;
  let usedAi = false;
  if (rules?.vendor?.from === 'vendor_list') vendor = rules.vendor.value;
  else if (aiUsable && ai.vendor) { vendor = ai.vendor; usedAi = true; }
  else if (rules?.vendor && rules.vendor.confidence !== 'low') vendor = rules.vendor.value;
  if (!vendor) return null;

  let invoiceNumber = null;
  if (ai?.invoiceNumber && (aiUsable || !rules?.invoice)) { invoiceNumber = ai.invoiceNumber; usedAi = true; } else if (rules?.invoice) invoiceNumber = rules.invoice.value;

  const docDate = ai ? validIsoDate(ai.documentDate, now) : null;
  if (docDate) usedAi = true;
  const date = docDate || pacificDate(receivedAt || now);
  const usedRules = Boolean(rules?.vendor || rules?.invoice);
  const method = usedAi ? (usedRules ? 'rules+ai' : 'ai') : 'rules';
  const confidence = usedAi && ai ? ai.confidence : (rules?.vendor?.confidence || 'medium');
  const name = formatAttachmentName({ vendor, invoiceNumber, date, ext: fileExtension(fileName) });
  if (!name) return null;
  return {
    name,
    details: {
      vendor,
      invoiceNumber: invoiceNumber || null,
      documentDate: docDate,
      dateFrom: docDate ? 'document' : 'received',
      method,
      confidence,
      ...(ai && aiModel ? { model: aiModel } : {}),
      senderDomain: rules?.senderDomain || null,
    },
  };
}

// ------------------------------------------------------------ the writes

// One ticket's files are named one after another (no two get the same name).
const ticketLocks = new Map();
async function withTicketLock(ticketId, fn) {
  const prev = ticketLocks.get(ticketId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  ticketLocks.set(ticketId, tail);
  try {
    return await run;
  } finally {
    if (ticketLocks.get(ticketId) === tail) ticketLocks.delete(ticketId);
  }
}

async function namesTakenOnTicket(ticketId, exceptId) {
  const rows = await soft(() => prisma.ticketAttachment.findMany({
    where: { ticketId, NOT: { id: exceptId } },
    select: { fileName: true, displayName: true },
  }), []);
  return rows.map((r) => r.displayName || r.fileName);
}

async function writeActivity({ ticketId, attachmentId, action, from, to, originalName, details = null, actorName, actorEmail = null }) {
  await soft(() => prisma.ticketActivity.create({
    data: {
      ticketId,
      activityType: 'attachment_renamed',
      performedBy: actorName,
      performedAt: new Date(),
      details: {
        attachmentId,
        action,
        from,
        to,
        originalName,
        vendor: details?.vendor ?? null,
        invoiceNumber: details?.invoiceNumber ?? null,
        method: details?.method ?? null,
        actorName,
        actorEmail,
      },
    },
  }), null);
}

async function broadcastRename(workspaceId, ticketId, attachmentId) {
  await soft(async () => {
    const { sseManager } = await import('../routes/sse.routes.js');
    sseManager.broadcast('ticket-change', { action: 'attachment_renamed', workspaceId, ticketId, attachmentId }, workspaceId);
  }, null);
}

/**
 * Name one stored e-mail attachment. Returns { renamed, name?, reason? }.
 * `context` = { subject, fromEmail, fromName, bodyText, receivedAt }.
 */
export async function nameAttachment(attachmentId, context = {}) {
  const row = await soft(() => prisma.ticketAttachment.findUnique({ where: { id: attachmentId } }), null);
  if (!row) return { renamed: false, reason: 'gone' };
  if (row.source !== 'email') return { renamed: false, reason: 'not_email' };
  if (row.nameSource) return { renamed: false, reason: 'already_named' };
  if (!isNameableDocument({ fileName: row.fileName, contentType: row.contentType })) return { renamed: false, reason: 'not_a_document' };
  if (await namingMode(row.workspaceId) !== 'live') return { renamed: false, reason: 'off' };

  const [aliases, internalDomains] = await Promise.all([readAliases(row.workspaceId), internalDomainsFor(row.workspaceId)]);
  let subject = context.subject;
  if (!subject) {
    const t = await soft(() => prisma.ticket.findUnique({ where: { id: row.ticketId }, select: { subject: true } }), null);
    subject = t?.subject || '';
  }
  const rules = extractFromRules({
    subject,
    fromEmail: context.fromEmail || row.uploadedBy,
    fromName: context.fromName,
    fileName: row.fileName,
    bodyText: context.bodyText,
    aliases,
    internalDomains,
  });

  let ai = null;
  let aiModel = null;
  if (isPdf(row) && !rules.rulesSufficient) {
    if (row.sizeBytes > MAX_AI_PDF_BYTES) {
      logger.info(`Attachment naming: ${row.fileName} (id ${row.id}) is over 10 MB, rules only`);
    } else {
      const { default: attachmentService } = await import('./attachmentService.js');
      const buffer = await soft(() => attachmentService.bufferFor(row), null);
      if (buffer && buffer.length <= MAX_AI_PDF_BYTES) {
        const model = await namingModel();
        const result = await readPdfWithClaude({
          workspaceId: row.workspaceId,
          buffer,
          model,
          prompt: buildPrompt({ subject, senderName: rules.senderName, senderDomain: rules.senderDomain, fileName: row.fileName, rules, internalDomains }),
          meta: { ticketId: row.ticketId, attachmentId: row.id },
        });
        if (result.ok) { ai = result.answer; aiModel = result.model; } else {
          logger.info(`Attachment naming: Claude gave no answer for ${row.fileName} (id ${row.id}): ${result.reason}; rules only`);
        }
      }
    }
  }

  const decision = decideName({ rules, ai, aiModel, fileName: row.fileName, receivedAt: context.receivedAt || row.createdAt });
  if (!decision) return { renamed: false, reason: 'no_vendor' };

  return withTicketLock(row.ticketId, async () => {
    const taken = await namesTakenOnTicket(row.ticketId, row.id);
    const name = uniqueName(decision.name, taken);
    const now = new Date();
    // Only when nobody has named it meanwhile (a person's Edit or Revert wins).
    const updated = await prisma.ticketAttachment.updateMany({
      where: { id: row.id, nameSource: null },
      data: { displayName: name, nameSource: 'auto', nameDetails: decision.details, namedAt: now, namedBy: ACTOR_NAME },
    });
    if (!updated?.count) return { renamed: false, reason: 'already_named' };
    await writeActivity({
      ticketId: row.ticketId, attachmentId: row.id, action: 'auto', from: row.fileName, to: name,
      originalName: row.fileName, details: decision.details, actorName: ACTOR_NAME,
    });
    await broadcastRename(row.workspaceId, row.ticketId, row.id);
    logger.info(`Attachment naming: ${row.fileName} (id ${row.id}, ticket ${row.ticketId}) → ${name} [${decision.details.method}]`);
    return { renamed: true, name };
  });
}

// ------------------------------------------------------------------ queue

const queue = [];
let running = 0;

function pump() {
  while (running < MAX_CONCURRENT && queue.length) {
    const job = queue.shift();
    running += 1;
    Promise.resolve()
      .then(() => nameAttachment(job.attachmentId, job.context))
      .catch((err) => logger.warn(`Attachment naming failed for attachment ${job.attachmentId} (original name kept): ${err.message}`))
      .finally(() => {
        running -= 1;
        job.resolve?.();
        pump();
      });
  }
}

/**
 * The mail-intake hook: queue a freshly stored e-mail file for naming. Cheap
 * and synchronous for the caller; it never throws. Agent uploads, FreshService
 * files and inline pictures are skipped here; the workspace switch is read in
 * the job. Returns a promise that settles when the job ends (tests await it).
 */
export function queueEmailAttachment(row, { email = null, isInline = false } = {}) {
  try {
    if (!row?.id || row.source !== 'email') return Promise.resolve(false);
    if (!isNameableDocument({ fileName: row.fileName, contentType: row.contentType, isInline })) return Promise.resolve(false);
    const context = {
      subject: email?.subject || null,
      fromEmail: email?.from || row.uploadedBy || null,
      fromName: email?.fromName || null,
      bodyText: email?.bodyText || email?.bodyPreview || null,
      receivedAt: email?.receivedAt || null,
    };
    return new Promise((resolve) => {
      queue.push({ attachmentId: row.id, context, resolve: () => resolve(true) });
      pump();
    });
  } catch (err) {
    logger.warn(`Attachment naming not queued: ${err.message}`);
    return Promise.resolve(false);
  }
}

export const _queueStateForTests = () => ({ running, waiting: queue.length });

// ------------------------------------------------------------ Revert / Edit

async function teachVendor(row, vendor, details) {
  const domain = String(details?.senderDomain || emailDomain(row.uploadedBy) || '').toLowerCase();
  if (!vendor || !domain || row.source !== 'email') return false;
  const internalDomains = await internalDomainsFor(row.workspaceId);
  if (isInternalDomain(domain, internalDomains) || isFreeMailDomain(domain) || isPaymentPlatformDomain(domain)) return false;
  const aliases = await readAliases(row.workspaceId);
  if (aliases[domain] === vendor) return false;
  aliases[domain] = vendor;
  await soft(() => settingsRepository.set(aliasesKey(row.workspaceId), JSON.stringify(aliases)), null);
  logger.info(`Attachment naming: vendor list learned ${domain} → ${vendor} (workspace ${row.workspaceId})`);
  return true;
}

/**
 * Revert or Edit one attachment's name, from the ticket page.
 * Returns the attachment with its name fields.
 */
export async function applyManualName({ ticketId, attachmentId, workspaceId, action, name, actor }) {
  if (!['revert', 'edit'].includes(action)) throw new ValidationError('Unknown action. Use "revert" or "edit".');
  const row = await prisma.ticketAttachment.findFirst({ where: { id: attachmentId, ticketId, workspaceId } });
  if (!row) throw new NotFoundError('Attachment not found');
  const actorName = actor?.name || actor?.email || 'Someone';
  const actorEmail = actor?.email || null;
  const before = shownName(row);

  if (action === 'revert') {
    if (!row.displayName) return withNameFields(row);
    const updated = await prisma.ticketAttachment.update({
      where: { id: row.id },
      data: { displayName: null, nameSource: 'reverted', namedAt: new Date(), namedBy: actorName },
    });
    await writeActivity({
      ticketId, attachmentId: row.id, action: 'revert', from: before, to: row.fileName,
      originalName: row.fileName, details: row.nameDetails, actorName, actorEmail,
    });
    return withNameFields(updated);
  }

  const normalised = normaliseEditedName(name, row.fileName);
  if (!normalised) throw new ValidationError('Type a name for the file.');
  return withTicketLock(ticketId, async () => {
    const taken = await namesTakenOnTicket(ticketId, row.id);
    const finalName = uniqueName(normalised, taken);
    const vendor = vendorFromEditedName(finalName);
    const prev = row.nameDetails && typeof row.nameDetails === 'object' ? row.nameDetails : {};
    const details = { ...prev, vendor: vendor || prev.vendor || null, method: 'manual' };
    const updated = await prisma.ticketAttachment.update({
      where: { id: row.id },
      data: { displayName: finalName, nameSource: 'manual', nameDetails: details, namedAt: new Date(), namedBy: actorName },
    });
    await writeActivity({
      ticketId, attachmentId: row.id, action: 'edit', from: before, to: finalName,
      originalName: row.fileName, details, actorName, actorEmail,
    });
    if (vendor) await teachVendor(row, vendor, prev);
    return withNameFields(updated);
  });
}

export default {
  queueEmailAttachment,
  nameAttachment,
  applyManualName,
  withNameFields,
  readAliases,
  namingMode,
};
