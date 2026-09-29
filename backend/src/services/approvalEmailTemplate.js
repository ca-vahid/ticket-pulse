/**
 * Approval e-mails (MEGA-0901 AP-2). Table-based, inline-styled HTML that
 * survives Outlook desktop / OWA / Gmail / Apple Mail: a 640px white card on a
 * slate ground, Arial stack, no REMOTE images (Outlook blocks data URIs and
 * remote pictures by default). People photos and the brand pictograms ride
 * along as inline (cid:) attachments (emailBrandAssets); initials circles
 * (plain table cells) are the fallback for people.
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

// ---------------------------------------------------------------- building blocks
//
// People photos travel as inline cid: attachments; initials circles are the
// fallback. emailShell (the 17 Sep 2026 pictogram shell) is kept for the
// requester-reply copy; approval e-mails use apDocument below.

function photoCircle(cid, name, size) {
  // Inline attachment referenced by cid: — the picture is INSIDE the message (no remote fetch, works
  // with images-off policies). Outlook desktop ignores border-radius; the square photo is still right.
  return `<img src="cid:${escapeHtml(cid)}" width="${size}" height="${size}" alt="${escapeHtml(initialsOf(name))}" style="display:block;width:${size}px;height:${size}px;border-radius:${size / 2}px;border:0;">`;
}

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

// ------------------------------------------------ the approver request e-mail
//
// 29 Sep 2026 redesign (mockups C1 + D3). Title = the approval category, the
// ticket number links to the ticket, and the decision sits at the END as one
// full-width row: Approve takes half, Decline and Ask a quarter each. Every
// button opens the approval page with that choice picked (?intent=) — nothing
// is decided by a GET, so link scanners can't approve anything.
//
// Dark mode, learned on Outlook for Android: it honours prefers-color-scheme
// AND then lightens any dark background it finds (a #161d28 card came out
// slate). So surfaces are never painted — no page or card fill, the mail
// app's own canvas shows through — and dark mode only swaps text, hairlines
// and the tinted buttons (which turn into outlines).

const AP = {
  ink: '#0b1324', ink2: '#1f2937', muted: '#475569', line: '#e3e8ef', link: '#1d4ed8',
  go: '#0f7a4f', goTint: '#e8f5ee', goLine: '#bfe3cf',
  no: '#b42318', noTint: '#fdf1f0', noLine: '#f1c4bf',
  ask: '#1d4ed8', askTint: '#eef3fe', askLine: '#c6d5f7',
};
const AP_DARK = {
  ink: '#eef2f6', ink2: '#d3dae3', muted: '#a3aebb', line: '#3a4350', link: '#9cc0ff',
  go: '#6ee7b7', goLine: '#2f6b52', no: '#ff9b93', noLine: '#6b3632', ask: '#9cc0ff', askLine: '#34496e',
};
const AP_FONT = "'Segoe UI',-apple-system,BlinkMacSystemFont,Roboto,Helvetica,Arial,sans-serif";

function approverCss() {
  const d = AP_DARK;
  return `<style>
:root{color-scheme:light dark;supported-color-schemes:light dark}
body{margin:0;padding:0} a{text-decoration:none}
.ap-rich > :first-child{margin-top:0!important} .ap-rich > :last-child{margin-bottom:0!important}
@media screen and (max-width:620px){
  .ap-wrap{padding:0!important} .ap-card{border-left:0!important;border-right:0!important;border-radius:0!important}
  .ap-pad{padding-left:18px!important;padding-right:18px!important}
  .ap-stack{display:block!important;width:100%!important;border-left:0!important;padding-left:0!important}
  .ap-h1{font-size:18px!important;line-height:24px!important}
  .ap-btn{font-size:13px!important}
}
@media (prefers-color-scheme:dark){
  .ap-ink{color:${d.ink}!important} .ap-ink2{color:${d.ink2}!important} .ap-muted{color:${d.muted}!important}
  .ap-line{border-color:${d.line}!important} .ap-link{color:${d.link}!important}
  .ap-go{background:transparent!important;border-color:${d.goLine}!important} .ap-go a{color:${d.go}!important}
  .ap-no{background:transparent!important;border-color:${d.noLine}!important} .ap-no a{color:${d.no}!important}
  .ap-ask{background:transparent!important;border-color:${d.askLine}!important} .ap-ask a{color:${d.ask}!important}
  .ap-s-go{color:#6ee7b7!important} .ap-s-no{color:#ff9b93!important} .ap-s-amber{color:#fbbf24!important} .ap-s-violet{color:#c4b5fd!important} .ap-s-blue{color:#9cc0ff!important}
  .ap-rich,.ap-rich *{color:${d.ink2}!important;background:transparent!important;border-color:${d.line}!important}
  .ap-rich a{color:${d.link}!important}
}
[data-ogsc] .ap-ink{color:${d.ink}!important} [data-ogsc] .ap-ink2{color:${d.ink2}!important} [data-ogsc] .ap-muted{color:${d.muted}!important}
</style>`;
}

const apText = (cls, style, html) => `<div class="${cls}" style="font-family:${AP_FONT};${style}">${html}</div>`;
const apLabel = (text) => apText('ap-muted', `font-size:12px;line-height:16px;color:${AP.muted};`, escapeHtml(text));

function apAvatar(name, photoCid, tint) {
  if (photoCid) return photoCircle(photoCid, name, 38);
  const [bg, fg] = tint === 'amber' ? ['#fdf0d5', '#8a4b08'] : ['#e0e9ff', '#1d4ed8'];
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="38" height="38" align="center" valign="middle" bgcolor="${bg}" style="width:38px;height:38px;border-radius:19px;background:${bg};color:${fg};font-family:${AP_FONT};font-size:14px;font-weight:bold;line-height:38px;">${escapeHtml(initialsOf(name))}</td></tr></table>`;
}

function apPerson({ label, name, sub, photoCid, tint }) {
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
    + `<td valign="middle" style="padding-right:10px;">${apAvatar(name, photoCid, tint)}</td>`
    + `<td valign="middle">${apLabel(label)}${apText('ap-ink', `font-size:14.5px;line-height:20px;font-weight:bold;color:${AP.ink};`, escapeHtml(name))}${sub ? apText('ap-muted', `font-size:12.5px;line-height:18px;color:${AP.muted};`, escapeHtml(sub)) : ''}</td>`
    + '</tr></table>';
}

/** A quiet block marked by a rule on its left — no fill, so dark mode has nothing to repaint. */
function apRuled(labelText, bodyHtml, { rich = false } = {}) {
  return '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
    + `<td class="ap-line" style="border-left:3px solid ${AP.line};padding:2px 0 2px 14px;">`
    + `${labelText ? apLabel(labelText) : ''}<div class="ap-ink${rich ? ' ap-rich' : ''}" style="font-family:${AP_FONT};font-size:14px;line-height:21px;color:${AP.ink};${labelText ? 'margin-top:4px;' : ''}">${bodyHtml}</div>`
    + '</td></tr></table>';
}

function apFact(label, valueHtml) {
  return `<td width="50%" valign="top" style="padding:10px 8px 0 0;">${apLabel(label)}${apText('ap-ink', `font-size:14px;line-height:20px;font-weight:600;color:${AP.ink};`, valueHtml || '—')}</td>`;
}

/** Full-cell button: fills its column, ~36 px tall. Plain <a> in a filled cell — Outlook desktop gets a square button. */
function apButton(kind, label, href) {
  const c = { go: [AP.goTint, AP.go, AP.goLine], no: [AP.noTint, AP.no, AP.noLine], ask: [AP.askTint, AP.ask, AP.askLine] }[kind];
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td align="center" bgcolor="${c[0]}" class="ap-${kind}" style="border-radius:7px;background:${c[0]};border:1px solid ${c[2]};">`
    + `<a href="${escapeHtml(href)}" target="_blank" class="ap-btn" style="display:block;padding:9px 6px;font-family:${AP_FONT};font-size:13.5px;line-height:18px;font-weight:bold;color:${c[1]};text-align:center;white-space:nowrap;border-radius:7px;text-decoration:none;">${escapeHtml(label)}</a>`
    + '</td></tr></table>';
}

/** Adds ?intent= to the decision link (keeps any query string the link already has). */
export function decisionIntentUrl(url, intent) {
  if (!url) return url;
  return `${url}${url.includes('?') ? '&' : '?'}intent=${encodeURIComponent(intent)}`;
}

/**
 * Approver: "your decision is needed". ctx:
 *  { workspaceName, categoryName, ticket:{ref, subject, createdAt, dueBy, priorityLabel, typeLabel, categoryPath, statusLabel, description, appUrl},
 *    requester:{name,title,department,location,photoCid?}, requestedByName, requestedByPhotoCid?, approverName,
 *    noteHtml (already sanitized + placeholders substituted), clarification:{question,answer}|null,
 *    otherApprovers:[{name,status}], decisionUrl, expiresAt, reRequest:boolean, amountLabel?, tierLabel?, handoff?, laptop? }
 */
export function renderApproverRequestEmail(ctx) {
  const t = ctx.ticket || {};
  const requester = ctx.requester || {};
  const agentName = ctx.requestedByName || 'the agent';
  const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || null;
  const rows = [];
  const pad = (html, padding = '0 28px') => `<tr><td class="ap-pad" style="padding:${padding};">${html}</td></tr>`;

  const kind = ['Approval', ctx.tierLabel].filter(Boolean).join(' · ');

  // Title: the category (what is being approved); ticket number (linked) + subject underneath.
  const ticketHref = t.appUrl || ctx.decisionUrl;
  const refLink = t.ref ? `<a href="${escapeHtml(ticketHref)}" target="_blank" class="ap-link" style="color:${AP.link};font-weight:600;text-decoration:none;">${escapeHtml(t.ref)}&nbsp;&#8599;</a>&nbsp; ` : '';
  const title = ctx.categoryName || t.subject || 'Approval request';
  const sub = ctx.categoryName ? escapeHtml(t.subject || '') : '';
  rows.push(pad(
    (ctx.reRequest ? apText('ap-muted', `font-size:12.5px;line-height:18px;color:${AP.muted};margin-bottom:3px;`, 'Re-requested with the answer you asked for') : '')
    + apText('ap-h1 ap-ink', `font-size:19px;line-height:25px;font-weight:bold;color:${AP.ink};`, escapeHtml(title))
    + ((refLink || sub) ? apText('ap-muted', `font-size:14px;line-height:21px;color:${AP.muted};margin-top:4px;`, `${refLink}${sub}`) : ''),
    '22px 28px 0'));

  // The answer the approver asked for comes first on a re-request.
  if (ctx.clarification?.answer) {
    const q = ctx.clarification.question ? `<div style="margin:0 0 6px;"><b>You asked:</b> ${escapeHtml(ctx.clarification.question)}</div>` : '';
    rows.push(pad(apRuled(null, `${q}<div><b>${escapeHtml(agentName)} replied:</b> ${escapeHtml(ctx.clarification.answer)}</div>`), '20px 28px 0'));
  }

  // Hand-off (Approvals v2): why this landed with THIS approver.
  const h = ctx.handoff;
  if (h && h.kind) {
    const by = escapeHtml(h.byName || 'The previous approver');
    let lead;
    if (h.kind === 'forwarded') lead = `<b>${by}</b> forwarded this request to you as the <b>final approver</b>.`;
    else if (h.kind === 'auto_start') lead = `This request comes to you at <b>${escapeHtml(h.toTierName || 'this tier')}</b> directly: ${escapeHtml(h.note || `${h.byName || 'the requester'} is an approver on the earlier tier and cannot approve their own request`)}.`;
    else if (h.kind === 'auto') lead = `<b>${by}</b> approved this at ${escapeHtml(h.fromTierName || 'the previous tier')}, but the amount is over that tier's limit${h.limitLabel ? ` (${escapeHtml(h.limitLabel)})` : ''}, so <b>your approval is needed</b> at ${escapeHtml(h.toTierName || 'this tier')}.`;
    else lead = `<b>${by}</b> escalated this request from ${escapeHtml(h.fromTierName || 'the previous tier')} to you (${escapeHtml(h.toTierName || 'next tier')}).`;
    const noteHtml = h.note && h.kind !== 'auto_start' ? `<div style="margin-top:6px;"><b>Their note:</b> ${escapeHtml(h.note)}</div>` : '';
    rows.push(pad(apRuled(null, `${lead}${noteHtml}`), '20px 28px 0'));
  }

  // Why the agent is asking — their note, formatted as written.
  if (ctx.noteHtml) rows.push(pad(apRuled(`Why ${firstName(ctx.requestedByName) || 'the agent'} is asking`, ctx.noteHtml, { rich: true }), '20px 28px 0'));

  // People — side by side, stacked on a phone. A department that repeats the location is dropped.
  const place = [requester.location && !(requester.title || '').toLowerCase().includes(String(requester.location).toLowerCase()) ? requester.location : null,
    requester.department && requester.department !== requester.location ? requester.department : null].filter(Boolean).join(' · ');
  const forSub = [requester.title, place].filter(Boolean).join(' · ');
  rows.push(pad('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
    + `<td class="ap-stack" width="55%" valign="top" style="padding:0 12px 12px 0;">${apPerson({ label: 'Requested for', name: requester.name || 'Unknown requester', sub: forSub, photoCid: requester.photoCid || null, tint: 'amber' })}</td>`
    + `<td class="ap-stack" width="45%" valign="top" style="padding:0 0 12px 0;">${apPerson({ label: 'Asked by', name: ctx.requestedByName || 'Agent', sub: 'Service desk agent', photoCid: ctx.requestedByPhotoCid || null, tint: 'blue' })}</td>`
    + '</tr></table>', '20px 28px 0'));

  // Facts: amount first when there is one, then the ticket's own.
  const facts = [];
  if (ctx.amountLabel) facts.push(['Amount', escapeHtml(ctx.amountLabel)]);
  // Assetron devices held by this request (up to 5 since 29 Sep 2026).
  const held = (Array.isArray(ctx.laptops) ? ctx.laptops : (ctx.laptop ? [ctx.laptop] : [])).filter((h) => h && h.asset);
  held.forEach((h, i) => {
    const a = h.asset;
    const id = a.assetTag || (a.serialNumber ? `S/N ${a.serialNumber}` : '');
    const spec = [a.cpu, a.ram, a.storage, a.screenSize].filter(Boolean).join(' · ');
    const label = held.length > 1 ? `Device ${i + 1} (held in Assetron)` : 'Device (held in Assetron)';
    facts.push([label, `${escapeHtml([a.make, a.model].filter(Boolean).join(' ') || 'Device')}${id ? ` <span class="ap-muted" style="font-weight:normal;color:${AP.muted};">· ${escapeHtml(id)}</span>` : ''}${spec ? `<div class="ap-muted" style="font-size:12.5px;line-height:18px;font-weight:normal;color:${AP.muted};">${escapeHtml(spec)}</div>` : ''}`]);
    facts.push(['Assigned to on approval', escapeHtml(h.recipient?.name || h.recipient?.email || '—')]);
  });
  facts.push(['Priority', escapeHtml(t.priorityLabel || '—')]);
  facts.push(['Due', escapeHtml(t.dueBy ? fmtDay(t.dueBy) : '—')]);
  facts.push(['Type', escapeHtml(t.typeLabel || '—')]);
  facts.push(['Category', escapeHtml(t.categoryPath || '—')]);
  let factRows = '';
  for (let i = 0; i < facts.length; i += 2) factRows += `<tr>${apFact(...facts[i])}${facts[i + 1] ? apFact(...facts[i + 1]) : '<td width="50%"></td>'}</tr>`;
  rows.push(pad(`<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td colspan="2" class="ap-line" style="border-top:1px solid ${AP.line};font-size:0;line-height:0;">&nbsp;</td></tr>${factRows}</table>`, '0 28px'));

  // What the requester wrote — formatted like the ticket; long ones point at the page.
  const desc = descriptionHtmlForEmail(t.description);
  const tail = [];
  if (desc.html) {
    tail.push(apLabel(`What ${firstName(requester.name) || 'the requester'} wrote`));
    tail.push(`<div class="ap-ink2 ap-rich" style="font-family:${AP_FONT};font-size:14px;line-height:21px;color:${AP.ink2};margin-top:4px;">${desc.html}</div>`);
    if (desc.truncated) tail.push(apText('ap-muted', `font-size:12px;line-height:18px;color:${AP.muted};margin-top:6px;`, '… the full description is on the approval page.'));
  }
  const others = (ctx.otherApprovers || []).filter((a) => a && a.name);
  if (others.length > 0) {
    const list = others.map((a) => `${escapeHtml(a.name)}${a.status && a.status !== 'pending' ? ` (${escapeHtml(a.status)})` : ''}`).join(', ');
    tail.push(apText('ap-muted', `font-size:12.5px;line-height:18px;color:${AP.muted};margin-top:${desc.html ? 12 : 0}px;`, `Also asked to approve: ${list}. The first decision closes the request for everyone.`));
  }
  if (tail.length) rows.push(pad(tail.join(''), '16px 28px 0'));

  // The decision — at the end, filling the row: Approve half, Decline and Ask a quarter each.
  rows.push(apActions([
    { kind: 'go', label: 'Approve', href: decisionIntentUrl(ctx.decisionUrl, 'approve'), width: '50%' },
    { kind: 'no', label: 'Decline', href: decisionIntentUrl(ctx.decisionUrl, 'reject'), width: '25%' },
    { kind: 'ask', label: 'Ask', href: decisionIntentUrl(ctx.decisionUrl, 'ask'), width: '25%' },
  ], 'Each button opens the approval page with that choice picked. Add a note if you like, then confirm.'));

  const expires = fmtDayLong(ctx.expiresAt);
  return apDocument({
    headerRight: kind,
    rows,
    footerHtml: `This link is personal to you. Please don't forward it.${expires ? ` It expires on ${escapeHtml(expires)}.` : ''}<br>`
      + `Sent by Ticket Pulse on behalf of ${escapeHtml(ctx.requestedByName || 'the service desk')}${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}.`,
    preheader: `${ctx.requestedByName || 'An agent'} needs your approval${requester.name ? ` for ${requester.name}` : ''}: ${ctx.categoryName || t.subject || ''}`,
  });
}

// ------------------------------------------ the rest of the approval family
//
// 29 Sep 2026: every approval e-mail follows the request e-mail's layout —
// status word with a dot, the category as the title, the ticket ref (linked
// when the reader can open the ticket) and subject under it, ruled blocks for
// notes, and the action as a full-width row at the end. Same dark-mode rule:
// no painted surfaces.

const AP_STATUS = {
  go: { color: '#0f7a4f', dark: '#6ee7b7' },
  no: { color: '#b42318', dark: '#ff9b93' },
  amber: { color: '#b45309', dark: '#fbbf24' },
  violet: { color: '#6d28d9', dark: '#c4b5fd' },
  blue: { color: '#1d4ed8', dark: '#9cc0ff' },
};

/** "● Approved" — the state as a coloured word with a dot, never a pill or band. */
function apStatus(word, tone) {
  const c = AP_STATUS[tone] || AP_STATUS.blue;
  return apText(`ap-s-${tone}`, `font-size:13px;line-height:18px;font-weight:bold;color:${c.color};margin-bottom:4px;`, `&#9679;&nbsp; ${escapeHtml(word)}`);
}

/** Title block shared by every approval e-mail: optional status, title, linked ref + subject. */
function apHero({ status = null, statusTone = 'blue', categoryName = null, ticket = {}, href = null }) {
  const title = categoryName || ticket.subject || 'Approval';
  const sub = categoryName ? escapeHtml(ticket.subject || '') : '';
  const ref = ticket.ref
    ? (href
      ? `<a href="${escapeHtml(href)}" target="_blank" class="ap-link" style="color:${AP.link};font-weight:600;text-decoration:none;">${escapeHtml(ticket.ref)}&nbsp;&#8599;</a>&nbsp; `
      : `<span class="ap-ink2" style="color:${AP.ink2};font-weight:600;">${escapeHtml(ticket.ref)}</span>&nbsp; `)
    : '';
  return `<tr><td class="ap-pad" style="padding:22px 28px 0;">${status ? apStatus(status, statusTone) : ''}`
    + apText('ap-h1 ap-ink', `font-size:19px;line-height:25px;font-weight:bold;color:${AP.ink};`, escapeHtml(title))
    + ((ref || sub) ? apText('ap-muted', `font-size:14px;line-height:21px;color:${AP.muted};margin-top:4px;`, `${ref}${sub}`) : '')
    + '</td></tr>';
}

/** A body row with the standard side padding. */
const apRow = (html, top = 18) => `<tr><td class="ap-pad" style="padding:${top}px 28px 0;">${html}</td></tr>`;
const apSentence = (html) => apText('ap-ink2', `font-size:15px;line-height:22px;color:${AP.ink2};`, html);

/**
 * The action row at the end, above the footer: a hairline, then buttons that
 * fill the row. `buttons` = [{ kind:'go'|'no'|'ask', label, href, width }].
 */
function apActions(buttons, helpHtml = null) {
  const list = buttons.filter((b) => b && b.href);
  if (!list.length && !helpHtml) return '';
  const cells = list.map((b, i) => `<td width="${b.width || `${Math.floor(100 / list.length)}%`}" valign="top" style="padding:0 ${i === list.length - 1 ? 0 : 4}px 0 ${i === 0 ? 0 : 4}px;">${apButton(b.kind || 'ask', b.label, b.href)}</td>`).join('');
  return `<tr><td class="ap-pad" style="padding:22px 28px 0;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td class="ap-line" style="border-top:1px solid ${AP.line};padding-top:18px;">`
    + (cells ? `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>${cells}</tr></table>` : '')
    + (helpHtml ? apText('ap-muted', `font-size:12px;line-height:17px;color:${AP.muted};margin-top:${cells ? 10 : 0}px;text-align:center;`, helpHtml) : '')
    + '</td></tr></table></td></tr>';
}

/** Quoted history entries (conversation / decision thread), each on a left rule. */
function apHistoryItem(headHtml, bodyHtml) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;margin:0 0 10px;"><tr><td class="ap-line" style="border-left:3px solid ${AP.line};padding:0 0 0 12px;">`
    + apText('ap-muted', `font-size:12.5px;line-height:18px;color:${AP.muted};`, headHtml)
    + `<div class="ap-ink2 ap-rich" style="font-family:${AP_FONT};font-size:13.5px;line-height:19px;color:${AP.ink2};margin-top:2px;">${bodyHtml}</div>`
    + '</td></tr></table>';
}

/** The whole document: header, rows, footer — shared by every approval e-mail. */
function apDocument({ headerRight = 'Approval', rows, footerHtml, preheader = '' }) {
  const head = `<tr><td class="ap-pad ap-line" style="padding:14px 28px;border-bottom:1px solid ${AP.line};"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>`
    + `<td class="ap-ink" style="font-family:${AP_FONT};font-size:13.5px;font-weight:bold;color:${AP.ink};">Ticket Pulse</td>`
    + `<td align="right" class="ap-muted" style="font-family:${AP_FONT};font-size:12px;color:${AP.muted};">${escapeHtml(headerRight)}</td>`
    + '</tr></table></td></tr>';
  const foot = '<tr><td style="height:22px;line-height:22px;font-size:1px;">&nbsp;</td></tr>'
    + `<tr><td class="ap-pad ap-muted ap-line" style="padding:16px 28px 22px;border-top:1px solid ${AP.line};font-family:${AP_FONT};font-size:12px;line-height:18px;color:${AP.muted};">${footerHtml}</td></tr>`;
  return [
    '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting">',
    '<meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><title></title>',
    approverCss(),
    '</head><body style="margin:0;padding:0;-webkit-text-size-adjust:100%;">',
    preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;opacity:0;">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>` : '',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr><td align="center" class="ap-wrap" style="padding:20px 12px;">',
    '<!--[if mso]><table role="presentation" width="600" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" class="ap-card ap-line" style="max-width:600px;border:1px solid ${AP.line};border-radius:12px;border-collapse:separate;">`,
    head, rows.join(''), foot,
    '</table>',
    '<!--[if mso]></td></tr></table><![endif]-->',
    '</td></tr></table></body></html>',
  ].join('');
}

const verdictWordOf = (approved, conditionNote) => (!approved ? 'Not approved' : conditionNote ? 'Approved with condition' : 'Approved');
const apWord = (text, tone) => `<span class="ap-s-${tone}" style="color:${AP_STATUS[tone].color};font-weight:bold;">${escapeHtml(text)}</span>`;
const workspaceFooter = (ctx, tail = '') => `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}.${tail}`;

/**
 * Requester (the agent): the verdict. ctx:
 *  { workspaceName, categoryName, ticket:{ref, subject, appUrl}, approved:boolean, approverName, isSelf, changedFrom, note, conditionNote, signatureHtml, requester:{name,title,location,photoCid} }
 */
export function renderRequesterDecisionEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const verdict = verdictWordOf(approved, ctx.conditionNote);
  const tone = approved ? 'go' : 'no';
  const who = ctx.isSelf ? 'You' : (ctx.approverName || 'The approver');
  const forWhom = ctx.requester?.name ? ` for <b>${escapeHtml(ctx.requester.name)}</b>` : '';
  const verdictWord = apWord(verdict.toLowerCase(), tone);
  // Sentence shapes are load-bearing (inbox filters + tests): "<actor> decided your approval request",
  // "changed the decision on your approval request", "You approved your own approval request".
  const sentence = ctx.isSelf
    ? (ctx.changedFrom
      ? `You changed the decision on your own approval request${forWhom}: ${verdictWord}`
      : `You ${approved ? 'approved' : 'did not approve'} your own approval request${forWhom}.`)
    : (ctx.changedFrom
      ? `${escapeHtml(who)} changed the decision on your approval request${forWhom}: ${verdictWord}`
      : `${escapeHtml(who)} decided your approval request${forWhom}: ${verdictWord}`);
  const verb = ctx.changedFrom ? `changed the decision to ${verdict.toLowerCase()} on` : (approved ? 'approved' : 'did not approve');
  const rows = [];
  rows.push(apHero({ status: `${verdict}${ctx.changedFrom ? ' (changed)' : ''}`, statusTone: tone, categoryName: ctx.categoryName, ticket: t, href: t.appUrl || null }));
  rows.push(apRow(apSentence(sentence)));
  if (ctx.requester?.name) {
    rows.push(apRow(apPerson({ label: 'Requested for', name: ctx.requester.name, sub: [ctx.requester.title, ctx.requester.location].filter(Boolean).join(' · '), photoCid: ctx.requester.photoCid || null, tint: 'amber' })));
  }
  if (ctx.conditionNote) rows.push(apRow(apRuled('Condition', escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>'))));
  if (ctx.note) rows.push(apRow(apRuled(ctx.isSelf ? 'Your note' : `Note from ${ctx.approverName || 'the approver'}`, escapeHtml(ctx.note).replace(/\r?\n/g, '<br>'))));
  if (ctx.signatureHtml) rows.push(apRow(`<div class="ap-ink2 ap-rich" style="font-family:${AP_FONT};font-size:13px;line-height:18px;color:${AP.ink2};">${ctx.signatureHtml}</div>`, 14));
  rows.push(apActions(
    [t.appUrl ? { kind: approved ? 'go' : 'ask', label: 'Open the ticket', href: t.appUrl, width: '100%' } : null],
    approved ? 'The approval is recorded on the ticket — you can proceed.' : 'The rejection and the reason are recorded on the ticket.',
  ));
  return apDocument({
    rows,
    footerHtml: workspaceFooter(ctx, ' The full approval trail is on the ticket.'),
    preheader: `${who} ${verb} your approval request on ${t.ref || 'the ticket'}`,
  });
}

/**
 * Requester (the agent): the request moved to another approver (Approvals v2).
 * ctx: { workspaceName, categoryName, ticket:{ref, subject, appUrl}, kind:'escalated'|'forwarded'|'auto',
 *        byName, toNames:[…], toTierName, fromTierName, requester:{name} }
 * No note on purpose — the approver's reasoning stays between approvers.
 */
export function renderRequesterHandoffEmail(ctx) {
  const t = ctx.ticket || {};
  const names = (ctx.toNames || []).filter(Boolean);
  const who = names.length ? names.join(', ') : (ctx.toTierName || 'the next approver');
  const forWhom = ctx.requester?.name ? ` for <b>${escapeHtml(ctx.requester.name)}</b>` : '';
  const by = escapeHtml(ctx.byName || 'The approver');
  const forwarded = ctx.kind === 'forwarded';
  let sentence;
  if (forwarded) sentence = `<b>${by}</b> forwarded your approval request${forWhom} to <b>${escapeHtml(who)}</b>, who will make the final decision.`;
  else if (ctx.kind === 'auto') sentence = `<b>${by}</b> approved your request${forWhom} at ${escapeHtml(ctx.fromTierName || 'Tier 1')}. The amount is above that tier's limit, so it has moved on to <b>${escapeHtml(who)}</b> (${escapeHtml(ctx.toTierName || 'next tier')}) for the final approval.`;
  else sentence = `<b>${by}</b> escalated your approval request${forWhom} to <b>${escapeHtml(who)}</b> (${escapeHtml(ctx.toTierName || 'next tier')}).`;
  const rows = [];
  rows.push(apHero({ status: forwarded ? 'Forwarded' : 'Escalated', statusTone: 'amber', categoryName: ctx.categoryName, ticket: t, href: t.appUrl || null }));
  rows.push(apRow(apSentence(sentence)));
  rows.push(apActions(
    [t.appUrl ? { kind: 'ask', label: 'Open the ticket', href: t.appUrl, width: '100%' } : null],
    'Nothing is needed from you — you will get another e-mail when the decision is made.',
  ));
  return apDocument({
    rows,
    footerHtml: workspaceFooter(ctx, ' The full approval trail is on the ticket.'),
    preheader: `${ctx.byName || 'The approver'} ${forwarded ? 'forwarded' : 'escalated'} your approval request on ${t.ref || 'the ticket'} to ${who}`,
  });
}

/**
 * Requester (the agent): the approver asked a question. ctx:
 *  { workspaceName, categoryName, ticket:{ref, subject, appUrl}, approverName, question, requester:{name} }
 */
export function renderRequesterClarificationEmail(ctx) {
  const t = ctx.ticket || {};
  const rows = [];
  rows.push(apHero({ status: 'Needs your answer', statusTone: 'violet', categoryName: ctx.categoryName, ticket: t, href: t.appUrl || null }));
  rows.push(apRow(apSentence(`<b>${escapeHtml(ctx.approverName || 'The approver')}</b> needs more information before deciding${ctx.requester?.name ? ` the request for <b>${escapeHtml(ctx.requester.name)}</b>` : ''}.`)));
  rows.push(apRow(apRuled('Their question', escapeHtml(ctx.question || '')), 14));
  rows.push(apActions(
    [t.appUrl ? { kind: 'ask', label: 'Answer on the ticket', href: t.appUrl, width: '100%' } : null],
    `Your answer goes back to ${escapeHtml(ctx.approverName || 'the approver')} by e-mail and the approval link re-opens for them.`,
  ));
  return apDocument({
    rows,
    footerHtml: workspaceFooter(ctx),
    preheader: `${ctx.approverName || 'The approver'} asked: ${ctx.question || ''}`,
  });
}

/**
 * Approvals v3 — a question / comment / answer on the conversation, to one
 * recipient. ctx: { kind, audience, authorName, authorRole, recipient:{email,name,role}, isCc,
 *   categoryName, ticket:{ref,subject}, bodyHtml|bodyText, thread:[messages], replyUrl, canReplyByEmail, internalNote }
 */
export function renderApprovalMessageEmail(ctx) {
  const t = ctx.ticket || {};
  const rows = [];
  const by = escapeHtml(ctx.authorName || 'An approver');
  const status = ctx.kind === 'answer' ? 'Answer' : ctx.kind === 'comment' ? 'Note' : 'Question';
  const tone = ctx.kind === 'answer' ? 'go' : ctx.kind === 'comment' ? 'blue' : 'violet';
  rows.push(apHero({ status: `${status} on an approval`, statusTone: tone, categoryName: ctx.categoryName, ticket: t, href: t.appUrl || null }));
  const lead = ctx.kind === 'answer'
    ? `<b>${by}</b> answered${ctx.recipient?.name ? ' your question' : ''}:`
    : ctx.kind === 'comment'
      ? `<b>${by}</b> left a note${ctx.isCc ? ' (you are copied)' : ' for you'}:`
      : `<b>${by}</b> has a question${ctx.isCc ? ' (you are copied)' : ' for you'}:`;
  rows.push(apRow(apSentence(lead)));
  const body = ctx.bodyHtml ? (normalizeNoteHtmlForEmail(ctx.bodyHtml) || ctx.bodyHtml) : escapeHtml(ctx.bodyText || '').replace(/\n/g, '<br>');
  rows.push(apRow(apRuled(null, body, { rich: true }), 10));
  if (ctx.internalNote) rows.push(apRow(apText('ap-s-amber', `font-size:12.5px;line-height:18px;color:${AP_STATUS.amber.color};`, 'Internal — the ticket requester is not on this message.'), 8));
  const thread = Array.isArray(ctx.thread) ? ctx.thread.filter((m) => m && (m.bodyText || m.bodyHtml)) : [];
  if (thread.length) {
    const items = thread.slice(-8).map((m) => {
      const who = escapeHtml(m.author?.name || m.author?.email || 'Someone');
      const when = m.createdAt ? fmtDay(m.createdAt) : '';
      const label = m.kind === 'question' ? 'asked' : m.kind === 'answer' ? 'answered' : m.kind === 'decision' ? 'decided' : m.kind === 'handoff' ? 'handed off' : 'wrote';
      const mb = m.bodyHtml ? (normalizeNoteHtmlForEmail(m.bodyHtml) || m.bodyHtml) : escapeHtml(m.bodyText || '').replace(/\n/g, '<br>');
      return apHistoryItem(`<b>${who}</b> ${label}${when ? ` · ${escapeHtml(when)}` : ''}${m.audience === 'internal' ? ' · internal' : ''}`, mb);
    }).join('');
    rows.push(apRow(`${apLabel('Earlier on this request')}<div style="margin-top:8px;">${items}</div>`, 20));
  }
  if (ctx.replyUrl || ctx.canReplyByEmail) {
    rows.push(apActions(
      [ctx.replyUrl ? { kind: ctx.kind === 'question' ? 'ask' : 'go', label: ctx.kind === 'question' ? 'Answer' : 'Reply', href: ctx.replyUrl, width: '100%' } : null],
      ctx.canReplyByEmail ? 'Or simply reply to this e-mail — your answer lands on the request and everyone on it is told.' : 'Use the button to answer — this mailbox does not read replies.',
    ));
  }
  return apDocument({
    rows,
    footerHtml: 'Sent by Ticket Pulse. This message is part of an approval on the ticket above.',
    preheader: `${ctx.authorName || 'An approver'}: ${String(ctx.bodyText || '').slice(0, 120)}`,
  });
}

/**
 * Approvals v3 — the decision, reply-style, to the requester and the chain.
 * ctx: { workspaceName, categoryName, ticket:{ref,subject,appUrl|null}, approved, changedFrom, approverName,
 *   note, conditionNote, signatureHtml, recipient:{role,name}, requester:{name}, requestNote(Html), requestedByName, thread:[…], amountLabel?, tierLabel? }
 */
export function renderDecisionThreadEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const verdict = verdictWordOf(approved, ctx.conditionNote);
  const tone = approved ? 'go' : 'no';
  const rows = [];
  rows.push(apHero({ status: verdict, statusTone: tone, categoryName: ctx.categoryName, ticket: t, href: t.appUrl || null }));
  const greet = ctx.recipient?.name ? `Hi ${escapeHtml(String(ctx.recipient.name).split(' ')[0])},` : 'Hello,';
  const forWhom = ctx.requester?.name && ctx.recipient?.role !== 'requester' ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  rows.push(apRow(apSentence(`${greet}<br><br><b>${escapeHtml(ctx.approverName || 'The approver')}</b> has ${apWord(verdict.toLowerCase(), tone)} the request${forWhom}${ctx.changedFrom ? ` (changed from ${escapeHtml(ctx.changedFrom === 'rejected' ? 'not approved' : ctx.changedFrom)})` : ''}.`)));
  if (ctx.amountLabel || ctx.tierLabel) {
    rows.push(apRow('<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
      + (ctx.amountLabel ? apFact('Amount', escapeHtml(ctx.amountLabel)) : '')
      + (ctx.tierLabel ? apFact('Approval tier', escapeHtml(ctx.tierLabel)) : '')
      + '</tr></table>', 6));
  }
  if (ctx.conditionNote) rows.push(apRow(apRuled('Condition', escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>')), 14));
  if (ctx.note) rows.push(apRow(apSentence(escapeHtml(ctx.note).replace(/\n/g, '<br>')), 14));
  if (ctx.signatureHtml) rows.push(apRow(`<div class="ap-ink2 ap-rich" style="font-family:${AP_FONT};font-size:13px;line-height:18px;color:${AP.ink2};">${ctx.signatureHtml}</div>`, 14));
  // History — quoted like a reply thread, newest first.
  const history = [];
  for (const m of (Array.isArray(ctx.thread) ? ctx.thread : []).slice().reverse()) {
    if (!m || !(m.bodyText || m.bodyHtml)) continue;
    const who = escapeHtml(m.author?.name || m.author?.email || 'Someone');
    const label = m.kind === 'question' ? 'asked' : m.kind === 'answer' ? 'answered' : m.kind === 'handoff' ? 'handed off' : 'wrote';
    const mb = m.bodyHtml ? (normalizeNoteHtmlForEmail(m.bodyHtml) || m.bodyHtml) : escapeHtml(m.bodyText || '').replace(/\n/g, '<br>');
    history.push(apHistoryItem(`On ${escapeHtml(m.createdAt ? fmtDayLong(m.createdAt) : '')}, <b>${who}</b> ${label}${m.audience === 'internal' ? ' (internal)' : ''}:`, mb));
  }
  if (ctx.requestNoteHtml || ctx.requestNote) {
    const rb = ctx.requestNoteHtml ? (normalizeNoteHtmlForEmail(ctx.requestNoteHtml) || ctx.requestNoteHtml) : escapeHtml(ctx.requestNote || '').replace(/\n/g, '<br>');
    history.push(apHistoryItem(`<b>${escapeHtml(ctx.requestedByName || 'The agent')}</b> asked for approval:`, rb));
  }
  if (history.length) rows.push(apRow(`${apLabel('History')}<div style="margin-top:8px;">${history.join('')}</div>`, 20));
  rows.push(apActions([t.appUrl ? { kind: approved ? 'go' : 'ask', label: 'Open the ticket', href: t.appUrl, width: '100%' } : null]));
  return apDocument({
    rows,
    footerHtml: workspaceFooter(ctx, ctx.recipient?.role === 'requester' ? '' : ' The full approval trail is on the ticket.'),
    preheader: `${ctx.approverName || 'The approver'} ${verdict.toLowerCase()} — ${t.subject || t.ref || ''}`,
  });
}

export default {
  renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail, renderRequesterHandoffEmail,
  renderApprovalMessageEmail, renderDecisionThreadEmail, descriptionHtmlForEmail,
  normalizeNoteHtmlForEmail, dropEmptyTableColumns, textExcerpt, escapeHtml, initialsOf, emailShell,
};
