/**
 * Attachment display names (4.4.08), the pure part: which files are named, the
 * quick first pass from the e-mail's subject, sender and file name, the name
 * format, and the download header. No I/O here (attachmentNamingService.js
 * does the reads, the Claude call and the writes), so every rule is testable
 * on invented inputs.
 *
 * Name format: `Vendor_InvoiceNumber_YYYY_MM_DD.ext`. No invoice number gives
 * `Vendor_YYYY_MM_DD.ext`, and no vendor means no rename.
 */

export const NAMING_TIMEZONE = 'America/Vancouver';
export const MAX_STEM_CHARS = 120;
// The whole name, extension and any " (2)" included: well inside VARCHAR(255).
export const MAX_NAME_CHARS = 200;
const MAX_INVOICE_CHARS = 40;

// Code-point-safe helpers: never split a surrogate pair.
const cpLength = (s) => Array.from(String(s)).length;
const cpSlice = (s, n) => Array.from(String(s)).slice(0, Math.max(0, n)).join('');

// Billing platforms send on a vendor's behalf: their domain and display name
// never name the vendor, and their domain is never taught to the vendor list.
export const PAYMENT_PLATFORM_DOMAINS = [
  'getbalance.com', 'intuit.com', 'quickbooks.com', 'bill.com', 'xero.com',
  'billtrust.com', 'netsuite.com', 'stripe.com', 'paypal.com', 'squareup.com',
  'freshbooks.com', 'waveapps.com', 'invoiced.com', 'chargebee.com', 'zuora.com',
  'tipalti.com', 'coupahost.com', 'ariba.com', 'em.com',
];
// The platform itself written as the vendor ("Invoice from QuickBooks").
const PLATFORM_ONLY = /^(?:balance|quickbooks(?: online)?|intuit(?: quickbooks)?|bill\.com|xero|billtrust|netsuite|stripe|paypal|square|freshbooks|wave|tipalti|coupa|ariba)$/i;

export const FREE_MAIL_DOMAINS = [
  'gmail.com', 'googlemail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'yahoo.com', 'yahoo.ca', 'icloud.com', 'me.com', 'aol.com', 'proton.me', 'protonmail.com',
  'shaw.ca', 'telus.net',
];

const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif|tiff?|ico|emf|wmf)$/i;
// Parts of a mail that are not a document anyone sent: the kept original
// message, calendar invites, contact cards, signatures, TNEF wrappers.
const NOT_A_DOCUMENT = /(\.(html?|ics|vcf|p7s|p7m|eml|msg)$)|(^winmail\.dat$)|(^original-message\.html$)/i;

const MONTHS = 'january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec';
// A "vendor" that is really a generic word ("September Invoice", "Your Invoice").
const GENERIC_VENDOR = new RegExp(`^(?:${MONTHS}|new|your|our|the|an?|my|monthly|weekly|annual|final|past due|overdue|outstanding|open|unpaid|paid|proforma|pro forma|sales|tax|commercial|rental|copy|copy of|re|fw|fwd|invoice|invoices|statement|statements|receipt|receipts|bill|payment|remittance|attached|please find|reminder|updated|revised|corrected|draft|credit|debit|ar|ap|signed|scan|scanned|doc|docs|document|documents|file|files|form|forms|attachment|image|page|pages|untitled|printout|print|original|originals|return|returned|returns|duplicate|reprint|reissued|amended|replacement|cancelled|canceled|void|voided|customer|client|vendor|supplier|summary|details|detail|confirmation|quote|quotation|estimate|order|purchase order|po|report)$`, 'i');

// ---------------------------------------------------------------- helpers

// An extension is 1–8 letters or digits ("pdf", "xlsx"); anything else after
// the last dot is part of the name ("Acme v2.final draft").
const EXT_RE = /^[A-Za-z0-9]{1,8}$/;

export function fileExtension(name) {
  const base = String(name || '');
  const idx = base.lastIndexOf('.');
  if (idx <= 0 || idx >= base.length - 1) return '';
  const ext = base.slice(idx + 1);
  return EXT_RE.test(ext) ? ext : '';
}

export function fileStem(name) {
  const base = String(name || '');
  const ext = fileExtension(base);
  return ext ? base.slice(0, base.length - ext.length - 1) : base;
}

const EXT_BY_TYPE = {
  'application/pdf': 'pdf',
  'application/msword': 'doc',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.ms-excel': 'xls',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.ms-powerpoint': 'ppt',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
  'text/csv': 'csv',
  'text/plain': 'txt',
  'application/rtf': 'rtf',
  'application/zip': 'zip',
  'application/xml': 'xml',
  'text/xml': 'xml',
};

/** The extension a name keeps: the file's own (1–8 letters/digits), else from its content type. */
export function extensionFor(fileName, contentType) {
  const own = fileExtension(fileName);
  if (own) return own.toLowerCase();
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  return EXT_BY_TYPE[type] || '';
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

export function emailDomain(address) {
  const at = String(address || '').trim().toLowerCase().lastIndexOf('@');
  return at >= 0 ? String(address).trim().toLowerCase().slice(at + 1).replace(/[>\s]+$/, '') : '';
}

function domainIn(domain, list) {
  const d = String(domain || '').toLowerCase();
  return Boolean(d) && list.some((x) => d === x || d.endsWith(`.${x}`));
}

export const isPaymentPlatformDomain = (domain) => domainIn(domain, PAYMENT_PLATFORM_DOMAINS);
export const isFreeMailDomain = (domain) => domainIn(domain, FREE_MAIL_DOMAINS);
export const isInternalDomain = (domain, internalDomains = []) => domainIn(domain, (internalDomains || []).map((d) => String(d).toLowerCase()));

/** A document worth naming: not a picture, not an inline part, not a mail artefact. */
export function isNameableDocument({ fileName, contentType, isInline = false } = {}) {
  if (isInline) return false;
  const name = String(fileName || '');
  if (!name) return false;
  if (/^image\//i.test(String(contentType || ''))) return false;
  if (IMAGE_EXT.test(name)) return false;
  // Pictures lifted out of a mail body are stored as `picture-N-…` (mailboxIngestService).
  if (/^picture-\d+-/i.test(name)) return false;
  if (NOT_A_DOCUMENT.test(name)) return false;
  return true;
}

export const isPdf = ({ fileName, contentType } = {}) => /pdf/i.test(String(contentType || '')) || /\.pdf$/i.test(String(fileName || ''));

// Every PDF starts with these five bytes.
const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');

/** The bytes start like a PDF ("%PDF-"). */
export function startsLikePdf(buffer) {
  if (!buffer || typeof buffer.length !== 'number' || buffer.length < PDF_MAGIC.length) return false;
  for (let i = 0; i < PDF_MAGIC.length; i += 1) {
    if (buffer[i] !== PDF_MAGIC[i]) return false;
  }
  return true;
}

// A document extension that says what the file is (not a PDF), so a generic
// content type alone is no reason to fetch it.
const OTHER_DOCUMENT_EXT = new Set([
  ...Object.values(EXT_BY_TYPE).filter((e) => e !== 'pdf'),
  'xlsm', 'xlsb', 'docm', 'pptm', 'odt', 'ods', 'odp', 'json', '7z', 'rar',
]);

/**
 * Worth reading the first bytes to see whether it is a PDF after all: the
 * name and type don't say PDF, but the text after the last dot mentions it
 * ("Report.pdf_", "scan.pdfx"), or the type is the generic
 * application/octet-stream and the name doesn't say it is something else.
 * Anything isPdf() already recognises, and every clearly typed file, is
 * never fetched for this.
 */
export function mightBePdf({ fileName, contentType } = {}) {
  if (isPdf({ fileName, contentType })) return false;
  const name = String(fileName || '');
  const dot = name.lastIndexOf('.');
  const tail = dot > 0 ? name.slice(dot + 1) : '';
  if (/pdf/i.test(tail)) return true;
  const type = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!/^(?:application|binary)\/octet-stream$/.test(type)) return false;
  const own = fileExtension(name).toLowerCase();
  return !own || !OTHER_DOCUMENT_EXT.has(own);
}

/** YYYY-MM-DD for a moment, in Pacific time. */
export function pacificDate(at = new Date()) {
  const d = at instanceof Date ? at : new Date(at);
  const safe = Number.isNaN(d.getTime()) ? new Date() : d;
  return new Intl.DateTimeFormat('en-CA', { timeZone: NAMING_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit' }).format(safe);
}

/** A real calendar date 'YYYY-MM-DD' within a sane window (2000 to 60 days ahead), else null. */
export function validIsoDate(value, now = new Date()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || '').trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const dt = new Date(Date.UTC(y, mo - 1, d));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return null;
  if (y < 2000) return null;
  if (dt.getTime() > now.getTime() + 60 * 86400_000) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

/** Remove what file names can't hold, collapse whitespace, trim stray dots and separators. */
export function cleanNamePart(value) {
  return String(value ?? '')
    // Direction overrides and marks (U+202A–202E, U+2066–2069, U+200E/F) can
    // disguise a name ("invoice<RLO>fdp.exe"); control characters are never a name.
    .replace(/[‪-‮⁦-⁩‎‏]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\\/:*?"<>|\u0000-\u001f\u007f-\u009f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s_-]+|[.\s_-]+$/g, '');
}

/** A name's stem made safe on Windows: "CON" → "CON_". */
function safeStem(stem) {
  const s = String(stem || '');
  return WINDOWS_RESERVED.test(s.split('.')[0].trim()) ? `${s}_` : s;
}

/** Stem + extension, the whole thing capped at MAX_NAME_CHARS code points. */
function joinName(stem, ext) {
  const e = ext ? `.${ext}` : '';
  return `${cpSlice(safeStem(stem), MAX_NAME_CHARS - cpLength(e)).trim()}${e}`;
}

/** Our own company written as a vendor ("Acme Corp" when we are acmecorp.example). */
export function looksLikeOwnCompany(vendor, internalDomains = []) {
  const squashed = String(vendor || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  if (squashed.length < 3) return false;
  return (internalDomains || []).some((d) => {
    const label = String(d || '').toLowerCase().split('.')[0].replace(/[^a-z0-9]/g, '');
    return label.length >= 3 && (label.startsWith(squashed) || squashed.startsWith(label));
  });
}

/** A vendor candidate worth keeping: letters, not generic, not us, not a platform. */
export function plausibleVendor(raw, internalDomains = []) {
  let v = cleanNamePart(raw);
  if (!v) return null;
  // Trailing codes and asides: "Acme Rentals_A1B2C3", "Acme - Account 991", "Acme (Canada)".
  v = v.replace(/_(?=[^_]*\d)[\s\S]*$/, '').replace(/\s+[-–|]\s+[\s\S]*$/, '').replace(/\s*\(.*$/, '').trim();
  v = v.replace(/\s+(?:for|regarding|re|dated|on|due)\b[\s\S]*$/i, '').trim();
  v = v.replace(/[.,;:]+$/, '').trim();
  if (cpLength(v) < 2 || cpLength(v) > 80) return null;
  if (!/[A-Za-z]/.test(v)) return null;
  if (/^[#\d]/.test(v)) return null;
  if (/\d{1,2}\/\d{1,2}\/\d{2,4}/.test(v)) return null; // "from 11/16/2026"
  if (GENERIC_VENDOR.test(v)) return null;
  if (looksLikeOwnCompany(v, internalDomains)) return null;
  if (PLATFORM_ONLY.test(v)) return null;
  return v;
}

const INVOICE_TOKEN = '([A-Z]{0,8}[-_]?\\d[A-Z0-9\\-_/]{2,})';

/**
 * Does `text` hold `token` as a whole token ("INV-7701" in "INV-7701.pdf", not
 * in "Statement INV-77012")? Letters and digits on either side break the match.
 */
export function holdsToken(text, token) {
  const t = String(token || '').trim();
  if (!t) return false;
  const escaped = t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, 'i').test(String(text || ''));
}

// A bare year ("#2026", "Invoice 2026") is a period, not an invoice number.
const BARE_YEAR = /^(?:19|20)\d{2}$/;

/** An invoice number from the subject: as plausibleInvoice, and never a bare year. */
function subjectInvoiceValue(raw) {
  const v = plausibleInvoice(raw);
  return v && !BARE_YEAR.test(v) ? v : null;
}

function plausibleInvoice(raw) {
  const v = cleanNamePart(raw).replace(/[_]+$/, '');
  if (!v || v.length < 3 || v.length > MAX_INVOICE_CHARS) return null;
  if (!/\d/.test(v)) return null;
  if (/^\d{1,2}[/-]\d{1,2}[/-]\d{2,4}$/.test(v)) return null; // a date
  return v;
}

function stripSubjectPrefixes(subject) {
  let s = String(subject || '').trim();
  for (let i = 0; i < 4; i += 1) {
    const next = s.replace(/^\s*(?:re|fw|fwd|tr|aw|wg)\s*(?:\[\d+\])?\s*:\s*/i, '').replace(/^\s*\[[^\]]{0,40}\]\s*/, '');
    if (next === s) break;
    s = next;
  }
  return s.trim();
}

/** "Dana Fox" <dana@vendor.example> quoted inside a forwarded mail body: the original sender. */
export function quotedOriginalSender(bodyText) {
  const text = String(bodyText || '').slice(0, 20_000);
  const m = /^\s*(?:\*\s*)?From:\s*\*?\s*(?:"?([^"<\n\r]{1,120}?)"?\s*)?[<[]?(?:mailto:)?([\w.+'-]+@[\w-]+(?:\.[\w-]+)+)[>\]]?/im.exec(text);
  if (!m) return null;
  return { name: (m[1] || '').replace(/\*/g, '').trim() || null, email: m[2].toLowerCase() };
}

/** A vendor-list entry's vendor: entries are `{ vendor, learnedAt, by }` (a bare string is read too). */
export const aliasVendor = (entry) => {
  const v = typeof entry === 'string' ? entry : entry?.vendor;
  return typeof v === 'string' && v.trim() ? v.trim() : null;
};

/** Look a domain (or any parent domain) up in the learned vendor list: { key, vendor } or null. */
export function aliasEntryFor(domain, aliases = {}) {
  if (!domain || !aliases || typeof aliases !== 'object') return null;
  const parts = String(domain).toLowerCase().split('.');
  for (let i = 0; i <= parts.length - 2; i += 1) {
    const key = parts.slice(i).join('.');
    const vendor = aliasVendor(aliases[key]);
    if (vendor) return { key, vendor };
  }
  return null;
}

export const aliasFor = (domain, aliases = {}) => aliasEntryFor(domain, aliases)?.vendor || null;

/** Two spellings of one vendor ("Acme Supplies" / "ACME SUPPLIES LTD")? */
export function sameVendor(a, b) {
  const sq = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  const x = sq(a);
  const y = sq(b);
  if (!x || !y) return false;
  return x === y || (Math.min(x.length, y.length) >= 4 && (x.includes(y) || y.includes(x)));
}

// ------------------------------------------------------------------ rules

const RANK = { high: 3, medium: 2, low: 1 };
const better = (a, b) => (!b || (a && RANK[a.confidence] > RANK[b.confidence]) ? a : b);

function fromSubject(subject, internalDomains) {
  const s = stripSubjectPrefixes(subject);
  const out = { vendor: null, invoice: null };
  if (!s) return out;
  let m = new RegExp(`^(?:new\\s+)?(?:invoice|bill|facture)\\s*(?:#|no\\.?|number)?\\s*:?\\s*${INVOICE_TOKEN}\\s+from\\s+(.+)$`, 'i').exec(s);
  if (m) {
    const vendor = plausibleVendor(m[2], internalDomains);
    const invoice = subjectInvoiceValue(m[1]);
    if (vendor) out.vendor = { value: vendor, confidence: 'high', from: 'subject' };
    if (invoice) out.invoice = { value: invoice, confidence: 'high', from: 'subject' };
    return out;
  }
  m = /^(?:new\s+|your\s+)?(?:invoice|bill|statement|receipt|facture)\s+from\s+(.+)$/i.exec(s);
  if (m) {
    const vendor = plausibleVendor(m[1], internalDomains);
    if (vendor) out.vendor = { value: vendor, confidence: 'high', from: 'subject' };
  } else {
    m = /^(.{2,60}?)\s+(?:invoice|facture|statement|receipt)\b/i.exec(s);
    if (m) {
      const vendor = plausibleVendor(m[1], internalDomains);
      if (vendor) out.vendor = { value: vendor, confidence: 'medium', from: 'subject' };
    }
  }
  const inv = new RegExp(`(?:invoice|inv|facture|bill)\\s*(?:#|no\\.?|number|num)?\\s*:?\\s*${INVOICE_TOKEN}`, 'i').exec(s)
    || /#\s*(\d{4,}[A-Z0-9-]*)/i.exec(s);
  const invoice = inv ? subjectInvoiceValue(inv[1]) : null;
  if (invoice) out.invoice = { value: invoice, confidence: 'medium', from: 'subject' };
  return out;
}

function fromFileName(fileName, internalDomains) {
  const stem = fileStem(fileName).trim();
  const out = { vendor: null, invoice: null };
  if (!stem) return out;
  // QuickBooks style: Invoice_28401_from_Northwind_Traders
  let m = /^invoice[_\s-]+([A-Z0-9][\w-]*)[_\s-]+from[_\s-]+(.+)$/i.exec(stem);
  if (m) {
    const vendor = plausibleVendor(m[2].replace(/_/g, ' '), internalDomains);
    const invoice = plausibleInvoice(m[1]);
    if (vendor) out.vendor = { value: vendor, confidence: 'high', from: 'file' };
    if (invoice) out.invoice = { value: invoice, confidence: 'high', from: 'file' };
    return out;
  }
  // A bare invoice number: INV-1234, INV_0042, INV000123
  m = /^(INV[-_ ]?\d[\w-]*)$/i.exec(stem);
  if (m) {
    out.invoice = { value: m[1].replace(/_/g, '-').replace(/ /g, '-'), confidence: 'high', from: 'file' };
    return out;
  }
  // Vendor then the word Invoice: "Acme_Invoice_320431", "Acme Scientific Invoice INV000007663 - …"
  m = /^([A-Za-z][A-Za-z0-9&.' ]*?(?:[_ ][A-Za-z][A-Za-z0-9&.']*)*?)[_\s-]+invoice[_\s-]*(?:#|no)?[_\s-]*([A-Z]{0,8}-?\d[\w-]*)?/i.exec(stem);
  if (m) {
    const vendor = plausibleVendor(m[1].replace(/_/g, ' '), internalDomains);
    if (vendor) out.vendor = { value: vendor, confidence: 'medium', from: 'file' };
    const invoice = m[2] ? plausibleInvoice(m[2]) : null;
    if (invoice) out.invoice = { value: invoice, confidence: 'medium', from: 'file' };
    if (out.vendor || out.invoice) return out;
  }
  m = new RegExp(`(?:invoice|inv|facture)[\\s_-]*(?:#|no)?[\\s_-]*${INVOICE_TOKEN}`, 'i').exec(stem);
  if (m) {
    const invoice = plausibleInvoice(m[1]);
    if (invoice) out.invoice = { value: invoice, confidence: 'medium', from: 'file' };
    return out;
  }
  // A bare number: "501-5670", "147005"
  m = /^(\d[\d-]{3,})$/.exec(stem);
  if (m) out.invoice = { value: m[1], confidence: 'medium', from: 'file' };
  return out;
}

/** A sender display name that names a company ("Acme Supplies Billing", "Acme Ltd."), not a person. */
function fromDisplayName(name, domain, internalDomains) {
  let n = String(name || '').trim();
  if (!n || n.includes('@')) return null;
  // "Acme Supplies via Balance": the business it was sent for.
  const via = /^(.+?)\s+(?:via|through|by)\s+.+$/i.exec(n);
  if (via) n = via[1];
  else if (isPaymentPlatformDomain(domain)) return null;
  const company = /\b(inc|ltd|llc|llp|corp|corporation|co|company|limited|group|gmbh|ulc|plc|services|supplies|systems|solutions|industries|rentals?|hotels?|billing|accounts|invoices?|receivables?|payables?|ar|finance)\b\.?/i;
  if (!via && !company.test(n)) return null;
  n = n.replace(/\s*[-–|]?\s*\b(billing|accounts receivable|accounts|invoicing|invoices?|receivables?|finance|ar|no-?reply|notifications?)\b\s*(department|dept|team)?\s*$/i, '').trim();
  const vendor = plausibleVendor(n, internalDomains);
  return vendor ? { value: vendor, confidence: 'medium', from: 'sender' } : null;
}

/**
 * The quick first pass. Returns { vendor, invoice, senderDomain, senderName, rulesSufficient, … }
 * where vendor/invoice are { value, confidence, from } or null.
 *
 * `documentCount` is how many documents the mail carried. A number from the
 * subject belongs to one of them, so on a mail with several documents it is
 * only used for a file whose own name holds it (the others ask Claude).
 * `rulesSufficient` (skip Claude) needs a vendor AND a number, both with high
 * confidence from the mail itself: a learned vendor-list entry alone never
 * skips Claude, so Claude can correct a wrong entry.
 */
export function extractFromRules({ subject, fromEmail, fromName, fileName, bodyText = null, aliases = {}, internalDomains = [], documentCount = 1 } = {}) {
  let senderEmail = String(fromEmail || '').toLowerCase();
  let senderName = fromName || null;
  let domain = emailDomain(senderEmail);
  let forwarded = false;
  // A colleague forwarding a vendor's mail: the quoted original sender is the vendor.
  if (isInternalDomain(domain, internalDomains)) {
    const quoted = quotedOriginalSender(bodyText);
    const qDomain = emailDomain(quoted?.email);
    if (quoted && qDomain && !isInternalDomain(qDomain, internalDomains)) {
      senderEmail = quoted.email; senderName = quoted.name; domain = qDomain; forwarded = true;
    }
  }
  const internal = isInternalDomain(domain, internalDomains);
  const platform = isPaymentPlatformDomain(domain);
  const freeMail = isFreeMailDomain(domain);

  const subj = fromSubject(subject, internalDomains);
  const file = fromFileName(fileName, internalDomains);

  let vendor = null;
  const alias = !internal && !platform && !freeMail ? aliasFor(domain, aliases) : null;
  if (alias) vendor = { value: alias, confidence: 'high', from: 'vendor_list' };
  vendor = better(vendor, file.vendor && file.vendor.confidence === 'high' ? file.vendor : null);
  vendor = better(vendor, subj.vendor);
  vendor = better(vendor, file.vendor);
  if (!vendor && !internal && !freeMail) vendor = fromDisplayName(senderName, domain, internalDomains);
  // A forward's subject is the colleague's words, not a template: one step less sure.
  if (vendor && forwarded && vendor.from === 'subject' && vendor.confidence === 'high') vendor = { ...vendor, confidence: 'medium' };

  let subjectInvoice = subj.invoice;
  let subjectInvoiceHint = null;
  if (subjectInvoice) {
    const inOwnName = holdsToken(fileStem(fileName), subjectInvoice.value);
    if (inOwnName) {
      // Subject and file name agreeing on the number makes it certain.
      subjectInvoice = { ...subjectInvoice, confidence: 'high', from: 'subject+file' };
    } else if (Number(documentCount) > 1) {
      // One mail, several documents: the subject's number is one file's, not every file's.
      subjectInvoiceHint = subjectInvoice.value;
      subjectInvoice = null;
    }
  }
  const invoice = subjectInvoice?.from === 'subject+file' ? subjectInvoice : better(subjectInvoice, file.invoice);

  const strongVendor = vendor?.confidence === 'high' && (vendor.from === 'subject' || vendor.from === 'file');
  const strongInvoice = invoice?.confidence === 'high';
  return {
    vendor,
    invoice,
    subjectInvoiceHint,
    senderDomain: domain || null,
    senderName: senderName || null,
    forwarded,
    domainKind: internal ? 'internal' : platform ? 'platform' : freeMail ? 'free_mail' : (domain ? 'vendor' : 'unknown'),
    rulesSufficient: Boolean(strongVendor && strongInvoice),
  };
}

// ------------------------------------------------------------------- names

/**
 * `Vendor_Invoice_YYYY_MM_DD.ext`, at most 120 characters before the extension.
 * Returns null without a vendor (no rename).
 */
/**
 * A vendor as it should read in a file name (24 Nov 2026):
 * - a bilingual name written twice ("ACME PARC CANADA INC. ACME PARK CANADA INC",
 *   "Acme Ltée / Acme Ltd") keeps its first version;
 * - an all-capitals name of several words reads in normal capitals
 *   ("BEER WORKS INC" → "Beer Works Inc"), keeping short letter-only codes such
 *   as BHP, LLC or ULC in capitals. One-word names (IBM, BHP) are left alone.
 */
const TITLE_SHORT = new Set(['INC', 'LTD', 'CO', 'CORP', 'LTÉE', 'LTEE', 'CIE', 'THE', 'AND', 'OF']);
export function tidyVendor(raw) {
  let v = String(raw ?? '').replace(/\s+/g, ' ').trim();
  if (!v) return v;
  const parts = v.split(/\s*\/\s*|\s+\|\s+|(?<=\b(?:inc|ltd|ltée|ltee|corp|llc|ulc)\.?)\s+(?=\S)/i).map((s) => s.trim()).filter(Boolean);
  if (parts.length >= 2) {
    const first = (s) => s.split(' ')[0].toLowerCase().replace(/[^a-z0-9]/g, '');
    if (first(parts[0]) && first(parts[0]) === first(parts[1])) v = parts[0];
  }
  const letters = v.replace(/[^A-Za-zÀ-ÿ]/g, '');
  if (letters.length >= 4 && letters === letters.toUpperCase() && /\s/.test(v)) {
    v = v.split(' ').map((w) => {
      const bare = w.replace(/[^A-Za-zÀ-ÿ]/g, '');
      if (bare.length <= 3 && !TITLE_SHORT.has(bare.toUpperCase())) return w;
      return w.charAt(0) + w.slice(1).toLowerCase();
    }).join(' ');
  }
  return v.replace(/[.,;:]+$/, '').trim();
}

export function formatAttachmentName({ vendor, invoiceNumber = null, date, ext }) {
  let v = cleanNamePart(tidyVendor(vendor));
  if (!v) return null;
  let inv = cpSlice(cleanNamePart(invoiceNumber), MAX_INVOICE_CHARS).trim();
  if (inv && inv.toLowerCase() === v.toLowerCase()) inv = '';
  const datePart = /^\d{4}-\d{2}-\d{2}$/.test(String(date || '')) ? String(date).replace(/-/g, '_') : '';
  const fixed = [inv, datePart].filter(Boolean).join('_');
  const room = MAX_STEM_CHARS - (fixed ? cpLength(fixed) + 1 : 0);
  if (cpLength(v) > room) v = cpSlice(v, Math.max(room, 1)).trim();
  const stem = cpSlice([v, fixed].filter(Boolean).join('_'), MAX_STEM_CHARS);
  const e = String(ext || '').trim().toLowerCase();
  return joinName(stem, EXT_RE.test(e) ? e : '');
}

/**
 * A person's typed name: the original's extension is always kept (from its
 * content type when the original has none). A trailing copy of that extension
 * is dropped first; returns null when nothing is left.
 */
export function normaliseEditedName(typed, originalFileName, contentType = null) {
  if (typeof typed !== 'string') return null;
  const ext = extensionFor(originalFileName, contentType);
  let stem = typed.trim();
  if (ext && stem.toLowerCase().endsWith(`.${ext.toLowerCase()}`)) stem = stem.slice(0, -(ext.length + 1));
  stem = cpSlice(cleanNamePart(stem), MAX_STEM_CHARS).trim();
  if (!stem) return null;
  return joinName(stem, ext);
}

/** Add " (2)", " (3)"… until the name is not one of `taken` (case-insensitive). */
export function uniqueName(name, taken = []) {
  const used = new Set((taken || []).filter(Boolean).map((n) => String(n).toLowerCase()));
  if (!used.has(String(name).toLowerCase())) return name;
  const ext = fileExtension(name);
  const stem = ext ? fileStem(name) : name;
  for (let i = 2; i < 1000; i += 1) {
    const suffix = ` (${i})${ext ? `.${ext}` : ''}`;
    const candidate = `${cpSlice(stem, MAX_NAME_CHARS - cpLength(suffix))}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return name;
}

/**
 * The vendor a person typed, worth learning for the sender's domain. Only a
 * name in the house shape counts: `Vendor_<something with a digit>…`
 * ("Acme Supplies_INV-12_2026_11_23.pdf"), never "Signed_W9.pdf" or
 * "Copy_of_invoice.pdf". The head must pass plausibleVendor (not generic, not
 * us, not a platform).
 */
export function vendorFromEditedName(name, internalDomains = []) {
  const parts = fileStem(name).split('_');
  if (parts.length < 2) return null;
  if (!parts.slice(1).some((p) => /\d/.test(p))) return null;
  const head = cleanNamePart(parts[0]);
  if (!head || /^\d/.test(head)) return null;
  const vendor = plausibleVendor(head, internalDomains);
  return vendor && vendor === head ? vendor : null;
}

// ----------------------------------------------------------------- payload

/** The name columns, for Prisma selects of attachment rows. */
export const NAME_SELECT = { displayName: true, nameSource: true, nameDetails: true, namedAt: true, namedBy: true };

/** The name fields every attachment payload carries (contract in RULES-names.md). */
export function withNameFields(row) {
  if (!row || typeof row !== 'object') return row;
  return {
    ...row,
    displayName: row.displayName ?? null,
    originalName: row.fileName,
    nameSource: row.nameSource ?? null,
    nameDetails: row.nameDetails ?? null,
    namedAt: row.namedAt ?? null,
    namedBy: row.namedBy ?? null,
  };
}

/** The name a file is shown and downloaded under. */
export const shownName = (row) => row?.displayName || row?.fileName || 'file';

// ---------------------------------------------------------- download header

function rfc5987(value) {
  return encodeURIComponent(value).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** `attachment; filename="ascii"; filename*=UTF-8''encoded` for any name. */
export function contentDisposition(name, type = 'attachment') {
  const full = String(name || 'file').replace(/[\r\n]+/g, ' ');
  const ascii = full.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_') || 'file';
  return `${type}; filename="${ascii}"; filename*=UTF-8''${rfc5987(full)}`;
}
