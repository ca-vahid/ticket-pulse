/**
 * Approval e-mails (MEGA-0901 AP-2; reply format since 26 Oct 2026). Each one
 * reads like a message in the ticket's e-mail conversation: the sender's
 * words, their signature, one grey hint, one plain link, then the history
 * (rendered by ticketService._lastInboundQuote, photos and pictures inline as
 * cid: attachments). Inline-styled, Outlook-safe, no painted surfaces.
 *
 * Everything user-supplied is escaped here; the request note arrives already
 * sanitized by ticketApprovalService (allow-list) and is only *normalized* for
 * mail clients (fixed widths / empty spreadsheet columns stripped, borders
 * and padding applied) — see normalizeNoteHtmlForEmail.
 */
import sanitizeHtml from 'sanitize-html';
import { brandImg } from './emailBrandAssets.js';

const FONT = 'Arial,Helvetica,sans-serif';
const INK = '#0f172a';
const MUTED = '#64748b';
const LINE = '#e2e8f0';
const BLUE = '#2563eb';

export function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'America/Vancouver' });
const DATE_FULL_FMT = new Intl.DateTimeFormat('en-US', { month: 'long', day: 'numeric', year: 'numeric', timeZone: 'America/Vancouver' });
export function fmtDay(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : DATE_FMT.format(d);
}
export function fmtDayLong(value) {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  return Number.isNaN(d.getTime()) ? null : DATE_FULL_FMT.format(d);
}

/** Plain-text excerpt of ticket HTML/text for the description preview. */
export function textExcerpt(html, max = 480) {
  const text = String(html || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>|<\/p>|<\/div>|<\/li>|<\/tr>|<\/h[1-6]>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&quot;/gi, '"').replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\s*\n\s*/g, '\n')
    .trim();
  if (!text) return { text: '', truncated: false };
  if (text.length <= max) return { text, truncated: false };
  const cut = text.slice(0, max);
  const at = Math.max(cut.lastIndexOf(' '), cut.lastIndexOf('\n'));
  return { text: `${cut.slice(0, at > max * 0.6 ? at : max).trim()}…`, truncated: true };
}

/**
 * The ticket description as mail-safe HTML: headings, lists, bold, code,
 * links and tables survive (the note normalizer plus the description-only
 * tags); inline styles that fight the mail client are dropped. Long
 * descriptions are cut at `maxChars` of VISIBLE text on a block boundary and
 * flagged `truncated` so the caller can point at the approval page.
 */
export function descriptionHtmlForEmail(html, { maxChars = 6000 } = {}) {
  const raw = String(html || '').trim();
  if (!raw) return { html: '', truncated: false };
  const looksHtml = /<[a-z][\s\S]*>/i.test(raw);
  const source = looksHtml ? raw : `<p>${escapeHtml(raw).replace(/\r?\n/g, '<br>')}</p>`;
  const clean = sanitizeHtml(source, {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 's', 'ul', 'ol', 'li', 'a', 'span', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption', 'h1', 'h2', 'h3', 'h4', 'blockquote', 'pre', 'code', 'hr'],
    allowedAttributes: { a: ['href', 'target', 'rel', 'style'], td: ['colspan', 'rowspan', 'style'], th: ['colspan', 'rowspan', 'style', 'align'], table: ['cellpadding', 'cellspacing', 'border', 'style'], p: ['style'], h1: ['style'], h2: ['style'], h3: ['style'], h4: ['style'], ul: ['style'], ol: ['style'], li: ['style'], pre: ['style'], code: ['style'], blockquote: ['style'], hr: ['style'], span: [], div: [] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      table: () => ({ tagName: 'table', attribs: { cellpadding: '0', cellspacing: '0', border: '0', style: 'border-collapse:collapse;margin:8px 0;' } }),
      td: (tag, attribs) => ({ tagName: 'td', attribs: { ...pick(attribs, ['colspan', 'rowspan']), style: CELL_STYLE } }),
      th: (tag, attribs) => ({ tagName: 'th', attribs: { ...pick(attribs, ['colspan', 'rowspan']), style: HEAD_STYLE, align: 'left' } }),
      a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href || '#', target: '_blank', rel: 'noreferrer', style: `color:${BLUE};` } }),
      p: () => ({ tagName: 'p', attribs: { style: 'margin:0 0 10px;' } }),
      h1: () => ({ tagName: 'h3', attribs: { style: 'margin:14px 0 6px;font-size:15px;line-height:20px;font-weight:bold;color:#0f172a;' } }),
      h2: () => ({ tagName: 'h3', attribs: { style: 'margin:14px 0 6px;font-size:15px;line-height:20px;font-weight:bold;color:#0f172a;' } }),
      h3: () => ({ tagName: 'h3', attribs: { style: 'margin:14px 0 6px;font-size:14px;line-height:20px;font-weight:bold;color:#0f172a;' } }),
      h4: () => ({ tagName: 'h4', attribs: { style: 'margin:12px 0 4px;font-size:13.5px;line-height:19px;font-weight:bold;color:#0f172a;' } }),
      ul: () => ({ tagName: 'ul', attribs: { style: 'margin:0 0 10px;padding-left:22px;' } }),
      ol: () => ({ tagName: 'ol', attribs: { style: 'margin:0 0 10px;padding-left:22px;' } }),
      li: () => ({ tagName: 'li', attribs: { style: 'margin:0 0 4px;' } }),
      pre: () => ({ tagName: 'pre', attribs: { style: 'margin:0 0 10px;padding:8px 10px;background:#f1f5f9;border:1px solid #e2e8f0;font-family:Consolas,\'Courier New\',monospace;font-size:12.5px;line-height:18px;white-space:pre-wrap;word-break:break-word;color:#0f172a;' } }),
      code: () => ({ tagName: 'code', attribs: { style: 'font-family:Consolas,\'Courier New\',monospace;font-size:12.5px;background:#f1f5f9;padding:1px 4px;' } }),
      blockquote: () => ({ tagName: 'blockquote', attribs: { style: 'margin:0 0 10px;padding:2px 0 2px 12px;border-left:3px solid #cbd5e1;color:#475569;' } }),
      hr: () => ({ tagName: 'hr', attribs: { style: 'border:0;border-top:1px solid #e2e8f0;margin:12px 0;' } }),
    },
  }).trim();
  if (!clean) return { html: '', truncated: false };
  const withoutEmptyCols = clean.replace(/<table\b[\s\S]*?<\/table>/gi, (t) => dropEmptyTableColumns(t));
  // Cap on visible text, cutting after the top-level block that crosses the limit.
  let truncated = false;
  let out = withoutEmptyCols;
  const visible = textExcerpt(withoutEmptyCols, Number.MAX_SAFE_INTEGER).text;
  if (visible.length > maxChars) {
    truncated = true;
    const blocks = withoutEmptyCols.split(/(?<=<\/(?:p|div|ul|ol|table|h3|h4|pre|blockquote)>)/i);
    let acc = ''; let seen = 0;
    for (const b of blocks) {
      acc += b;
      seen += textExcerpt(b, Number.MAX_SAFE_INTEGER).text.length;
      if (seen >= maxChars) break;
    }
    out = acc || withoutEmptyCols.slice(0, maxChars);
  }
  out = out.replace(/<table\b/gi, '<div style="overflow-x:auto;max-width:100%;"><table').replace(/<\/table>/gi, '</table></div>');
  return { html: out, truncated };
}

const CELL_STYLE = 'border:1px solid #cbd5e1;padding:6px 8px;font-family:Arial,Helvetica,sans-serif;font-size:13px;line-height:18px;vertical-align:top;color:#0f172a;';
const HEAD_STYLE = `${CELL_STYLE}background:#f1f5f9;font-weight:bold;`;

function cellIsEmpty(inner) {
  return !String(inner || '').replace(/<[^>]+>/g, '').replace(/&nbsp;/gi, '').replace(/\u00a0/g, '').trim();
}

/**
 * Drop spreadsheet columns that are empty in EVERY row (Excel/Outlook pastes
 * carry a dozen blank cells), and rows that are empty end to end. Tables with
 * colspan/rowspan are left alone — index arithmetic would lie.
 */
export function dropEmptyTableColumns(tableHtml) {
  if (/colspan|rowspan/i.test(tableHtml)) return tableHtml;
  const rowRe = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  const cellRe = /<(td|th)\b([^>]*)>([\s\S]*?)<\/\1>/gi;
  const rows = [];
  let m;
  while ((m = rowRe.exec(tableHtml))) {
    const cells = [];
    let c;
    while ((c = cellRe.exec(m[1]))) cells.push({ tag: c[1], attrs: c[2], inner: c[3] });
    rows.push({ full: m[0], open: m[0].slice(0, m[0].indexOf('>') + 1), cells });
  }
  if (rows.length === 0) return tableHtml;
  const width = Math.max(...rows.map((r) => r.cells.length));
  const keep = [];
  for (let i = 0; i < width; i += 1) keep.push(rows.some((r) => r.cells[i] && !cellIsEmpty(r.cells[i].inner)));
  if (keep.every(Boolean) && rows.every((r) => r.cells.some((cell) => !cellIsEmpty(cell.inner)))) return tableHtml;
  let out = tableHtml;
  for (const row of rows) {
    const kept = row.cells.filter((cell, i) => keep[i]);
    const rebuilt = kept.length === 0 || kept.every((cell) => cellIsEmpty(cell.inner))
      ? ''
      : `${row.open}${kept.map((cell) => `<${cell.tag}${cell.attrs}>${cell.inner}</${cell.tag}>`).join('')}</tr>`;
    out = out.replace(row.full, rebuilt);
  }
  return out;
}

/**
 * Mail-client normalization of an already-sanitized rich note: strip fixed
 * widths / heights / inline styles that made pasted tables crush into one
 * unreadable line, apply borders + padding, drop empty columns, and keep the
 * rest (lists, links, emphasis) as-is.
 */
export function normalizeNoteHtmlForEmail(html) {
  const clean = sanitizeHtml(String(html || ''), {
    allowedTags: ['p', 'br', 'b', 'strong', 'i', 'em', 'u', 'ul', 'ol', 'li', 'a', 'span', 'div', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th', 'caption'],
    allowedAttributes: { a: ['href', 'target', 'rel', 'style'], td: ['colspan', 'rowspan', 'style'], th: ['colspan', 'rowspan', 'style', 'align'], table: ['cellpadding', 'cellspacing', 'border', 'style'], p: ['style'], span: [], div: [] },
    allowedSchemes: ['http', 'https', 'mailto'],
    transformTags: {
      table: () => ({ tagName: 'table', attribs: { cellpadding: '0', cellspacing: '0', border: '0', style: 'border-collapse:collapse;margin:8px 0;' } }),
      td: (tag, attribs) => ({ tagName: 'td', attribs: { ...pick(attribs, ['colspan', 'rowspan']), style: CELL_STYLE } }),
      th: (tag, attribs) => ({ tagName: 'th', attribs: { ...pick(attribs, ['colspan', 'rowspan']), style: HEAD_STYLE, align: 'left' } }),
      a: (tag, attribs) => ({ tagName: 'a', attribs: { href: attribs.href || '#', target: '_blank', rel: 'noreferrer', style: `color:${BLUE};` } }),
      p: () => ({ tagName: 'p', attribs: { style: 'margin:0 0 8px;' } }),
    },
  }).trim();
  const withoutEmptyCols = clean.replace(/<table\b[\s\S]*?<\/table>/gi, (t) => dropEmptyTableColumns(t));
  // A wide table must scroll, not blow the card open: wrap in an overflow container (ignored by
  // Outlook desktop, which simply lets the table run — still readable now that widths are gone).
  return withoutEmptyCols.replace(/<table\b/gi, '<div style="overflow-x:auto;max-width:100%;"><table').replace(/<\/table>/gi, '</table></div>');
}

function pick(obj, keys) {
  const out = {};
  for (const k of keys) if (obj && obj[k] !== null && obj[k] !== undefined && obj[k] !== '') out[k] = obj[k];
  return out;
}

// ---------------------------------------------------------------- the shell
//
// emailShell (the 17 Sep 2026 pictogram shell) is kept for the urgent-response
// notifier; the approval e-mails no longer use a shell (26 Oct 2026).

/**
 * The shell: slate ground → 640px white card with a brand band on top and a
 * muted footer below. `bodyRows` are <tr> strings for the card body table.
 * The band carries the Ticket Pulse mark and the workspace — no status pill;
 * the hero block inside the body says what the message is.
 */
export function emailShell({ workspaceName, bodyRows, footerHtml, preheader = '' }) {
  const mark = brandImg('tp-mark', { size: 32, alt: 'Ticket Pulse' })
    || `<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="32" height="32" align="center" valign="middle" bgcolor="${BLUE}" style="width:32px;height:32px;border-radius:8px;background:${BLUE};color:#ffffff;font-family:${FONT};font-size:13px;font-weight:bold;line-height:32px;">TP</td></tr></table>`;
  const band = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>',
    `<td width="32" valign="middle" style="padding:0 10px 0 0;">${mark}</td>`,
    `<td valign="middle" style="font-family:${FONT};font-size:15px;line-height:19px;font-weight:bold;color:${INK};">Ticket Pulse</td>`,
    `<td align="right" valign="middle" style="font-family:${FONT};font-size:12px;line-height:16px;color:${MUTED};">${escapeHtml(workspaceName ? `${workspaceName} workspace` : 'Service desk')}</td>`,
    '</tr></table>',
  ].join('');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title></title></head>',
    '<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;">',
    preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f1f5f9;">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>` : '',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#f1f5f9;"><tr><td align="center" style="padding:24px 12px;">',
    '<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:16px;">`,
    `<tr><td style="padding:16px 28px;border-bottom:1px solid ${LINE};">${band}</td></tr>`,
    '<tr><td style="padding:26px 28px 8px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">',
    bodyRows.join(''),
    '</table>',
    '</td></tr>',
    `<tr><td style="padding:14px 28px 20px;border-top:1px solid ${LINE};font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${footerHtml}</td></tr>`,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table></body></html>',
  ].join('');
}


// ---------------------------------------------------------------- the e-mails
//
// 26 Oct 2026 (Vahid): every approval e-mail reads like the e-mail
// conversation itself, not a branded card — the person's own words, their
// signature, ONE grey hint line, one plain link where there is something to
// do, then "Earlier in this conversation" (ticketService._lastInboundQuote,
// passed in as `quoteHtml`). The model is approvalConversationService's
// _emailAsReply (4.3.21).
//
// Outlook-safe and dark-mode-safe: no painted surfaces, no buttons, no
// gradients; every piece of text carries its own colour, so a dark-mode
// client only has text to recolour.

export const REPLY_FONT = "Calibri,'Segoe UI',Arial,sans-serif";
const R_INK = '#111827';
const R_SOFT = '#374151';
const R_HINT = '#6b7280';
const R_LINK = '#1d4ed8';
const R_GO = '#0f7a4f';
const R_NO = '#b42318';
const R_TEXT = `font-family:${REPLY_FONT};font-size:14.5px;line-height:21px;color:${R_INK};`;

/** Adds ?intent= to the decision link (keeps any query string the link already has). */
export function decisionIntentUrl(url, intent) {
  if (!url) return url;
  return `${url}${url.includes('?') ? '&' : '?'}intent=${encodeURIComponent(intent)}`;
}

const firstNameOf = (name) => String(name || '').trim().split(/\s+/)[0] || null;
const paragraphsOf = (text) => String(text || '').trim().split(/\n{2,}/).map((p) => escapeHtml(p.trim()).replace(/\r?\n/g, '<br>')).filter(Boolean);

/** A paragraph of the message. `html` is trusted (callers escape). */
export const replyPara = (html, margin = '0 0 12px') => `<p style="${R_TEXT}margin:${margin};">${html}</p>`;

/** The one grey line under the message (same as _emailAsReply's hint). `html` is trusted. */
export function replyHint(html, margin = '22px 0 0') {
  return `<p style="font-family:${REPLY_FONT};font-size:12.5px;line-height:18px;color:${R_HINT};margin:${margin};">${html}</p>`;
}

/** One plain link line: "Decide on this request →". */
export function replyLink(label, href, margin = '18px 0 0') {
  if (!href) return '';
  return `<p style="font-family:${REPLY_FONT};font-size:14px;line-height:20px;margin:${margin};"><a href="${escapeHtml(href)}" target="_blank" style="color:${R_LINK};font-weight:600;text-decoration:none;">${escapeHtml(label)}&nbsp;&rarr;</a></p>`;
}

const inlineLink = (label, href) => (href ? `<a href="${escapeHtml(href)}" target="_blank" style="color:${R_LINK};text-decoration:none;">${escapeHtml(label)}</a>` : escapeHtml(label));

/** Plain text as the person wrote it, one <p> per paragraph. */
const replyText = (text) => paragraphsOf(text).map((p) => replyPara(p)).join('');

/** Rich text (already sanitized) as written; the wrapper only sets the type. */
const replyRich = (html) => (html ? `<div style="${R_TEXT}margin:0 0 12px;">${html}</div>` : '');

/** The message body: rich when there is HTML, else the plain text. */
function messageBody(bodyHtml, bodyText) {
  if (bodyHtml) return replyRich(normalizeNoteHtmlForEmail(bodyHtml) || bodyHtml);
  return replyText(bodyText);
}

const replySignature = (html) => (html ? `<div style="${R_TEXT}margin:14px 0 0;">${html}</div>` : '');

/** "Label: value" lines in one paragraph — the facts, only where present. */
function replyFacts(lines) {
  const list = lines.filter(Boolean);
  if (!list.length) return '';
  return replyPara(list.map(([label, value]) => `<span style="color:${R_SOFT};font-weight:600;">${escapeHtml(label)}:</span> ${value}`).join('<br>'));
}

const replyList = (itemsHtml) => (itemsHtml.length
  ? `<ol style="${R_TEXT}margin:0 0 12px;padding:0 0 0 22px;">${itemsHtml.map((li) => `<li style="margin:0 0 6px;">${li}</li>`).join('')}</ol>`
  : '');

/** Ticket ref, linked when the reader can open the ticket. */
const refHtml = (t, href = t?.appUrl) => (t?.ref ? inlineLink(t.ref, href || null) : null);

/** The reply-format document: body, then the history. No shell, no card — a plain message. */
const replyDocument = (parts, quoteHtml = '') => `${parts.filter(Boolean).join('')}${quoteHtml || ''}`;

const verdictWordOf = (approved, conditionNote) => (!approved ? 'Not approved' : conditionNote ? (/\n/.test(conditionNote) ? 'Approved with conditions' : 'Approved with condition') : 'Approved');

const RESPONSE_WORD = { can_meet: 'Can be met', cant_meet: "Can't be met as asked" };

/** "Can be met: …" / "Can't be met as asked: …" with the verdict words coloured. */
function answerLineHtml(line) {
  const hit = [[RESPONSE_WORD.can_meet, R_GO], [RESPONSE_WORD.cant_meet, R_NO], ['Not answered', R_HINT]].find(([w]) => line.startsWith(w));
  if (!hit) return `<span style="color:${R_SOFT};">${escapeHtml(line)}</span>`;
  return `<span style="color:${hit[1]};font-weight:600;">${escapeHtml(hit[0])}</span><span style="color:${R_SOFT};">${escapeHtml(line.slice(hit[0].length))}</span>`;
}

/**
 * Agreed conditions: several read as a list; one stays a sentence. Reads the
 * agreed summary ("1. text" + an indented "Can be met: answer" line, see
 * approvalConditions.agreedSummary) as well as plain one-per-line text.
 */
function conditionNoteHtml(conditionNote) {
  const items = [];
  for (const raw of String(conditionNote || '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const numbered = raw.match(/^\s*\d+[.)]\s+(.*)$/);
    if (numbered) items.push({ text: numbered[1].trim(), sub: [] });
    else if (/^\s{2,}/.test(raw) && items.length) items[items.length - 1].sub.push(raw.trim());
    else items.push({ text: raw.trim(), sub: [] });
  }
  if (!items.length) return '';
  const itemHtml = (i) => `${escapeHtml(i.text)}${i.sub.map((s) => `<br>${answerLineHtml(s)}`).join('')}`;
  if (items.length === 1) return replyPara(`<span style="color:${R_SOFT};font-weight:600;">Condition:</span> ${itemHtml(items[0])}`);
  return replyPara(`<span style="color:${R_SOFT};font-weight:600;">Agreed conditions:</span>`, '0 0 4px') + replyList(items.map(itemHtml));
}

/** The conditions as a numbered list, with the technician's answer under each when there is one. */
function conditionsList(items, { answers = true } = {}) {
  return replyList((items || []).map((i) => {
    const text = escapeHtml(i.text).replace(/\n/g, '<br>');
    if (!answers || !i.response) return text;
    const colour = i.response === 'cant_meet' ? R_NO : R_GO;
    return `${text}<br><span style="color:${colour};font-weight:600;">${escapeHtml(RESPONSE_WORD[i.response] || '')}</span>`
      + `${i.answer ? `<span style="color:${R_SOFT};"> &mdash; ${escapeHtml(i.answer).replace(/\n/g, '<br>')}</span>` : ''}`;
  }));
}

/**
 * Approver: the agent asks them to decide. Written as the AGENT's message.
 * ctx: { categoryName, ticket:{ref, subject, appUrl}, requester:{name,title,department,location},
 *   requestedByName, approverName, noteHtml (sanitized, placeholders done), clarification:{question,answer,answeredBy}|null,
 *   conditions, otherApprovers:[{name,status}], decisionUrl, expiresAt, amountLabel?, tierLabel?, handoff?, laptops?,
 *   signatureHtml?, quoteHtml? }
 */
export function renderApproverRequestEmail(ctx) {
  const t = ctx.ticket || {};
  const requester = ctx.requester || {};
  const agentName = ctx.requestedByName || 'The service desk';
  const body = [];

  body.push(replyPara(firstNameOf(ctx.approverName) ? `Hi ${escapeHtml(firstNameOf(ctx.approverName))},` : 'Hello,'));

  // One plain sentence: who asks, what, for whom (title, office), on which ticket.
  const place = [
    requester.location && !(requester.title || '').toLowerCase().includes(String(requester.location).toLowerCase()) ? requester.location : null,
    requester.department && requester.department !== requester.location ? requester.department : null,
  ].filter(Boolean)[0] || null;
  const detail = [requester.title, place].filter(Boolean).join(', ');
  const forWhom = requester.name ? ` for ${escapeHtml(requester.name)}${detail ? ` (${escapeHtml(detail)})` : ''}` : '';
  const what = ctx.categoryName ? escapeHtml(ctx.categoryName) : (t.subject ? `&ldquo;${escapeHtml(t.subject)}&rdquo;` : 'a request');
  const ref = refHtml(t);
  const conditionItems = ctx.conditions && Array.isArray(ctx.conditions.items) ? ctx.conditions.items : [];
  let again = '';
  if (conditionItems.length) {
    const who = firstNameOf(ctx.conditions.submittedByName) || firstNameOf(agentName) || 'The agent';
    again = ` Here ${conditionItems.length === 1 ? 'is' : 'are'} ${escapeHtml(who)}&rsquo;s ${conditionItems.length === 1 ? 'answer' : 'answers'} to your conditions.`;
  } else if (ctx.clarification?.answer) {
    again = ' Here is the answer you asked for.';
  }
  body.push(replyPara(`${escapeHtml(agentName)} asks you to approve ${what}${forWhom}${ref ? ` on ${ref}` : ''}.${again}`));

  // A re-request leads with what changed: the answers to the conditions, or the answer to the question.
  if (conditionItems.length) {
    body.push(conditionsList(conditionItems));
    const cant = conditionItems.filter((i) => i.response === 'cant_meet').length;
    body.push(replyPara(cant
      ? `${cant} of ${conditionItems.length} can&rsquo;t be met as asked. Approve if you accept that, ask about it, or say no.`
      : 'Approve to accept these answers. The agreed conditions go out with your approval.'));
  }
  if (ctx.clarification?.answer) {
    const answeredBy = ctx.clarification.answeredBy || agentName;
    body.push(replyPara(
      `${ctx.clarification.question ? `<span style="color:${R_SOFT};font-weight:600;">You asked:</span> ${escapeHtml(ctx.clarification.question)}<br>` : ''}`
      + `<span style="color:${R_SOFT};font-weight:600;">${escapeHtml(answeredBy)} replied:</span> ${escapeHtml(ctx.clarification.answer)}`,
    ));
  }

  // The agent's note, formatted as written.
  if (ctx.noteHtml) body.push(replyRich(ctx.noteHtml));

  // Why it is with this approver (Approvals v2 hand-off).
  const h = ctx.handoff;
  if (h && h.kind) {
    const by = escapeHtml(h.byName || 'The previous approver');
    let line;
    if (h.kind === 'forwarded') line = `${by} forwarded this request to you as the final approver.`;
    else if (h.kind === 'auto_start') line = `This request comes to you at <b>${escapeHtml(h.toTierName || 'this tier')}</b> directly: ${escapeHtml(h.note || `${h.byName || 'the requester'} is an approver on the earlier tier and cannot approve their own request`)}.`;
    else if (h.kind === 'auto') line = `${by} approved this at ${escapeHtml(h.fromTierName || 'the previous tier')}, but the amount is over that tier&rsquo;s limit${h.limitLabel ? ` (${escapeHtml(h.limitLabel)})` : ''}, so your approval is needed at ${escapeHtml(h.toTierName || 'this tier')}.`;
    else line = `${by} escalated this request from ${escapeHtml(h.fromTierName || 'the previous tier')} to you (${escapeHtml(h.toTierName || 'next tier')}).`;
    const note = h.note && h.kind !== 'auto_start' ? `<br><span style="color:${R_SOFT};font-weight:600;">Their note:</span> ${escapeHtml(h.note)}` : '';
    body.push(replyPara(`${line}${note}`));
  }

  // The facts, in plain lines, only where present.
  const facts = [];
  if (ctx.amountLabel) facts.push(['Amount', escapeHtml(ctx.amountLabel)]);
  if (ctx.tierLabel) facts.push(['Approval tier', escapeHtml(ctx.tierLabel)]);
  const held = (Array.isArray(ctx.laptops) ? ctx.laptops : (ctx.laptop ? [ctx.laptop] : [])).filter((x) => x && x.asset);
  held.forEach((x, i) => {
    const a = x.asset;
    const id = a.assetTag || (a.serialNumber ? `S/N ${a.serialNumber}` : '');
    const spec = [a.cpu, a.ram, a.storage, a.screenSize].filter(Boolean).join(' · ');
    const to = x.recipient?.name || x.recipient?.email || null;
    facts.push([held.length > 1 ? `Device ${i + 1} reserved` : 'Device reserved',
      `${escapeHtml([a.make, a.model].filter(Boolean).join(' ') || 'Device')}${id ? ` (${escapeHtml(id)})` : ''}${spec ? `, ${escapeHtml(spec)}` : ''}${to ? `; goes to ${escapeHtml(to)} on approval` : ''}`]);
  });
  const others = (ctx.otherApprovers || []).filter((a) => a && a.name);
  if (others.length) {
    facts.push(['Also asked', `${others.map((a) => `${escapeHtml(a.name)}${a.status && a.status !== 'pending' ? ` (${escapeHtml(a.status)})` : ''}`).join(', ')}. The first decision closes the request for everyone.`]);
  }
  body.push(replyFacts(facts));

  body.push(replySignature(ctx.signatureHtml));

  const expires = fmtDayLong(ctx.expiresAt);
  body.push(replyLink('Decide on this request', ctx.decisionUrl, '20px 0 0'));
  body.push(replyHint(`Approve, approve with conditions, ask a question or say no on that page. The link is yours alone${expires ? ` and works until ${escapeHtml(expires)}` : ''}.`, '4px 0 0'));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * The agent who asked: the verdict, as the approver's message. ctx:
 *  { categoryName, ticket:{ref, subject, appUrl}, approved, approverName, isSelf, changedFrom, note, conditionNote,
 *    signatureHtml, requester:{name}, agentName?, quoteHtml? }
 */
export function renderRequesterDecisionEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const verdict = verdictWordOf(approved, ctx.conditionNote);
  const body = [];
  const what = ctx.categoryName ? escapeHtml(ctx.categoryName) : 'Your request';
  const forWhom = ctx.requester?.name ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  const ref = refHtml(t);
  const changed = ctx.changedFrom ? ` (changed from ${escapeHtml(ctx.changedFrom === 'rejected' ? 'not approved' : ctx.changedFrom)})` : '';
  body.push(replyPara(`<b>${escapeHtml(verdict)}.</b>${changed} ${what}${forWhom}${ref ? `, ${ref}` : ''}.`));
  body.push(conditionNoteHtml(ctx.conditionNote));
  if (ctx.note) body.push(replyText(ctx.note));
  body.push(replySignature(ctx.signatureHtml));
  let hint;
  if (ctx.isSelf) hint = 'You decided your own request; this is your copy.';
  else if (approved) hint = ctx.conditionNote ? 'You can carry on with the ticket, within the conditions.' : 'You can carry on with the ticket.';
  else hint = 'The decision and the reason are on the ticket.';
  if (t.appUrl) hint += ` ${inlineLink('Open the ticket', t.appUrl)}`;
  body.push(replyHint(hint));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * The agent who asked: the request moved to another approver (Approvals v2).
 * ctx: { categoryName, ticket:{ref, subject, appUrl}, kind:'escalated'|'forwarded'|'auto', byName, toNames:[…],
 *        toTierName, fromTierName, requester:{name}, agentName?, quoteHtml? }
 * No note on purpose — the approver's reasoning stays between approvers.
 */
export function renderRequesterHandoffEmail(ctx) {
  const t = ctx.ticket || {};
  const names = (ctx.toNames || []).filter(Boolean);
  const who = escapeHtml(names.length ? names.join(', ') : (ctx.toTierName || 'the next approver'));
  const forWhom = ctx.requester?.name ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  const by = escapeHtml(ctx.byName || 'The approver');
  const ref = refHtml(t);
  const on = ref ? ` on ${ref}` : '';
  let sentence;
  if (ctx.kind === 'forwarded') sentence = `${by} forwarded your approval request${forWhom}${on} to ${who}, who will make the final decision.`;
  else if (ctx.kind === 'auto') sentence = `${by} approved your request${forWhom}${on} at ${escapeHtml(ctx.fromTierName || 'Tier 1')}. The amount is above that tier&rsquo;s limit, so it has moved on to ${who} (${escapeHtml(ctx.toTierName || 'next tier')}) for the final approval.`;
  else sentence = `${by} escalated your approval request${forWhom}${on} to ${who} (${escapeHtml(ctx.toTierName || 'next tier')}).`;
  const body = [];
  if (firstNameOf(ctx.agentName)) body.push(replyPara(`Hi ${escapeHtml(firstNameOf(ctx.agentName))},`));
  body.push(replyPara(sentence));
  body.push(replyHint(`Nothing is needed from you; you will hear when it is decided.${t.appUrl ? ` ${inlineLink('Open the ticket', t.appUrl)}` : ''}`));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * The agent who asked: the approver needs more information. ctx:
 *  { categoryName, ticket:{ref, subject, appUrl}, approverName, question, requester:{name}, agentName?, signatureHtml?, quoteHtml? }
 */
export function renderRequesterClarificationEmail(ctx) {
  const t = ctx.ticket || {};
  const approver = ctx.approverName || 'The approver';
  const ref = refHtml(t);
  const body = [];
  if (firstNameOf(ctx.agentName)) body.push(replyPara(`Hi ${escapeHtml(firstNameOf(ctx.agentName))},`));
  body.push(replyPara(`${escapeHtml(approver)} needs more information before deciding the request${ctx.requester?.name ? ` for ${escapeHtml(ctx.requester.name)}` : ''}${ref ? ` on ${ref}` : ''}:`));
  body.push(replyText(ctx.question));
  body.push(replySignature(ctx.signatureHtml));
  body.push(replyLink('Answer on the ticket', t.appUrl));
  body.push(replyHint(`Your answer goes back to ${escapeHtml(firstNameOf(approver) || approver)} by e-mail and the decision link opens again for them.`, '4px 0 0'));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * Approvals v3 — an INTERNAL question / comment / answer (approvers + the
 * agent; never the requester), to one recipient. ctx:
 *  { kind, authorName, bodyHtml|bodyText, signatureHtml?, replyUrl?, canReplyByEmail, decideUrl?,
 *    requesterName?, internalNote, copied:[names]?, via?, quoteHtml? }
 */
export function renderApprovalMessageEmail(ctx) {
  const body = [];
  body.push(messageBody(ctx.bodyHtml, ctx.bodyText));
  body.push(replySignature(ctx.signatureHtml));
  const copied = (ctx.copied || []).filter(Boolean);
  const copiedLine = copied.length ? ` ${escapeHtml(copied.join(', '))} ${copied.length === 1 ? 'is' : 'are'} copied.` : '';
  let hint;
  if (ctx.kind === 'question') {
    if (ctx.canReplyByEmail) hint = `Just reply to this e-mail to answer${ctx.replyUrl ? `, or ${inlineLink('answer on the web', ctx.replyUrl)}` : ''}.${copiedLine}`;
    else hint = `${ctx.replyUrl ? `${inlineLink('Answer on the web', ctx.replyUrl)}; this` : 'This'} mailbox does not read replies.${copiedLine}`;
  } else if (ctx.kind === 'answer') {
    hint = `${escapeHtml(firstNameOf(ctx.authorName) || 'They')} answered${ctx.via === 'email' ? ' by e-mail' : ''}.${ctx.canReplyByEmail ? ' Reply to this e-mail to add to the conversation.' : ''}${copiedLine}`;
  } else {
    hint = `${ctx.canReplyByEmail ? 'Reply to this e-mail to add to the conversation.' : (ctx.replyUrl ? inlineLink('Reply on the web', ctx.replyUrl) : '')}${copiedLine}`;
  }
  if (hint.trim()) body.push(replyHint(hint.trim()));
  if (ctx.decideUrl) body.push(replyLink('Decide on this request', ctx.decideUrl, '8px 0 0'));
  if (ctx.internalNote) body.push(replyHint(`Internal: ${escapeHtml(firstNameOf(ctx.requesterName) || 'the requester')} is not on this conversation.`, ctx.decideUrl ? '8px 0 0' : '4px 0 0'));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * Approvals v3 — the decision, as the approver's message, to the other
 * approvers, the agents involved and (only when the approver asked for it)
 * the ticket requester. ctx:
 *  { categoryName, ticket:{ref,subject,appUrl|null}, approved, changedFrom, approverName, note, conditionNote,
 *    signatureHtml, recipient:{role,name}, requester:{name}, requestedByName, quoteHtml? }
 */
export function renderDecisionThreadEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const verdict = verdictWordOf(approved, ctx.conditionNote);
  const toRequester = ctx.recipient?.role === 'requester';
  const body = [];
  const what = ctx.categoryName ? escapeHtml(ctx.categoryName) : 'The request';
  const forWhom = !toRequester && ctx.requester?.name ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  const ref = refHtml(t, toRequester ? null : t.appUrl);
  const changed = ctx.changedFrom ? ` (changed from ${escapeHtml(ctx.changedFrom === 'rejected' ? 'not approved' : ctx.changedFrom)})` : '';
  const lead = toRequester
    ? `Your ${ctx.categoryName ? escapeHtml(ctx.categoryName) : ''} request${ref ? `, ${ref}` : ''}.`.replace('Your  request', 'Your request')
    : `${what}${forWhom}${ref ? `, ${ref}` : ''}.`;
  body.push(replyPara(`<b>${escapeHtml(verdict)}.</b>${changed} ${lead}`));
  body.push(conditionNoteHtml(ctx.conditionNote));
  if (ctx.note) body.push(replyText(ctx.note));
  body.push(replySignature(ctx.signatureHtml));
  let hint;
  if (toRequester) hint = 'If you have a question about this, reply to this e-mail.';
  else {
    const agent = firstNameOf(ctx.requestedByName) || 'The agent';
    hint = approved ? `${escapeHtml(agent)} can carry on with the ticket.` : 'The decision and the reason are on the ticket.';
    if (t.appUrl) hint += ` ${inlineLink('Open the ticket', t.appUrl)}`;
  }
  body.push(replyHint(hint));
  return replyDocument(body, ctx.quoteHtml);
}

/**
 * The technician (the agent who asked): the approver approves WITH
 * conditions, and nothing is approved until each one is answered. ctx:
 *  { categoryName, ticket:{ref, subject, appUrl}, approverName, technicianName, requester:{name}, items:[{text}],
 *    note, changed, signatureHtml?, quoteHtml? }
 */
export function renderConditionsEmail(ctx) {
  const t = ctx.ticket || {};
  const approver = ctx.approverName || 'The approver';
  const by = escapeHtml(approver);
  const n = (ctx.items || []).length;
  const what = ctx.categoryName ? `the ${escapeHtml(ctx.categoryName)} request` : 'the request';
  const forWhom = ctx.requester?.name ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  const ref = refHtml(t);
  const on = ref ? ` on ${ref}` : '';
  const body = [];
  if (firstNameOf(ctx.technicianName)) body.push(replyPara(`Hi ${escapeHtml(firstNameOf(ctx.technicianName))},`));
  const head = ctx.changed
    ? `${by} changed the conditions on ${what}${forWhom}${on}.`
    : `${by} will approve ${what}${forWhom}${on} on ${n === 1 ? 'one condition' : `${n} conditions`}.`;
  body.push(replyPara(`${head} It is not approved yet: answer ${n === 1 ? 'it' : 'each one'} and your answers go straight back to ${escapeHtml(firstNameOf(approver) || approver)}.`));
  body.push(conditionsList(ctx.items, { answers: false }));
  if (ctx.note) body.push(replyText(ctx.note));
  body.push(replySignature(ctx.signatureHtml));
  body.push(replyLink('Answer on the ticket', t.appUrl));
  body.push(replyHint('For each one, say whether it can be met and how, or why it can&rsquo;t. If only the requester knows, ask them from the ticket first; their answer lands on the request.', '4px 0 0'));
  return replyDocument(body, ctx.quoteHtml);
}

export default {
  renderConditionsEmail,
  renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail, renderRequesterHandoffEmail,
  renderApprovalMessageEmail, renderDecisionThreadEmail, descriptionHtmlForEmail,
  normalizeNoteHtmlForEmail, dropEmptyTableColumns, textExcerpt, escapeHtml, initialsOf, emailShell,
  replyPara, replyHint, replyLink, decisionIntentUrl,
};
