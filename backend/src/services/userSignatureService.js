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

const TEMPLATE_VARIABLE_PATTERN = /\{\{\s*(name|title|email|phone|mobile)\s*\}\}/gi;
// {{#phone}}…{{/phone}} — the span is kept only when that person HAS the value.
// Not everyone in the GAL has a direct line; "T:" with nothing after it is worse
// than no "T:" at all.
const TEMPLATE_SECTION_PATTERN = /\{\{\s*#\s*(name|title|email|phone|mobile)\s*\}\}([\s\S]*?)\{\{\s*\/\s*\1\s*\}\}/gi;

/**
 * The BGC company signature (Vahid, 18 Sep 2026 — transcribed from the Outlook
 * "ReplySignature" file every employee gets): Calibri; the name 12pt bold navy
 * #0c1975; title and company 10pt; a blank line; then T: / M: / E: with navy
 * bold labels and the address as a #0563c1 underlined link; the website under
 * it. Zero paragraph margins (spacing "tight"). No sign-off line — people end
 * their own message.
 *
 * Colour is stated on EVERY span rather than inherited: mail clients restyle
 * bare text, and the first thing Vahid noticed was the colour scheme.
 */
const SIG_P = 'margin-top:0pt; margin-bottom:0pt; font-family:Calibri,Arial,sans-serif;';
const SIG_INK = 'color:#000000;';
const SIG_NAVY = 'color:#0c1975;';
const SIG_LINK = 'color:#0563c1;';
export const COMPANY_SIGNATURE_TEMPLATE = [
  `<p style="${SIG_P} font-size:12pt;"><strong><span style="${SIG_NAVY}">{{name}}</span></strong></p>`,
  `{{#title}}<p style="${SIG_P} font-size:10pt; ${SIG_INK}">{{title}}</p>{{/title}}`,
  `<p style="${SIG_P} font-size:10pt; ${SIG_INK}">BGC Engineering</p>`,
  `<p style="${SIG_P} font-size:10pt;">&nbsp;</p>`,
  `<p style="${SIG_P} font-size:10pt; ${SIG_INK}">`
    + `{{#phone}}<strong><span style="${SIG_NAVY}">T:</span></strong>&nbsp;{{phone}}&nbsp;&nbsp;{{/phone}}`
    + `{{#mobile}}<strong><span style="${SIG_NAVY}">M:</span></strong>&nbsp;{{mobile}}&nbsp;&nbsp;{{/mobile}}`
    + `<strong><span style="${SIG_NAVY}">E:</span></strong>&nbsp;<a href="mailto:{{email}}" style="text-decoration:none;"><u><span style="${SIG_LINK}">{{email}}</span></u></a></p>`,
  `<p style="${SIG_P} font-size:10pt;"><a href="https://www.bgcengineering.ca" style="text-decoration:none;"><u><span style="${SIG_LINK}">www.bgcengineering.ca</span></u></a></p>`,
].join('');

/**
 * GAL phone numbers arrive as "1-604-256-1414", "+1 6048308980", "6042567718"
 * and "+15873235325". The signature prints NANP numbers one way: 604-256-1414.
 * Anything that is not a 10-digit NANP number (extensions, other countries) is
 * left exactly as the directory has it.
 */
export function formatSignaturePhone(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (/[a-z]/i.test(raw)) return raw; // "x123", "ext. 4"
  let digits = raw.replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('1')) digits = digits.slice(1);
  if (digits.length !== 10 || raw.startsWith('+') && !raw.startsWith('+1')) return raw;
  return `${digits.slice(0, 3)}-${digits.slice(3, 6)}-${digits.slice(6)}`;
}

/**
 * Line spacing (QA 09-08). A signature pasted from Outlook arrives as bare
 * <p> lines: the composer's paste filter keeps `color` but drops `margin`
 * (it was never on the inline-style allowlist) along with the MsoNormal
 * class, so the paragraphs lose the `margin:0` Outlook gave them. Every mail
 * client then applies its own ~1em paragraph margin and the signature renders
 * far looser than the same signature sent from FreshService.
 *
 * Rather than trust whatever margins survive a paste, the spacing is an
 * explicit per-signature choice applied to <p> at send time. Only <p> is
 * touched: <div> has no default margin, so rewriting it would collapse
 * deliberate layout in table/div signatures for no benefit.
 */
export const SIGNATURE_SPACINGS = Object.freeze(['tight', 'normal', 'relaxed']);
export const DEFAULT_SIGNATURE_SPACING = 'tight';
const SPACING_MARGIN = Object.freeze({
  tight: '0',
  normal: '0 0 6px',
  relaxed: '0 0 12px',
});

export function normalizeSpacing(value) {
  const wanted = String(value || '').trim().toLowerCase();
  return SIGNATURE_SPACINGS.includes(wanted) ? wanted : DEFAULT_SIGNATURE_SPACING;
}

/** Drop every margin declaration from an inline style string. */
function stripMarginDeclarations(style) {
  return String(style || '')
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl && !/^margin(?:-top|-bottom|-left|-right)?\s*:/i.test(decl))
    .join('; ');
}

/**
 * Force the chosen line spacing onto the signature's <p> elements. Inline
 * styles only — mail clients strip <style> blocks, so a class-based rule
 * would work in our preview and nowhere else.
 */
export function applySignatureSpacing(html, spacing = DEFAULT_SIGNATURE_SPACING) {
  const raw = String(html || '');
  if (!raw.trim()) return raw;
  const margin = SPACING_MARGIN[normalizeSpacing(spacing)];
  return raw.replace(/<p\b([^>]*)>/gi, (match, attrs) => {
    const styleMatch = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
    const existing = styleMatch ? (styleMatch[1] ?? styleMatch[2] ?? '') : '';
    const kept = stripMarginDeclarations(existing);
    const style = kept ? `margin: ${margin}; ${kept}` : `margin: ${margin}`;
    const rest = styleMatch ? attrs.replace(styleMatch[0], '') : attrs;
    return `<p${rest.trimEnd()} style="${style}">`;
  });
}

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
      spacing: DEFAULT_SIGNATURE_SPACING,
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
    spacing: normalizeSpacing(row.spacing),
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
  const spacing = input.spacing !== undefined
    ? normalizeSpacing(input.spacing)
    : normalizeSpacing(existing?.spacing);
  const updatedBy = actorEmail(actor) || email;

  const row = await client.upsert({
    where: { workspaceId_ownerEmail: { workspaceId: wsId, ownerEmail: email } },
    create: { workspaceId: wsId, ownerEmail: email, enabled, html, text, spacing, updatedBy },
    update: { enabled, html, text, spacing, updatedBy },
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
      spacing: normalizeSpacing(row.spacing),
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
const TRAILING_BLANK_RE = /(?:\s|&nbsp;|\u00a0|<br\s*\/?>|<(p|div)\b[^>]*>(?:\s|&nbsp;|\u00a0|<br\s*\/?>)*<\/\1>)+$/i;
const TRAILING_BLANK_IN_BLOCK_RE = /(?:\s|&nbsp;|\u00a0|<br\s*\/?>)+(<\/(?:p|div)>)$/i;

/** Drop blank lines from the END of a message: empty blocks, <br>s, and <br>s just inside the last block. */
export function trimTrailingBlankHtml(html) {
  let out = String(html || '');
  for (let pass = 0; pass < 4; pass += 1) {
    const next = out.replace(TRAILING_BLANK_RE, '').replace(TRAILING_BLANK_IN_BLOCK_RE, '$1');
    if (next === out) break;
    out = next;
  }
  // Never trim a message down to nothing.
  return out.trim() ? out : String(html || '');
}

/**
 * A message that ends with a <p> carries that paragraph's bottom margin — about
 * a line in browsers, nothing in Outlook desktop — on top of our own <br>. Zero
 * it on the LAST paragraph only, so the gap is exactly one line everywhere.
 */
export function closeLastParagraphTight(html) {
  const out = String(html || '');
  if (!/<\/p>\s*$/i.test(out)) return out;
  const matches = [...out.matchAll(/<p(?=[\s>])([^>]*)>/gi)];
  const last = matches[matches.length - 1];
  if (!last) return out;
  const attrs = last[1] || '';
  const styleMatch = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(attrs);
  const existing = styleMatch ? (styleMatch[1] ?? styleMatch[2] ?? '') : '';
  const kept = existing.split(';').map((d) => d.trim()).filter((d) => d && !/^margin-bottom\s*:/i.test(d));
  const style = [...kept, 'margin-bottom:0'].join('; ');
  const rest = styleMatch ? attrs.replace(styleMatch[0], '') : attrs;
  const tag = `<p${rest.trimEnd()} style="${style}">`;
  return `${out.slice(0, last.index)}${tag}${out.slice(last.index + last[0].length)}`;
}

export function appendSignatureToEmail(email = {}, signature = null) {
  // Spacing is applied here, not at save time: the stored HTML stays exactly
  // what the author pasted, so changing the preference re-renders rather than
  // rewriting (and never compounds margins across saves).
  const signatureHtml = applySignatureSpacing(String(signature?.html || '').trim(), signature?.spacing);
  const signatureText = String(signature?.text || stripHtml(signatureHtml)).trim();
  if (!signatureHtml && !signatureText) return { ...email };

  // ONE blank line between the message and the signature (Vahid, 18 Sep 2026).
  // It used to be `<br><br>` after whatever the body ended with — and a body
  // usually ends with a paragraph margin plus the blank line people leave under
  // "Thank you," — which stacked to three or four lines of air.
  const baseHtml = closeLastParagraphTight(trimTrailingBlankHtml(String(email.html || '').trim()));
  const baseText = String(email.text || stripHtml(email.html)).trim();
  const html = baseHtml
    ? `${baseHtml}<br>${signatureHtml || signatureText}`
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

  return { members: [...members, ...others], maxHtmlBytes: MAX_SIGNATURE_HTML_BYTES, companyTemplate: COMPANY_SIGNATURE_TEMPLATE };
}

const escapeTemplateValue = (value) => String(value ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/**
 * Substitute {{name}} / {{title}} / {{email}} / {{phone}} / {{mobile}} tokens
 * (whitespace-tolerant), after resolving {{#key}}…{{/key}} sections. Values are
 * directory data, not markup — they are escaped on the way in.
 */
export function applySignatureTemplate(template, fields = {}) {
  const valueOf = (key) => {
    const value = fields[String(key).toLowerCase()];
    return value === undefined || value === null ? '' : String(value).trim();
  };
  return String(template || '')
    .replace(TEMPLATE_SECTION_PATTERN, (match, key, inner) => (valueOf(key) ? inner : ''))
    .replace(TEMPLATE_VARIABLE_PATTERN, (match, key) => escapeTemplateValue(valueOf(key)));
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
  let phone = '';
  let mobile = '';
  if (email && azureAdService.isConfigured?.()) {
    const profile = await azureAdService.getUserProfile(email).catch(() => null);
    title = profile?.jobTitle || null;
    phone = formatSignaturePhone(profile?.businessPhone);
    mobile = formatSignaturePhone(profile?.mobilePhone);
  }
  return {
    name: technician.name || email || '',
    title: title || '',
    email,
    phone,
    mobile,
  };
}

/**
 * Mass-apply a signature template to selected workspace members.
 * `preview: true` renders per-member substituted signatures WITHOUT writing —
 * the admin sees exactly what each person gets before committing.
 */
export async function massApplySignatureTemplate(workspaceId, { template, technicianIds, preview = false, useCompanyTemplate = false } = {}, actor = null) {
  const wsId = normalizeWorkspaceId(workspaceId);
  // The company signature never round-trips through the browser's rich-text
  // editor, which drops font-family/size and would flatten it to default text.
  const rawTemplate = useCompanyTemplate === true
    ? COMPANY_SIGNATURE_TEMPLATE
    : String(template || '').trim();
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
    const saved = await saveSignature(wsId, technician.email, { html, text, enabled: true, ...(useCompanyTemplate === true ? { spacing: 'tight' } : {}) }, actor);
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
