import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import statusService from './statusService.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { projectNumbers } from '../utils/subjectIdentity.js';
import {
  extractFromRules, fileStem, isFreeMailDomain, isInternalDomain, isNameableDocument, isPaymentPlatformDomain,
} from './attachmentNamingRules.js';

/**
 * Invoice-number matching for inbound mail (24 Nov 2026).
 *
 * Accounting's own rule: "a new matter unless it is the same document number
 * already on an open ticket". Since 4.4.08 every e-mailed document carries
 * `ticket_attachments.name_details` ({ vendor, invoiceNumber, senderDomain, … }),
 * so an inbound mail's invoice numbers can be looked up against the documents
 * already on open tickets.
 *
 *  1. The mail's (vendor, invoice number) pairs come from the naming rules
 *     (attachmentNamingRules.extractFromRules), with no AI: the subject, and
 *     each attachment's file name.
 *  2. A match is an OPEN ticket (not Resolved / Closed / Deleted / Spam, by its
 *     base status) of the same workspace, created in the last 120 days, with a
 *     document whose invoice number normalises to the same value AND whose
 *     vendor is the same: the same normalised name (or its first whole words),
 *     or, only when one side names no vendor, the same sender domain (never a
 *     billing platform, free mail or our own domain). "INV-12345" and "12345"
 *     are the same document only for exactly the same vendor name.
 *  3. Never an invoice number: fewer than 4 characters, a bare year or date, a
 *     project number (2000010.02.11), a number written as an account /
 *     customer number, or a number on documents of 8+ open tickets (the same
 *     threshold Mail triage uses for "an account number, not one matter").
 *
 * Modes per workspace (app setting `invoice_match_ws<N>`, default off):
 *   off     nothing runs
 *   shadow  every inbound mail is matched after intake decided, and the result
 *           is written beside it (thread entry `raw_payload.invoiceMatch`, or a
 *           held mail's `decision.invoiceMatch`); nothing else changes
 *   live    as shadow, and a match is a hard link for follow-up holds and Mail
 *           triage (mailboxIngestService, followUpCandidateService, mailTriageService)
 *
 * Cost: nothing at all unless the mail yields a plausible invoice number; then
 * one bounded SQL query (tickets of the workspace created in the window, not
 * closed by any status name based on Resolved / Closed, joined to their
 * attachments by ticket_id, newest first, LIMIT 200). After intake the work
 * runs through a small queue (2 at a time, 200 waiting).
 */

export const MODES = Object.freeze(['off', 'shadow', 'live']);
export const WINDOW_DAYS = 120;
export const MIN_NUMBER_CHARS = 4;
export const MAX_NUMBERS = 8;
export const MAX_ATTACHMENT_NAMES = 20;
export const MAX_ROWS = 200;
export const MAX_MATCHES = 6;
/** A number on documents of this many open tickets is an account number (Mail triage's COMMON_NUMBER_AT). */
export const COMMON_NUMBER_TICKETS = 8;
const DAY = 24 * 60 * 60 * 1000;
const MODE_CACHE_MS = 60 * 1000;
const NOT_OPEN_NAMES = ['Resolved', 'Closed', 'Deleted', 'Spam'];
const TERMINAL_BASES = ['Resolved', 'Closed'];

export const settingsKey = (workspaceId) => `invoice_match_ws${Number(workspaceId)}`;
// The learned vendor list of attachment naming (attachmentNamingService.aliasesKey).
const aliasesKey = (workspaceId) => `attachment_vendor_aliases_ws${Number(workspaceId) || 0}`;

const soft = async (fn, fallback) => {
  try { return await fn(); } catch { return fallback; }
};

// ---------------------------------------------------------------- settings

const modeCache = new Map(); // workspaceId -> { mode, at }

export function normalizeMode(raw) {
  let v = raw;
  if (typeof v === 'string') {
    const t = v.trim();
    if (t.startsWith('{')) { try { v = JSON.parse(t)?.mode; } catch { v = null; } } else v = t;
  } else if (v && typeof v === 'object') v = v.mode;
  const m = String(v || '').trim().toLowerCase();
  return MODES.includes(m) ? m : 'off';
}

/** The workspace's mode; 'off' when it cannot be read. Cached for a minute. */
export async function getMode(workspaceId, { fresh = false } = {}) {
  const ws = Number(workspaceId);
  if (!Number.isInteger(ws) || ws <= 0) return 'off';
  const hit = modeCache.get(ws);
  if (!fresh && hit && Date.now() - hit.at < MODE_CACHE_MS) return hit.mode;
  const raw = await soft(() => settingsRepository.get(settingsKey(ws)), null);
  const mode = normalizeMode(raw);
  modeCache.set(ws, { mode, at: Date.now() });
  return mode;
}

export async function setMode(workspaceId, mode) {
  const ws = Number(workspaceId);
  if (!MODES.includes(mode)) throw Object.assign(new Error('Pick Off, Shadow or Live'), { statusCode: 400 });
  await settingsRepository.set(settingsKey(ws), mode);
  modeCache.set(ws, { mode, at: Date.now() });
  return mode;
}

export function _clearModeCache() { modeCache.clear(); }

// ----------------------------------------------------------- normalisation

const ACCOUNT_WORDS = '(?:account|acct|a\\/c|customer|cust|client|member|membership|policy|meter|contract|site|location|loc)';

/** Is `number` written as an account / customer number in `text` ("Account #40021", "Acct No: 40021")? */
export function writtenAsAccount(text, number) {
  const n = String(number || '').trim();
  if (!n) return false;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`\\b${ACCOUNT_WORDS}[\\s_-]*(?:no\\.?|number|num|#|id)?[\\s_:#.-]*${escaped}(?![A-Za-z0-9])`, 'i').test(String(text || ''));
}

function compactDate(n) {
  if (!/^\d{8}$/.test(n)) return false;
  const y = Number(n.slice(0, 4)); const m = Number(n.slice(4, 6)); const d = Number(n.slice(6, 8));
  return y >= 2000 && y <= 2099 && m >= 1 && m <= 12 && d >= 1 && d <= 31;
}

/** Uppercase letters and digits, split into a leading letter prefix and the rest without leading zeros. */
function splitNumber(compact) {
  const prefix = /^[A-Z]*/.exec(compact)[0];
  const core = compact.slice(prefix.length).replace(/^0+/, '');
  return { prefix, core };
}

/**
 * An invoice number as a key: uppercase, letters and digits only, leading zeros
 * of the number part dropped (INV-000123 → INV123, 0042117 → 42117). null when
 * it is not one: shorter than 4, no digit, a bare year or a compact date, a
 * project number, or (given the text it came from) written as an account number.
 */
export function normaliseInvoiceNumber(raw, context = '') {
  const s = String(raw ?? '').trim();
  if (!s) return null;
  if (projectNumbers(s).length) return null; // 2000010.02.11, 2636058-03.01
  const compact = s.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/\d/.test(compact) || compact.length > 40) return null;
  if (/^(?:19|20)\d{2}$/.test(compact)) return null; // a year
  if (compactDate(compact)) return null;
  // A seven-digit number the text also writes as a project number (2000010 and 2000010.02).
  if (/^\d{7}$/.test(compact) && projectNumbers(context).includes(compact)) return null;
  if (context && writtenAsAccount(context, s)) return null;
  const { prefix, core } = splitNumber(compact);
  const key = `${prefix}${core}`;
  if (key.length < MIN_NUMBER_CHARS || !/\d/.test(core)) return null;
  return key;
}

/**
 * The number part of a key without its letter prefix (INV12345 → 12345): two
 * documents with the same core but different prefixes ("INV-12345" and
 * "12345") are the same document only when the vendor names are exactly equal.
 */
export function invoiceCore(key) {
  return key ? splitNumber(String(key)).core : null;
}

/** The SQL twin of invoiceCore(normalised): letters and digits, uppercase, leading letters and zeros dropped. */
const SQL_CORE = "ltrim(regexp_replace(upper(regexp_replace(coalesce(a.name_details->>'invoiceNumber', ''), '[^A-Za-z0-9]', '', 'g')), '^[A-Z]+', ''), '0')";

const VENDOR_SUFFIX = /\s+(?:inc|incorporated|ltd|limited|llc|corp|corporation|co|company|ulc)$/;

/** A vendor name's words: lowercase, punctuation gone, trailing Inc/Ltd/LLC/Corp/Co/ULC dropped. */
export function vendorWords(name) {
  let v = String(name || '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9\s]/g, ' ').replace(/\s+/g, ' ').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = v.replace(VENDOR_SUFFIX, '').trim();
    if (next === v) break;
    v = next;
  }
  return v ? v.split(' ') : [];
}

/** A vendor name as a key: its words, without spaces. */
export function normaliseVendor(name) {
  return vendorWords(name).join('');
}

/**
 * The same vendor: the same words, or the shorter name's words are the first
 * whole words of the longer one ("Northwind Traders" / "Northwind Traders
 * Canada") and the shorter has at least 5 characters. Never a part of a word
 * ("Canon" is not "Canonical").
 */
export function vendorsMatch(a, b) {
  const x = vendorWords(a);
  const y = vendorWords(b);
  if (!x.length || !y.length) return false;
  if (x.join('') === y.join('')) return true;
  const [short, long] = x.length <= y.length ? [x, y] : [y, x];
  if (short.join('').length < 5) return false;
  return short.every((w, i) => long[i] === w);
}

/** Exactly the same vendor name (after normalisation): needed when only the number part matches. */
export function vendorsEqual(a, b) {
  const x = normaliseVendor(a);
  return Boolean(x) && x === normaliseVendor(b);
}

/** A sender domain that names a vendor: not a billing platform, free mail or our own domain. */
export function vendorDomain(domain, internalDomains = []) {
  const d = String(domain || '').trim().toLowerCase();
  if (!d || !d.includes('.')) return null;
  if (isPaymentPlatformDomain(d) || isFreeMailDomain(d) || isInternalDomain(d, internalDomains)) return null;
  return d;
}

/** Two vendor domains are the same sender: equal, or one a subdomain of the other. */
export function sameDomain(a, b) {
  const x = String(a || '').toLowerCase();
  const y = String(b || '').toLowerCase();
  if (!x || !y) return false;
  return x === y || x.endsWith(`.${y}`) || y.endsWith(`.${x}`);
}

// ------------------------------------------------------------- the pairs

/**
 * The mail's (vendor, invoice number) pairs, by the naming rules and nothing
 * else: once for the subject, once per attachment name. Pure.
 * Returns [{ vendor, invoiceNumber, key, senderDomain, from }], at most 8.
 */
export function invoicePairs({ subject = '', fromEmail = '', fromName = null, bodyText = null, attachmentNames = [], aliases = {}, internalDomains = [] } = {}) {
  const names = (Array.isArray(attachmentNames) ? attachmentNames : [])
    .map((n) => String(n || '').trim())
    .filter((n) => n && isNameableDocument({ fileName: n }))
    .slice(0, MAX_ATTACHMENT_NAMES);
  const documentCount = Math.max(1, names.length);
  const sources = [{ fileName: '', documentCount: 1, from: 'subject' }, ...names.map((fileName) => ({ fileName, documentCount, from: 'file' }))];
  const out = [];
  const seen = new Set();
  for (const src of sources) {
    const rules = extractFromRules({ subject, fromEmail, fromName, fileName: src.fileName, bodyText, aliases, internalDomains, documentCount: src.documentCount });
    const raw = rules?.invoice?.value;
    if (!raw) continue;
    const context = `${subject || ''} ${src.fileName ? fileStem(src.fileName) : ''}`;
    const key = normaliseInvoiceNumber(raw, context);
    if (!key) continue;
    const vendor = rules.vendor?.value || null;
    const senderDomain = vendorDomain(rules.senderDomain, internalDomains);
    const dedupe = `${key}|${normaliseVendor(vendor)}|${senderDomain || ''}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ vendor, invoiceNumber: raw, key, core: invoiceCore(key), senderDomain, from: src.fileName ? 'file' : 'subject' });
    if (out.length >= MAX_NUMBERS) break;
  }
  return out;
}

async function workspaceContext(workspaceId) {
  const [rawAliases, ws] = await Promise.all([
    soft(() => settingsRepository.get(aliasesKey(workspaceId)), null),
    soft(() => prisma.workspace.findUnique({ where: { id: Number(workspaceId) }, select: { internalDomains: true } }), null),
  ]);
  let aliases = {};
  if (rawAliases) {
    try {
      const parsed = typeof rawAliases === 'string' ? JSON.parse(rawAliases) : rawAliases;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) aliases = parsed;
    } catch { /* an unreadable list is no list */ }
  }
  return { aliases, internalDomains: (ws?.internalDomains || []).map((d) => String(d).toLowerCase()) };
}

// ------------------------------------------------------------ the lookup

// The open-status filter runs in SQL, before the LIMIT: Resolved / Closed /
// Deleted / Spam and every custom status whose base is Resolved or Closed ($3).
// The number is compared by its core (letters prefix and leading zeros dropped,
// SQL_CORE), so "INV-0012345" finds "12345"; the code then decides whether the
// prefixes may differ (only for exactly the same vendor name).
const LOOKUP_SQL = `
  SELECT a.id AS "attachmentId", a.ticket_id AS "ticketId", a.name_details AS "nameDetails",
         t.status, t.origin, t.native_number AS "nativeNumber", t.freshservice_ticket_id AS "freshserviceTicketId",
         t.created_at AS "createdAt"
  FROM tickets t
  JOIN ticket_attachments a ON a.ticket_id = t.id
  WHERE t.workspace_id = $1
    AND t.created_at >= $2
    AND t.status <> ALL($3::text[])
    AND a.workspace_id = $1
    AND a.name_details IS NOT NULL
    AND ${SQL_CORE} = ANY($4::text[])
    AND NOT (a.id = ANY($5::int[]))
    AND NOT (t.id = ANY($6::int[]))
  ORDER BY t.created_at DESC, a.id DESC
  LIMIT ${MAX_ROWS}`;

/** The status names that are not open: the fixed ones and every custom status based on Resolved or Closed. */
async function notOpenNames(workspaceId) {
  const custom = await soft(() => statusService.statusNamesForBase(workspaceId, TERMINAL_BASES), []);
  return [...new Set([...NOT_OPEN_NAMES, ...(Array.isArray(custom) ? custom : [])].filter(Boolean).map(String))];
}

/** Which statuses count as open: by the workspace's base status (custom names too). */
async function openStatuses(workspaceId, statuses, isOpen) {
  const out = new Set();
  for (const status of [...new Set(statuses.filter(Boolean))]) {
    let open;
    if (typeof isOpen === 'function') open = await soft(() => isOpen(status), false);
    else {
      const base = await soft(() => statusService.resolveBaseStatus(workspaceId, status), null);
      open = !TERMINAL_BASES.includes(base) && !NOT_OPEN_NAMES.includes(String(status));
    }
    if (open) out.add(status);
  }
  return out;
}

/**
 * Does this mail's pair name this document? Returns how, or null.
 *  - the same number (key) and the same vendor by name; when both sides name a
 *    vendor and the names differ, nothing else counts;
 *  - the same number and the same vendor sender domain, only when one side
 *    names no vendor;
 *  - the same number part with different letter prefixes ("INV-12345" and
 *    "12345") only for exactly the same vendor name.
 */
export function pairNamesDocument(p, d, theirKey, theirDomain) {
  const theirCore = invoiceCore(theirKey);
  if (p.key !== theirKey) {
    if (p.core && p.core === theirCore && p.core.length >= MIN_NUMBER_CHARS && vendorsEqual(p.vendor, d.vendor)) return 'vendor_exact';
    return null;
  }
  if (p.vendor && d.vendor) return vendorsMatch(p.vendor, d.vendor) ? 'vendor' : null;
  if (p.senderDomain && theirDomain && sameDomain(p.senderDomain, theirDomain)) return 'sender_domain';
  return null;
}

/**
 * Open tickets that already hold one of these documents. Throws when the lookup
 * fails (findInvoiceMatches and evaluate catch it).
 * @returns {Promise<Array<{ ticketId, displayRef, vendor, invoiceNumber, attachmentId, matchedBy }>>}
 */
export async function matchPairs(workspaceId, pairs, { internalDomains = [], excludeTicketIds = [], excludeAttachmentIds = [], now = Date.now(), isOpen = null } = {}) {
  const ws = Number(workspaceId);
  const wanted = (pairs || []).filter((p) => p?.key);
  if (!ws || !wanted.length || typeof prisma.$queryRawUnsafe !== 'function') return [];
  const cores = [...new Set(wanted.map((p) => p.core || invoiceCore(p.key)).filter(Boolean))];
  const since = new Date(now - WINDOW_DAYS * DAY);
  const ints = (list) => [...new Set((list || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const rows = await prisma.$queryRawUnsafe(LOOKUP_SQL, ws, since, await notOpenNames(ws), cores, ints(excludeAttachmentIds), ints(excludeTicketIds));
  if (!Array.isArray(rows) || !rows.length) return [];

  // The SQL filter is by name; a status's base is checked here too (a name the registry does not list).
  const open = await openStatuses(ws, rows.map((r) => r.status), isOpen);
  // A number on documents of many open tickets is an account number, not one document.
  const ticketsPerCore = new Map();
  const candidates = [];
  for (const r of rows) {
    const d = r.nameDetails && typeof r.nameDetails === 'object' ? r.nameDetails : null;
    if (!d || !open.has(r.status)) continue;
    const theirKey = normaliseInvoiceNumber(d.invoiceNumber);
    if (!theirKey) continue;
    const core = invoiceCore(theirKey);
    if (!ticketsPerCore.has(core)) ticketsPerCore.set(core, new Set());
    ticketsPerCore.get(core).add(Number(r.ticketId));
    candidates.push({ r, d, theirKey, core });
  }

  const out = [];
  const seenTickets = new Set();
  for (const { r, d, theirKey, core } of candidates) {
    if ((ticketsPerCore.get(core)?.size || 0) >= COMMON_NUMBER_TICKETS) continue;
    const ticketId = Number(r.ticketId);
    if (seenTickets.has(ticketId)) continue;
    const theirDomain = vendorDomain(d.senderDomain, internalDomains);
    let hit = null;
    for (const p of wanted) {
      const matchedBy = pairNamesDocument(p, d, theirKey, theirDomain);
      if (matchedBy) { hit = { p, matchedBy }; break; }
    }
    if (!hit) continue;
    seenTickets.add(ticketId);
    out.push({
      ticketId,
      displayRef: ticketDisplayRef({ id: ticketId, origin: r.origin, nativeNumber: r.nativeNumber, freshserviceTicketId: r.freshserviceTicketId === null || r.freshserviceTicketId === undefined ? null : String(r.freshserviceTicketId) }),
      vendor: d.vendor || hit.p.vendor || null,
      invoiceNumber: d.invoiceNumber || hit.p.invoiceNumber,
      attachmentId: Number(r.attachmentId),
      matchedBy: hit.matchedBy,
    });
    if (out.length >= MAX_MATCHES) break;
  }
  return out;
}

/**
 * The matcher. Input: an inbound e-mail's subject, sender, attachment file
 * names and workspace. Output: [{ ticketId, displayRef, vendor, invoiceNumber, attachmentId, matchedBy }],
 * newest ticket first. Never throws (a failed lookup is no match).
 */
export async function findInvoiceMatches({ workspaceId, subject = '', fromEmail = '', fromName = null, bodyText = null, attachmentNames = [], excludeTicketIds = [], excludeAttachmentIds = [], now = Date.now(), isOpen = null } = {}) {
  try {
    const { aliases, internalDomains } = await workspaceContext(workspaceId);
    const pairs = invoicePairs({ subject, fromEmail, fromName, bodyText, attachmentNames, aliases, internalDomains });
    if (!pairs.length) return [];
    return await matchPairs(workspaceId, pairs, { internalDomains, excludeTicketIds, excludeAttachmentIds, now, isOpen });
  } catch (err) {
    logger.warn(`Invoice match: lookup failed for workspace ${workspaceId} (treated as no match): ${err.message}`);
    return [];
  }
}

/**
 * The pairs and the matches together (Shadow keeps both). Never throws. A
 * failed lookup keeps the pairs already found and says so in `error`, so the
 * report counts it as a failure, never as "nothing".
 */
export async function evaluate(input = {}) {
  let pairs = [];
  try {
    const { aliases, internalDomains } = await workspaceContext(input.workspaceId);
    pairs = invoicePairs({ ...input, aliases, internalDomains });
    const matches = pairs.length ? await matchPairs(input.workspaceId, pairs, { ...input, internalDomains }) : [];
    return { pairs, matches };
  } catch (err) {
    logger.warn(`Invoice match: evaluation failed for workspace ${input.workspaceId}: ${err.message}`);
    return { pairs, matches: [], error: String(err.message || 'lookup failed').slice(0, 200) };
  }
}

// --------------------------------------------------------- attachment names

export const NAMES_TIMEOUT_MS = 8000;
/** Live, inline in intake: the Graph read may take at most this long. */
export const LIVE_NAMES_TIMEOUT_MS = 2000;

/** The document names already in the mail payload (the ingest's own object), or null when it carries none. */
export function payloadAttachmentNames(email) {
  if (Array.isArray(email?.attachmentNames)) return email.attachmentNames.slice(0, MAX_ATTACHMENT_NAMES);
  if (Array.isArray(email?.attachments)) {
    const names = email.attachments
      .filter((a) => a && isNameableDocument({ fileName: a.name || a.fileName, contentType: a.contentType }))
      .map((a) => String(a.name || a.fileName));
    return names.slice(0, MAX_ATTACHMENT_NAMES);
  }
  return null;
}

/**
 * The file names a mail carries, without downloading anything: names the
 * e-mail object already holds, else one Graph metadata read
 * (`/attachments?$select=name,contentType,isInline`), at most 30, within
 * `timeoutMs` (8 s after intake; 2 s inline in Live). [] on any failure. Used
 * only where the files are not stored yet (held mail, the Live forward check).
 */
export async function attachmentNamesFor(connection, email, { timeoutMs = NAMES_TIMEOUT_MS } = {}) {
  const own = payloadAttachmentNames(email);
  if (own) return own;
  if (!email?.hasAttachments || !email?.id || !connection?.address) return [];
  return soft(async () => {
    const { default: graphMailClient } = await import('../integrations/graphMailClient.js');
    if (typeof graphMailClient?._getClient !== 'function') return [];
    const client = graphMailClient._getClient();
    const read = client.api(`/users/${connection.address}/messages/${email.id}/attachments`).select('name,contentType,isInline').top(30).get();
    let timer;
    const timeout = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); timer.unref?.(); });
    try {
      const response = await Promise.race([read, timeout]);
      return (response?.value || [])
        .filter((a) => isNameableDocument({ fileName: a?.name, contentType: a?.contentType }))
        .map((a) => String(a.name))
        .slice(0, MAX_ATTACHMENT_NAMES);
    } finally {
      clearTimeout(timer);
    }
  }, []);
}

// ----------------------------------------------------------- Shadow record

/** 'attach_to TP-x' for the newest match, 'lookup_failed' when the lookup failed, else 'nothing'. */
export function wouldHaveFor(matches, error = null) {
  if (error) return 'lookup_failed';
  return Array.isArray(matches) && matches.length ? `attach_to ${matches[0].displayRef}` : 'nothing';
}

/**
 * Did intake do what the match says? null for held mail (a person or Mail
 * triage decides) and for a failed lookup. A new ticket agrees when nothing
 * matched; a reply agrees when its ticket is ANY of the matches.
 */
export function agreement(record) {
  if (!record || record.actual === 'held' || record.error) return null;
  const matches = Array.isArray(record.matches) ? record.matches : [];
  if (record.actual === 'new_ticket') return matches.length === 0;
  // A reply already threaded onto its ticket with no invoice match: matching had
  // nothing to say, so it neither agrees nor disagrees (24 Nov 2026).
  if (!matches.length) return String(record.actual || '').startsWith('reply_to') ? null : false;
  const actualId = Number(record.actualTicketId);
  if (actualId) return matches.some((m) => Number(m.ticketId) === actualId);
  return matches.some((m) => record.actual === `reply_to ${m.displayRef}`);
}

/**
 * The Shadow record. `wouldHave` is what the match says; `liveWouldAct` is
 * whether Live would actually have acted on it: intake took a path Live checks
 * (a follow-up check, or a non-agent's FW/Fwd new mail) AND something matched.
 */
export function buildRecord({ mode, pairs = [], matches = [], actual, actualTicketId = null, attachmentNames = [], ms = null, at = new Date(), error = null, intakeKind = null, liveEligible = false }) {
  const record = {
    mode,
    matches,
    wouldHave: wouldHaveFor(matches, error),
    actual,
    ...(actualTicketId ? { actualTicketId } : {}),
    intakeKind: intakeKind || null,
    liveWouldAct: Boolean(liveEligible) && !error && matches.length > 0,
    pairs: pairs.map((p) => ({ vendor: p.vendor || null, invoiceNumber: p.invoiceNumber, from: p.from })),
    attachmentNames: attachmentNames.slice(0, MAX_ATTACHMENT_NAMES),
    checkedAt: (at instanceof Date ? at : new Date(at)).toISOString(),
    ...(ms !== null ? { ms } : {}),
    ...(error ? { error: String(error).slice(0, 200) } : {}),
  };
  record.agrees = agreement(record);
  return record;
}

/** Merge `invoiceMatch` into a thread entry's raw_payload, in one statement (other keys untouched). */
async function writeOnEntry(entryId, record) {
  await prisma.$executeRawUnsafe(
    `UPDATE ticket_thread_entries
       SET raw_payload = (CASE WHEN jsonb_typeof(raw_payload) = 'object' THEN raw_payload ELSE '{}'::jsonb END) || jsonb_build_object('invoiceMatch', $1::jsonb)
     WHERE id = $2`,
    JSON.stringify(record), Number(entryId),
  );
}

/** Merge `invoiceMatch` into a held mail's decision JSON, in one statement. */
async function writeOnHeld(heldId, record) {
  await prisma.$executeRawUnsafe(
    `UPDATE mailbox_held_messages
       SET decision = (CASE WHEN jsonb_typeof(decision) = 'object' THEN decision ELSE '{}'::jsonb END) || jsonb_build_object('invoiceMatch', $1::jsonb)
     WHERE id = $2`,
    JSON.stringify(record), Number(heldId),
  );
}

/**
 * After intake decided (Shadow and Live): match the mail and write the result
 * beside it, changing nothing else. `outcome` is intake's: 'created' | 'reply' | 'held'.
 *   created / reply  the mail's first thread entry (by its Message-ID): raw_payload.invoiceMatch
 *   held             the held row: decision.invoiceMatch
 * intakeKind is the intake classification (null when the mail matched a
 * ticket before it); liveEligible is whether Live checks mail on that path.
 * Never throws. Returns the record, or null when nothing was written.
 */
export async function recordAfterIntake(connection, email, outcome, { attachmentNames = null, now = Date.now(), intakeKind = null, liveEligible = false } = {}) {
  const started = Date.now();
  try {
    const workspaceId = Number(connection?.workspaceId);
    if (!workspaceId || !['created', 'reply', 'held'].includes(outcome)) return null;
    const mode = await getMode(workspaceId);
    if (mode === 'off') return null;
    const messageId = String(email?.internetMessageId || '').trim();
    const live = { intakeKind, liveEligible };
    const base = { workspaceId, subject: email?.subject || '', fromEmail: email?.from || '', fromName: email?.fromName || null, bodyText: email?.bodyText || email?.bodyPreview || null, now };

    if (outcome === 'held') {
      const key = messageId || `graph:${String(email?.id || '').trim() || 'unknown'}`;
      const held = await prisma.mailboxHeldMessage.findFirst({ where: { connectionId: connection.id, internetMessageId: key.slice(0, 255) }, select: { id: true } });
      if (!held) return null;
      const names = Array.isArray(attachmentNames) ? attachmentNames : await attachmentNamesFor(connection, email);
      const { pairs, matches, error } = await evaluate({ ...base, attachmentNames: names });
      const record = buildRecord({ mode, pairs, matches, error, ...live, actual: 'held', attachmentNames: names, ms: Date.now() - started });
      await writeOnHeld(held.id, record);
      return record;
    }

    if (!messageId) return null;
    const entries = await prisma.ticketThreadEntry.findMany({
      where: { workspaceId, emailMessageId: messageId },
      select: { id: true, ticketId: true },
      orderBy: { id: 'asc' },
      take: 5,
    });
    const entry = entries?.[0];
    if (!entry) return null;
    const isNew = outcome === 'created';
    const ticket = await prisma.ticket.findFirst({ where: { id: entry.ticketId, workspaceId }, select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true } });
    // This mail's own files (stored already, by name): never a match for itself.
    const own = await prisma.ticketAttachment.findMany({
      where: {
        ticketId: entry.ticketId,
        source: 'email',
        OR: [{ threadEntryId: { in: entries.map((e) => e.id) } }, ...(isNew ? [{ threadEntryId: null }] : [])],
      },
      select: { id: true, fileName: true },
      take: 30,
    });
    const names = (own || []).map((a) => a.fileName);
    const { pairs, matches, error } = await evaluate({
      ...base,
      attachmentNames: names,
      excludeAttachmentIds: (own || []).map((a) => a.id),
      // A new ticket is not a match for the mail that made it.
      excludeTicketIds: isNew ? [entry.ticketId] : [],
    });
    const ref = ticket ? ticketDisplayRef({ ...ticket, freshserviceTicketId: ticket.freshserviceTicketId === null || ticket.freshserviceTicketId === undefined ? null : String(ticket.freshserviceTicketId) }) : `TP-ID-${entry.ticketId}`;
    const record = buildRecord({
      mode, pairs, matches, error, ...live,
      actual: isNew ? 'new_ticket' : `reply_to ${ref}`,
      actualTicketId: entry.ticketId,
      attachmentNames: names,
      ms: Date.now() - started,
    });
    await writeOnEntry(entry.id, record);
    return record;
  } catch (err) {
    logger.warn(`Invoice match: shadow record skipped for "${String(email?.subject || '').slice(0, 80)}" (${err.message})`);
    return null;
  }
}

// The after-intake jobs run through a small queue: at most 2 at a time and 200
// waiting, so a burst of mail never piles up lookups. A full queue drops the job
// (a Shadow record is a measurement, not a duty) and logs it once a minute.
export const QUEUE_CONCURRENCY = 2;
export const QUEUE_MAX_WAITING = 200;
const jobQueue = [];
let jobsRunning = 0;
let lastDropLogAt = 0;

function pumpJobs() {
  while (jobsRunning < QUEUE_CONCURRENCY && jobQueue.length) {
    const job = jobQueue.shift();
    jobsRunning += 1;
    Promise.resolve()
      .then(() => recordAfterIntake(...job.args))
      .catch(() => null)
      .then((result) => {
        jobsRunning -= 1;
        job.resolve(result ?? null);
        pumpJobs();
      });
  }
}

/**
 * Queue the after-intake record. Synchronous for the caller and never throws;
 * the promise settles with the record (or null: dropped, off, nothing written).
 */
export function queueRecordAfterIntake(connection, email, outcome, options = {}) {
  try {
    if (!['created', 'reply', 'held'].includes(outcome) || !connection?.workspaceId) return Promise.resolve(null);
    if (jobQueue.length >= QUEUE_MAX_WAITING) {
      if (Date.now() - lastDropLogAt > 60_000) {
        lastDropLogAt = Date.now();
        logger.warn(`Invoice match: the after-intake queue is full (${QUEUE_MAX_WAITING} waiting); records are skipped until it drains`);
      }
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      jobQueue.push({ args: [connection, email, outcome, options], resolve });
      pumpJobs();
    });
  } catch {
    return Promise.resolve(null);
  }
}

export const _queueStateForTests = () => ({ running: jobsRunning, waiting: jobQueue.length });

// ------------------------------------------------------------------ report

/**
 * What Shadow saw in the last `days` days (at most 30), newest first, with what
 * actually happened: filed mail (thread entries) and held mail (and what a
 * person or Mail triage did with it since). Read-only.
 */
export async function shadowReport(workspaceId, { days = 7, limit = 500 } = {}) {
  const ws = Number(workspaceId);
  const d = Math.min(30, Math.max(1, Math.round(Number(days) || 7)));
  const since = new Date(Date.now() - d * DAY);
  const cap = Math.min(1000, Math.max(1, Number(limit) || 500));
  const [entries, held] = await Promise.all([
    prisma.$queryRawUnsafe(
      `SELECT e.id, e.ticket_id AS "ticketId", e.occurred_at AS "at", e.actor_email AS "fromEmail",
              t.subject, t.status, t.origin, t.native_number AS "nativeNumber", t.freshservice_ticket_id AS "freshserviceTicketId",
              e.raw_payload->'invoiceMatch' AS "invoiceMatch"
         FROM ticket_thread_entries e
         JOIN tickets t ON t.id = e.ticket_id
        WHERE e.workspace_id = $1 AND e.occurred_at >= $2 AND e.raw_payload->'invoiceMatch' IS NOT NULL
        ORDER BY e.occurred_at DESC
        LIMIT ${cap}`,
      ws, since,
    ),
    prisma.$queryRawUnsafe(
      `SELECT h.id, h.received_at AS "at", h.from_email AS "fromEmail", h.subject, h.reason, h.status,
              h.resolved_ticket_id AS "resolvedTicketId", h.resolved_by AS "resolvedBy",
              h.decision->'invoiceMatch' AS "invoiceMatch"
         FROM mailbox_held_messages h
        WHERE h.workspace_id = $1 AND h.created_at >= $2 AND h.decision->'invoiceMatch' IS NOT NULL
        ORDER BY h.created_at DESC
        LIMIT ${cap}`,
      ws, since,
    ),
  ]);
  const refOf = (t) => ticketDisplayRef({ ...t, freshserviceTicketId: t.freshserviceTicketId === null || t.freshserviceTicketId === undefined ? null : String(t.freshserviceTicketId) });
  const resolvedIds = [...new Set((held || []).map((h) => Number(h.resolvedTicketId)).filter(Boolean))];
  const resolved = resolvedIds.length ? await soft(() => prisma.ticket.findMany({
    where: { id: { in: resolvedIds }, workspaceId: ws }, select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
  }), []) : [];
  const refById = new Map((resolved || []).map((t) => [t.id, refOf(t)]));

  const rows = [
    ...(entries || []).map((e) => ({
      kind: 'filed',
      entryId: e.id,
      at: e.at,
      subject: e.subject,
      fromEmail: e.fromEmail,
      ticket: { id: e.ticketId, displayRef: refOf(e), status: e.status },
      ...(e.invoiceMatch || {}),
    })),
    ...(held || []).map((h) => ({
      kind: 'held',
      heldId: h.id,
      at: h.at,
      subject: h.subject,
      fromEmail: h.fromEmail,
      holdReason: h.reason,
      heldStatus: h.status,
      // What happened to it since: a person or Mail triage attached, created or discarded it.
      finally: h.status === 'attached' ? `attached to ${refById.get(Number(h.resolvedTicketId)) || `TP-ID-${h.resolvedTicketId}`}`
        : h.status === 'created' ? `new ticket ${refById.get(Number(h.resolvedTicketId)) || ''}`.trim()
          : h.status,
      resolvedBy: h.resolvedBy || null,
      ...(h.invoiceMatch || {}),
    })),
  ].sort((a, b) => new Date(b.at || 0) - new Date(a.at || 0));

  const withMatch = rows.filter((r) => Array.isArray(r.matches) && r.matches.length);
  const summary = {
    total: rows.length,
    withNumber: rows.filter((r) => Array.isArray(r.pairs) && r.pairs.length).length,
    withMatch: withMatch.length,
    // Where Live would actually have acted (its paths only), apart from what the match says.
    liveWouldAct: rows.filter((r) => r.liveWouldAct === true).length,
    // The lookup failed: neither "nothing" nor a match.
    failed: rows.filter((r) => Boolean(r.error)).length,
    agree: rows.filter((r) => r.agrees === true).length,
    disagree: rows.filter((r) => r.agrees === false).length,
    // The cases to judge: a match where intake made a new ticket or filed it elsewhere.
    matchButNewTicket: withMatch.filter((r) => r.actual === 'new_ticket').length,
    matchButOtherTicket: withMatch.filter((r) => r.agrees === false && r.actual !== 'new_ticket').length,
    held: rows.filter((r) => r.kind === 'held').length,
    heldWithMatch: withMatch.filter((r) => r.kind === 'held').length,
  };
  return { days: d, since: since.toISOString(), mode: await getMode(ws, { fresh: true }), summary, rows };
}

export default {
  MODES, WINDOW_DAYS, settingsKey, getMode, setMode, normalizeMode, normaliseInvoiceNumber, normaliseVendor, vendorsMatch,
  invoicePairs, matchPairs, findInvoiceMatches, evaluate, attachmentNamesFor, recordAfterIntake, queueRecordAfterIntake, shadowReport, buildRecord,
};
