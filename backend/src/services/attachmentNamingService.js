import Anthropic from '@anthropic-ai/sdk';
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import anthropicProvider from './aiProviders/anthropicProvider.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';
import {
  aliasEntryFor, emailDomain, extensionFor, extractFromRules, formatAttachmentName, isFreeMailDomain,
  isInternalDomain, isNameableDocument, isPaymentPlatformDomain, isPdf, normaliseEditedName,
  pacificDate, plausibleVendor, sameVendor, shownName, uniqueName, validIsoDate, vendorFromEditedName,
  withNameFields,
} from './attachmentNamingRules.js';

export { withNameFields };

/**
 * Attachment display names (4.4.08): automatic vendor names for documents that
 * arrive by e-mail, with Revert and Edit.
 *
 * - Runs in the background after mailboxIngestService stores an e-mail file.
 *   Mail intake never waits for it. At most 2 jobs run at a time (queue capped
 *   at 500), and a ticket's files are named one after another so two of them
 *   never get the same name. A catch-up on boot and once a day picks up files
 *   from the last 48 hours that a restart left unchecked.
 * - The first pass uses rules (attachmentNamingRules.js) and the learned vendor
 *   list. For a PDF, Claude reads the document unless the mail itself gives a
 *   vendor AND an invoice number with high confidence (the vendor list alone
 *   never skips Claude, and a high-confidence Claude vendor that disagrees with
 *   the list wins).
 * - Only `display_name` and friends change. `file_name`, the stored blob and
 *   the FreshService mirror keep the original name.
 *
 * Claude is called through the official SDK directly (structured output with a
 * PDF document block), using the AI provider layer's Anthropic client and key
 * (anthropicProvider.getClient()). The provider gateway's failover can fall
 * back to OpenAI, which has no document blocks in this shape, so it is not
 * used. Every attempt is recorded in ai_provider_attempts (operation
 * 'attachment_naming'), which feeds the token usage report.
 */

export const OPERATION = 'attachment_naming';
export const DEFAULT_MODEL = 'claude-opus-5-5';
export const MAX_AI_PDF_BYTES = 10 * 1024 * 1024;
export const MAX_CONCURRENT = 2;
export const MAX_QUEUE = 500;
export const CLAUDE_TIMEOUT_MS = 60_000;
export const CATCH_UP_HOURS = 48;
export const CATCH_UP_LIMIT = 500;
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

/** The learned vendor list: { "<domain>": { vendor, learnedAt, by } } (bare strings from older writes read too). */
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

async function writeAliases(workspaceId, aliases) {
  await soft(() => settingsRepository.set(aliasesKey(workspaceId), JSON.stringify(aliases)), null);
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
    ...(rules?.subjectInvoiceHint
      ? [`The subject mentions number ${rules.subjectInvoiceHint}, but the mail had several documents: use it only if it is printed on this one.`]
      : []),
    '',
    'Return:',
    `- vendor: the company that issued the document, written as on the document (its letterhead or "from"). Never the recipient${us}, and never a payment or billing platform such as Balance, QuickBooks, Bill.com or Xero: name the business it was sent for. null when unclear.`,
    '- invoiceNumber: the invoice or document number exactly as printed on this document, or null.',
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
  // so the status branch only takes errors that carry one. Retry only rate
  // limits, 5xx and connection failures (timeouts are connection errors).
  if (err instanceof Anthropic.RateLimitError) return { errorClass: 'rate_limit', retryable: true };
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return { errorClass: `api_${err.status}`, retryable: err.status >= 500 };
  }
  if (err instanceof Anthropic.APIConnectionError) return { errorClass: 'connection', retryable: true };
  return { errorClass: 'unknown', retryable: false };
}

async function recordAttempt({ workspaceId, model, attemptNumber, status, startedAt, response = null, errorClass = null, errorMessage = null, meta = {} }) {
  const usage = response?.usage || {};
  await soft(() => prisma.aiProviderAttempt.create({
    data: {
      workspaceId,
      operation: OPERATION,
      provider: 'anthropic',
      model,
      attemptNumber,
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
 * { ok: false, reason } and never throws. 60 s per attempt, no SDK retries;
 * our own single retry for rate limits, 5xx and connection failures. Every
 * attempt is recorded.
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
      response = await client.messages.create(request, { timeout: CLAUDE_TIMEOUT_MS, maxRetries: 0 });
    } catch (err) {
      const { errorClass, retryable } = classifyAnthropicError(err);
      await recordAttempt({ workspaceId, model, attemptNumber: attempt, status: 'failed', startedAt, errorClass, errorMessage: err?.message, meta });
      logger.warn(`Attachment naming: Claude call failed (${errorClass}, attempt ${attempt}): ${err?.message}`);
      if (retryable && attempt === 1) {
        await new Promise((r) => { setTimeout(r, retryDelayMs); });
        continue;
      }
      return { ok: false, reason: errorClass };
    }
    // Check why it stopped before reading anything.
    if (response?.stop_reason === 'refusal' || response?.stop_reason === 'max_tokens') {
      await recordAttempt({ workspaceId, model, attemptNumber: attempt, status: 'failed', startedAt, response, errorClass: response.stop_reason, meta });
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
      await recordAttempt({ workspaceId, model, attemptNumber: attempt, status: 'failed', startedAt, response, errorClass: 'invalid_output', meta });
      return { ok: false, reason: 'invalid_output' };
    }
    await recordAttempt({ workspaceId, model, attemptNumber: attempt, status: 'succeeded', startedAt, response, meta });
    return { ok: true, answer, model };
  }
  return { ok: false, reason: 'exhausted' };
}

// ----------------------------------------------------------------- decide

/**
 * Combine the rules and Claude's reading into one decision. Returns
 * { name, details } or null when there is no vendor (leave the original name).
 * Vendor: the learned list (people's spelling) unless a high-confidence
 * Claude vendor disagrees with it; else Claude (unless low); else the rules
 * (medium or better). Claude's vendor is filtered like any other candidate
 * (not generic, not our own company, not a payment platform).
 */
export function decideName({ rules, ai = null, aiModel = null, fileName, contentType = null, receivedAt, internalDomains = [], now = new Date() }) {
  const aiVendor = ai?.vendor ? plausibleVendor(ai.vendor, internalDomains) : null;
  const aiUsable = Boolean(ai) && ai.confidence !== 'low';
  let vendor = null;
  let vendorFrom = null;
  if (rules?.vendor?.from === 'vendor_list') {
    if (aiVendor && ai.confidence === 'high' && !sameVendor(aiVendor, rules.vendor.value)) {
      vendor = aiVendor; vendorFrom = 'ai';
    } else {
      vendor = rules.vendor.value; vendorFrom = 'vendor_list';
    }
  } else if (aiUsable && aiVendor) {
    vendor = aiVendor; vendorFrom = 'ai';
  } else if (rules?.vendor && rules.vendor.confidence !== 'low') {
    vendor = rules.vendor.value; vendorFrom = rules.vendor.from;
  }
  if (!vendor) return null;

  let usedAi = vendorFrom === 'ai';
  let invoiceNumber = null;
  if (ai?.invoiceNumber && (aiUsable || !rules?.invoice)) { invoiceNumber = ai.invoiceNumber; usedAi = true; } else if (rules?.invoice) invoiceNumber = rules.invoice.value;

  const docDate = ai ? validIsoDate(ai.documentDate, now) : null;
  if (docDate) usedAi = true;
  const date = docDate || pacificDate(receivedAt || now);
  const usedRules = Boolean(rules?.vendor || rules?.invoice);
  const method = usedAi ? (usedRules ? 'rules+ai' : 'ai') : 'rules';
  const confidence = vendorFrom === 'ai' ? ai.confidence : (rules?.vendor?.confidence || 'medium');
  const name = formatAttachmentName({ vendor, invoiceNumber, date, ext: extensionFor(fileName, contentType) });
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
      vendorFrom,
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

/** How many documents the same mail carried (catch-up jobs have no e-mail in hand). */
async function documentsInSameMail(row) {
  const rows = await soft(() => prisma.ticketAttachment.findMany({
    where: { ticketId: row.ticketId, threadEntryId: row.threadEntryId ?? null, source: 'email' },
    select: { id: true, fileName: true, contentType: true, createdAt: true },
  }), null);
  if (!Array.isArray(rows)) return 1;
  const at = new Date(row.createdAt || 0).getTime();
  const near = rows.filter((r) => Math.abs(new Date(r.createdAt || 0).getTime() - at) <= 5 * 60_000
    && isNameableDocument({ fileName: r.fileName, contentType: r.contentType }));
  return Math.max(1, near.length);
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
 * `context` = { subject, fromEmail, fromName, bodyText, receivedAt, documentCount }.
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
  const documentCount = Number(context.documentCount) > 0 ? Number(context.documentCount) : await documentsInSameMail(row);
  const rules = extractFromRules({
    subject,
    fromEmail: context.fromEmail || row.uploadedBy,
    fromName: context.fromName,
    fileName: row.fileName,
    bodyText: context.bodyText,
    aliases,
    internalDomains,
    documentCount,
  });

  let ai = null;
  let aiModel = null;
  let aiFailed = false;
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
          aiFailed = true;
          logger.info(`Attachment naming: Claude gave no answer for ${row.fileName} (id ${row.id}): ${result.reason}; rules only`);
        }
      } else {
        aiFailed = true;
      }
    }
  }

  const decision = decideName({
    rules, ai, aiModel, fileName: row.fileName, contentType: row.contentType,
    receivedAt: context.receivedAt || row.createdAt, internalDomains,
  });
  if (!decision) {
    // Checked, nothing found: say so, so the catch-up never asks again. A
    // failed Claude read is left unmarked so the next catch-up retries it.
    if (!aiFailed) {
      await soft(() => prisma.ticketAttachment.updateMany({
        where: { id: row.id, nameSource: null },
        data: {
          nameDetails: {
            vendor: null,
            invoiceNumber: ai?.invoiceNumber || rules.invoice?.value || null,
            outcome: 'no_vendor',
            checkedAt: new Date().toISOString(),
            ...(aiModel ? { model: aiModel } : {}),
            senderDomain: rules.senderDomain || null,
          },
        },
      }), null);
    }
    return { renamed: false, reason: aiFailed ? 'no_vendor_ai_failed' : 'no_vendor' };
  }

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
const queuedIds = new Set();
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
        queuedIds.delete(job.attachmentId);
        job.resolve?.();
        pump();
      });
  }
}

/**
 * The mail-intake hook: queue a freshly stored e-mail file for naming. Cheap
 * and synchronous for the caller; it never throws. Agent uploads, FreshService
 * files and inline pictures are skipped here; the workspace switch is read in
 * the job. Returns a promise that settles when the job ends (tests await it):
 * true when it ran, false when it was not queued.
 */
export function queueEmailAttachment(row, { email = null, isInline = false, documentCount = null } = {}) {
  try {
    if (!row?.id || row.source !== 'email') return Promise.resolve(false);
    if (!isNameableDocument({ fileName: row.fileName, contentType: row.contentType, isInline })) return Promise.resolve(false);
    if (queuedIds.has(row.id)) return Promise.resolve(false);
    if (queue.length >= MAX_QUEUE) {
      logger.warn(`Attachment naming queue is full (${MAX_QUEUE}); attachment ${row.id} keeps its original name for now (the daily catch-up retries it)`);
      return Promise.resolve(false);
    }
    const context = {
      subject: email?.subject || null,
      fromEmail: email?.from || row.uploadedBy || null,
      fromName: email?.fromName || null,
      bodyText: email?.bodyText || email?.bodyPreview || null,
      receivedAt: email?.receivedAt || null,
      documentCount: Number(documentCount) > 0 ? Number(documentCount) : null,
    };
    queuedIds.add(row.id);
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

/**
 * Catch-up after a restart (and once a day): e-mail documents from the last
 * 48 hours in live workspaces that were never checked (no name source, no
 * name details). Bounded at 500 per run. Returns { workspaces, found, queued }.
 */
export async function catchUpRecentAttachments({ hours = CATCH_UP_HOURS, limit = CATCH_UP_LIMIT, now = new Date() } = {}) {
  const settingsRows = await soft(() => prisma.appSettings.findMany({
    where: { key: { startsWith: 'attachment_naming_ws' } },
    select: { key: true, value: true },
  }), []);
  const workspaceIds = (settingsRows || [])
    .filter((s) => String(s.value || '').trim().toLowerCase() === 'live')
    .map((s) => Number(String(s.key).replace('attachment_naming_ws', '')))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (!workspaceIds.length) return { workspaces: 0, found: 0, queued: 0 };

  const since = new Date(now.getTime() - hours * 3600_000);
  const rows = await soft(() => prisma.ticketAttachment.findMany({
    where: { workspaceId: { in: workspaceIds }, source: 'email', nameSource: null, createdAt: { gte: since } },
    orderBy: { id: 'asc' },
    take: limit * 4,
    select: { id: true, workspaceId: true, ticketId: true, fileName: true, contentType: true, source: true, uploadedBy: true, nameDetails: true },
  }), []);
  const unchecked = (rows || [])
    .filter((r) => r.nameDetails === null || r.nameDetails === undefined)
    .filter((r) => isNameableDocument({ fileName: r.fileName, contentType: r.contentType }))
    .slice(0, limit);
  let queued = 0;
  for (const r of unchecked) {
    if (queuedIds.has(r.id) || queue.length >= MAX_QUEUE) continue;
    queueEmailAttachment(r).catch(() => {});
    queued += 1;
  }
  if (unchecked.length) logger.info(`Attachment naming catch-up: ${unchecked.length} unchecked file(s) in ${workspaceIds.length} workspace(s), ${queued} queued`);
  return { workspaces: workspaceIds.length, found: unchecked.length, queued };
}

// ------------------------------------------------------------ Revert / Edit

/** Learn domain → vendor from a person's edit. Never for internal, free-mail or platform domains. */
async function teachVendor(row, vendor, details, actorName) {
  const domain = String(details?.senderDomain || emailDomain(row.uploadedBy) || '').toLowerCase();
  if (!vendor || !domain || row.source !== 'email') return false;
  const internalDomains = await internalDomainsFor(row.workspaceId);
  if (isInternalDomain(domain, internalDomains) || isFreeMailDomain(domain) || isPaymentPlatformDomain(domain)) return false;
  const aliases = await readAliases(row.workspaceId);
  const current = aliases[domain];
  if ((typeof current === 'string' ? current : current?.vendor) === vendor) return false;
  aliases[domain] = { vendor, learnedAt: new Date().toISOString(), by: actorName };
  await writeAliases(row.workspaceId, aliases);
  logger.info(`Attachment naming: vendor list learned ${domain} → ${vendor} (workspace ${row.workspaceId})`);
  return true;
}

/** A Revert of a name that came from the vendor list removes that list entry. */
async function forgetVendor(row) {
  const details = row.nameDetails && typeof row.nameDetails === 'object' ? row.nameDetails : null;
  if (row.nameSource !== 'auto' || details?.vendorFrom !== 'vendor_list' || !details.senderDomain) return false;
  const aliases = await readAliases(row.workspaceId);
  const entry = aliasEntryFor(details.senderDomain, aliases);
  if (!entry || !sameVendor(entry.vendor, details.vendor)) return false;
  delete aliases[entry.key];
  await writeAliases(row.workspaceId, aliases);
  logger.info(`Attachment naming: vendor list forgot ${entry.key} → ${entry.vendor} after a Revert (workspace ${row.workspaceId})`);
  return true;
}

/**
 * Revert or Edit one attachment's name, from the ticket page.
 * Returns the attachment with its name fields.
 */
export async function applyManualName({ ticketId, attachmentId, workspaceId, action, name, actor }) {
  if (!['revert', 'edit'].includes(action)) throw new ValidationError('Unknown action. Use "revert" or "edit".');
  if (action === 'edit' && typeof name !== 'string') throw new ValidationError('Type a name for the file.');
  const row = await prisma.ticketAttachment.findFirst({ where: { id: attachmentId, ticketId, workspaceId } });
  if (!row) throw new NotFoundError('Attachment not found');
  const actorName = actor?.name || actor?.email || 'Someone';
  const actorEmail = actor?.email || null;
  const before = shownName(row);

  if (action === 'revert') {
    if (!row.displayName) return withNameFields(row);
    const snapshot = { ...row }; // as it was, for the vendor-list check after the write
    const updated = await prisma.ticketAttachment.update({
      where: { id: row.id },
      data: { displayName: null, nameSource: 'reverted', namedAt: new Date(), namedBy: actorName },
    });
    await writeActivity({
      ticketId, attachmentId: row.id, action: 'revert', from: before, to: row.fileName,
      originalName: row.fileName, details: row.nameDetails, actorName, actorEmail,
    });
    await soft(() => forgetVendor(snapshot), false);
    return withNameFields(updated);
  }

  const normalised = normaliseEditedName(name, row.fileName, row.contentType);
  if (!normalised) throw new ValidationError('Type a name for the file.');
  const internalDomains = await internalDomainsFor(workspaceId);
  return withTicketLock(ticketId, async () => {
    const taken = await namesTakenOnTicket(ticketId, row.id);
    const finalName = uniqueName(normalised, taken);
    const vendor = vendorFromEditedName(finalName, internalDomains);
    const prev = row.nameDetails && typeof row.nameDetails === 'object' ? row.nameDetails : {};
    const details = { ...prev, vendor: vendor || prev.vendor || null, method: 'manual' };
    delete details.outcome;
    const updated = await prisma.ticketAttachment.update({
      where: { id: row.id },
      data: { displayName: finalName, nameSource: 'manual', nameDetails: details, namedAt: new Date(), namedBy: actorName },
    });
    await writeActivity({
      ticketId, attachmentId: row.id, action: 'edit', from: before, to: finalName,
      originalName: row.fileName, details, actorName, actorEmail,
    });
    if (vendor) await soft(() => teachVendor(row, vendor, prev, actorName), false);
    return withNameFields(updated);
  });
}

export default {
  queueEmailAttachment,
  nameAttachment,
  applyManualName,
  catchUpRecentAttachments,
  withNameFields,
  readAliases,
  namingMode,
};
