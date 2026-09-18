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
import { brandImg, categoryArt } from './emailBrandAssets.js';

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
// Redesign 17 Sep 2026 (Vahid): pictograms instead of the "TP" box and the
// status pill; the approval category gets its own tinted card; requested-for
// and asked-by sit side by side at the same avatar size, the recipient in the
// bigger card. Every picture is an inline cid: attachment (emailBrandAssets).

const SOFT = '#f8fafc';

function spacer(h = 16) {
  return `<tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</td></tr>`;
}

const TONES = {
  amber: { bg: '#fef3c7', color: '#92400e', line: '#fcd34d' },
  blue: { bg: '#dbeafe', color: '#1e40af', line: '#93c5fd' },
  green: { bg: '#d1fae5', color: '#065f46', line: '#6ee7b7' },
  red: { bg: '#fee2e2', color: '#991b1b', line: '#fca5a5' },
  violet: { bg: '#ede9fe', color: '#5b21b6', line: '#c4b5fd' },
  slate: { bg: '#e2e8f0', color: '#334155', line: '#cbd5e1' },
};

function initialsCircle(name, size = 56) {
  const font = size >= 56 ? 19 : size >= 40 ? 14 : 12;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="${size}" height="${size}" align="center" valign="middle" bgcolor="#dbeafe" style="width:${size}px;height:${size}px;border-radius:${size / 2}px;background:#dbeafe;color:#1d4ed8;font-family:${FONT};font-size:${font}px;font-weight:bold;line-height:${size}px;">${escapeHtml(initialsOf(name))}</td></tr></table>`;
}

function photoCircle(cid, name, size) {
  // Inline attachment referenced by cid: — the picture is INSIDE the message (no remote fetch, works
  // with images-off policies). Outlook desktop ignores border-radius; the square photo is still right.
  return `<img src="cid:${escapeHtml(cid)}" width="${size}" height="${size}" alt="${escapeHtml(initialsOf(name))}" style="display:block;width:${size}px;height:${size}px;border-radius:${size / 2}px;border:0;">`;
}

function avatar(name, size, photoCid) {
  return photoCid ? photoCircle(photoCid, name, size) : initialsCircle(name, size);
}

/**
 * One person as a panel cell (no border of its own — peopleRow draws the frame):
 * avatar left, eyebrow / name / detail lines right. Both people share the same
 * avatar size; `emphasis` only colours the eyebrow and enlarges the name.
 */
function personCard({ label, name, lines = [], size = 48, photoCid = null, emphasis = false }) {
  const detail = lines.filter(Boolean).map((l) => `<div style="font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(l)}</div>`).join('');
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>',
    `<td width="${size + 12}" valign="top" style="padding:0 12px 0 0;">${avatar(name, size, photoCid)}</td>`,
    `<td valign="top" style="font-family:${FONT};">`,
    `<div style="font-size:10.5px;line-height:14px;letter-spacing:0.8px;text-transform:uppercase;color:${emphasis ? '#1d4ed8' : MUTED};font-weight:bold;">${escapeHtml(label)}</div>`,
    `<div style="font-size:${emphasis ? 16 : 15}px;line-height:${emphasis ? 22 : 20}px;font-weight:bold;color:${INK};margin-top:2px;">${escapeHtml(name || 'Unknown')}</div>`,
    detail,
    '</td></tr></table>',
  ].join('');
}

/**
 * The people panel: one hairline frame, no fill, the two cells side by side and
 * divided by a single rule — equal height by construction. `right` optional.
 */
function peopleRow(left, right = null) {
  const cells = right
    ? `<td width="55%" valign="top" style="padding:14px 16px 14px 16px;">${left}</td>`
      + `<td width="45%" valign="top" style="padding:14px 16px 14px 16px;border-left:1px solid ${LINE};">${right}</td>`
    : `<td valign="top" style="padding:14px 16px;">${left}</td>`;
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;border:1px solid ${LINE};border-radius:12px;"><tr>${cells}</tr></table>`;
}

function factCell(label, valueHtml) {
  return `<td width="50%" valign="top" style="padding:10px 8px 10px 0;border-top:1px solid ${LINE};font-family:${FONT};"><div style="font-size:10.5px;line-height:14px;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};font-weight:bold;">${escapeHtml(label)}</div><div style="font-size:14px;line-height:20px;color:${INK};font-weight:bold;margin-top:2px;">${valueHtml || '—'}</div></td>`;
}

const PRIORITY_DOT = { Urgent: '#dc2626', High: '#f97316', Medium: '#10b981', Low: '#64748b' };
function priorityHtml(label) {
  if (!label) return '—';
  const color = PRIORITY_DOT[label] || '#94a3b8';
  return `<span style="display:inline-block;width:9px;height:9px;border-radius:5px;background:${color};margin:0 6px 1px 0;"></span>${escapeHtml(label)}`;
}

function button(label, url, { bg = BLUE } = {}) {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>',
    `<td align="center" bgcolor="${bg}" style="border-radius:10px;background:${bg};">`,
    `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:13px 28px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:10px;">${escapeHtml(label)} &rarr;</a>`,
    '</td></tr></table>',
  ].join('');
}

function card(innerHtml, { bg = SOFT, border = LINE, accent = null } = {}) {
  const accentTd = accent ? `<td width="4" bgcolor="${accent}" style="width:4px;background:${accent};border-radius:10px 0 0 10px;">&nbsp;</td>` : '';
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${bg}" style="border-collapse:separate;background:${bg};border:1px solid ${border};border-radius:10px;"><tr>${accentTd}<td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">${innerHtml}</td></tr></table>`;
}

function sectionLabel(text) {
  return `<div style="font-family:${FONT};font-size:10.5px;line-height:14px;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};font-weight:bold;margin:0 0 6px;">${escapeHtml(text)}</div>`;
}

/**
 * The opening block of every approval e-mail: pictogram on the left, then an
 * optional tone-coloured eyebrow (the verdict), the kicker, the ticket subject
 * and a monospace meta line. The pictogram's alt text names the message kind.
 */
function hero({ art, alt = '', eyebrow = null, eyebrowColor = MUTED, kicker = null, kickerColor = BLUE, title, meta = null }) {
  const img = art ? brandImg(art, { size: 64, alt }) : '';
  const parts = [];
  if (eyebrow) parts.push(`<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.8px;text-transform:uppercase;color:${eyebrowColor};">${escapeHtml(eyebrow)}</div>`);
  if (kicker) parts.push(`<div style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${kickerColor};${eyebrow ? 'margin-top:2px;' : ''}">${escapeHtml(kicker)}</div>`);
  parts.push(`<div style="font-family:${FONT};font-size:23px;line-height:29px;font-weight:bold;color:${INK};margin-top:${eyebrow || kicker ? 6 : 0}px;">${escapeHtml(title || 'Ticket')}</div>`);
  if (meta) parts.push(`<div style="font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};margin-top:4px;">${escapeHtml(meta)}</div>`);
  if (!img) return `<tr><td>${parts.join('')}</td></tr>`;
  return '<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>'
    + `<td width="80" valign="top" style="padding:2px 16px 0 0;">${img}</td>`
    + `<td valign="top">${parts.join('')}</td></tr></table></td></tr>`;
}

/** The approval category as a quiet strip between two hairlines: small icon, eyebrow, name; amount and tier as chips on the right. */
function categoryCard({ categoryName, amountLabel = null, tierLabel = null }) {
  if (!categoryName) return '';
  const art = brandImg(categoryArt(categoryName), { size: 32, alt: '' });
  const chips = [
    amountLabel ? `<span style="font-family:${FONT};font-size:14px;line-height:18px;font-weight:bold;color:${INK};">${escapeHtml(amountLabel)}</span>` : '',
    tierLabel ? `<span style="font-family:${FONT};font-size:12px;line-height:18px;color:${MUTED};">${escapeHtml(tierLabel)}</span>` : '',
  ].filter(Boolean).join('<span style="color:#cbd5e1;">&nbsp;&nbsp;·&nbsp;&nbsp;</span>');
  return [
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;border-top:1px solid ${LINE};border-bottom:1px solid ${LINE};"><tr>`,
    art ? `<td width="44" valign="middle" style="padding:12px 12px 12px 0;">${art}</td>` : '',
    `<td valign="middle" style="padding:12px 0;font-family:${FONT};">`,
    `<div style="font-size:10.5px;line-height:14px;letter-spacing:0.8px;text-transform:uppercase;color:${MUTED};font-weight:bold;">Approval category</div>`,
    `<div style="font-size:16px;line-height:22px;font-weight:bold;color:${INK};margin-top:1px;">${escapeHtml(categoryName)}</div>`,
    '</td>',
    chips ? `<td align="right" valign="middle" style="padding:12px 0;white-space:nowrap;">${chips}</td>` : '',
    '</tr></table>',
  ].join('');
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

const VERDICT_ART = { approved: 'kind-approved', condition: 'kind-condition', rejected: 'kind-rejected' };
function verdictOf(approved, conditionNote) {
  if (!approved) return { word: 'Not approved', art: VERDICT_ART.rejected, tone: TONES.red };
  if (conditionNote) return { word: 'Approved with condition', art: VERDICT_ART.condition, tone: TONES.green };
  return { word: 'Approved', art: VERDICT_ART.approved, tone: TONES.green };
}

// ---------------------------------------------------------------- the e-mails

/**
 * Approver: "your decision is needed". ctx:
 *  { workspaceName, categoryName, ticket:{ref, subject, createdAt, dueBy, priorityLabel, typeLabel, categoryPath, statusLabel, description, appUrl},
 *    requester:{name,title,department,location,photoCid?}, requestedByName, requestedByPhotoCid?, approverName,
 *    noteHtml (already sanitized + placeholders substituted), clarification:{question,answer}|null,
 *    otherApprovers:[{name,status}], decisionUrl, expiresAt, reRequest:boolean, amountLabel?, tierLabel? }
 */
export function renderApproverRequestEmail(ctx) {
  const t = ctx.ticket || {};
  const requester = ctx.requester || {};
  const rows = [];
  // The category has its own strip directly below the hero; naming it in the
  // kicker as well read as a stutter. Without a category the kicker says "Approval".
  const headline = ctx.categoryName
    ? (ctx.reRequest ? 'Re-requested with the answer you asked for' : 'Your decision is needed')
    : (ctx.reRequest ? 'Approval — re-requested with the answer you asked for' : 'Approval — your decision is needed');
  const metaBits = [t.ref, t.createdAt ? `created ${fmtDay(t.createdAt)}` : null, t.dueBy ? `due ${fmtDay(t.dueBy)}` : null].filter(Boolean);
  rows.push(hero({
    art: 'kind-decision',
    alt: ctx.reRequest ? 'Re-requested' : 'Approval requested',
    kicker: headline,
    title: t.subject || 'Ticket',
    meta: metaBits.length ? metaBits.join('  ·  ') : null,
  }));
  rows.push(spacer(18));

  // The category, front and centre — it is what the approver is deciding on.
  const catCard = categoryCard({ categoryName: ctx.categoryName, amountLabel: ctx.amountLabel || null, tierLabel: ctx.amountLabel ? (ctx.tierLabel || 'Tier 1') : (ctx.tierLabel || null) });
  if (catCard) {
    rows.push(`<tr><td>${catCard}</td></tr>`); rows.push(spacer(12));
  } else if (ctx.amountLabel || ctx.tierLabel) {
    // No category to hang the chips on — the amount and tier stay visible as facts.
    rows.push('<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
      + `<tr>${factCell('Amount', ctx.amountLabel ? `<span style="font-size:15px;">${escapeHtml(ctx.amountLabel)}</span>` : '—')}${factCell('Approval tier', escapeHtml(ctx.tierLabel || 'Tier 1'))}</tr>`
      + '</table></td></tr>');
    rows.push(spacer(12));
  }

  // People — side by side, same avatar size; the recipient gets the wider, tinted card.
  // Title on one line, place on the next; a department that merely repeats the location is dropped.
  const place = [requester.location && !(requester.title || '').toLowerCase().includes(String(requester.location).toLowerCase()) ? requester.location : null,
    requester.department && requester.department !== requester.location ? requester.department : null].filter(Boolean).join(' · ');
  rows.push(`<tr><td>${peopleRow(
    personCard({ label: 'Requested for', name: requester.name || 'Unknown requester', lines: [requester.title, place], photoCid: requester.photoCid || null, emphasis: true }),
    personCard({ label: 'Asked by', name: ctx.requestedByName || 'Agent', lines: ['Service desk agent'], photoCid: ctx.requestedByPhotoCid || null }),
  )}</td></tr>`);
  rows.push(spacer(18));

  // Hand-off block (Approvals v2): why this landed with THIS approver.
  const h = ctx.handoff;
  if (h && h.kind) {
    const by = escapeHtml(h.byName || 'The previous approver');
    let lead;
    if (h.kind === 'forwarded') lead = `<b>${by}</b> forwarded this request to you as the <b>final approver</b>.`;
    else if (h.kind === 'auto_start') lead = `This request comes to you at <b>${escapeHtml(h.toTierName || 'this tier')}</b> directly: ${escapeHtml(h.note || `${h.byName || 'the requester'} is an approver on the earlier tier and cannot approve their own request`)}.`;
    else if (h.kind === 'auto') lead = `<b>${by}</b> approved this at ${escapeHtml(h.fromTierName || 'the previous tier')}, but the amount is over that tier's limit${h.limitLabel ? ` (${escapeHtml(h.limitLabel)})` : ''} — so <b>your approval is needed</b> at ${escapeHtml(h.toTierName || 'this tier')}.`;
    else lead = `<b>${by}</b> escalated this request from ${escapeHtml(h.fromTierName || 'the previous tier')} to you (${escapeHtml(h.toTierName || 'next tier')}).`;
    // auto_start's "note" IS the reason already spoken in the lead — don't say it twice.
    const noteHtml = h.note && h.kind !== 'auto_start' ? `<p style="margin:8px 0 0;font-size:14px;line-height:20px;color:${INK};"><b>Their note:</b> ${escapeHtml(h.note)}</p>` : '';
    rows.push(`<tr><td>${card(`<p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${INK};">${lead}</p>${noteHtml}`, { bg: '#fff7ed', border: '#fdba74', accent: '#f59e0b' })}</td></tr>`);
    rows.push(spacer(14));
  }

  // Facts
  rows.push('<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
    + `<tr>${factCell('Priority', priorityHtml(t.priorityLabel))}${factCell('Type', escapeHtml(t.typeLabel || '—'))}</tr>`
    + `<tr>${factCell('Category', escapeHtml(t.categoryPath || '—'))}${factCell('Status', escapeHtml(t.statusLabel || '—'))}</tr>`
    + '</table></td></tr>');
  rows.push(spacer(10));

  // Clarification thread (re-request)
  if (ctx.clarification?.answer) {
    const q = ctx.clarification.question ? `<p style="margin:0 0 6px;color:#5b21b6;"><b>You asked:</b> ${escapeHtml(ctx.clarification.question)}</p>` : '';
    rows.push(`<tr><td>${card(`${q}<p style="margin:0;"><b>${escapeHtml(ctx.requestedByName || 'The agent')} replied:</b> ${escapeHtml(ctx.clarification.answer)}</p>`, { bg: '#f5f3ff', border: '#ddd6fe', accent: '#7c3aed' })}</td></tr>`);
    rows.push(spacer(14));
  }

  // Note
  if (ctx.noteHtml) {
    rows.push(`<tr><td>${card(`${sectionLabel(`Note from ${ctx.requestedByName || 'the agent'}`)}${ctx.noteHtml}`, { accent: BLUE })}</td></tr>`);
    rows.push(spacer(14));
  }

  // Description — formatted like the ticket (lists, bold, tables), not a
  // flattened excerpt; long ones are cut on a block and point at the page.
  const desc = descriptionHtmlForEmail(t.description);
  if (desc.html) {
    rows.push(`<tr><td style="font-family:${FONT};">${sectionLabel('Ticket description')}<div style="font-family:${FONT};font-size:14px;line-height:21px;color:#1e293b;">${desc.html}</div>${desc.truncated ? `<div style="font-size:12px;line-height:18px;color:${MUTED};margin-top:6px;">… the full description is on the approval page.</div>` : ''}</td></tr>`);
    rows.push(spacer(14));
  }

  // Other approvers
  const others = (ctx.otherApprovers || []).filter((a) => a && a.name);
  if (others.length > 0) {
    const list = others.map((a) => `${escapeHtml(a.name)}${a.status && a.status !== 'pending' ? ` (${escapeHtml(a.status)})` : ''}`).join(', ');
    rows.push(`<tr><td style="font-family:${FONT};font-size:13px;line-height:19px;color:#334155;">${sectionLabel('Also asked to approve')}${list} — the first decision closes the request for everyone.</td></tr>`);
    rows.push(spacer(14));
  }

  // CTA
  rows.push(spacer(4));
  rows.push(`<tr><td>${button(ctx.reRequest ? 'Review the answer and decide' : 'Review and decide', ctx.decisionUrl)}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Approve, reject with a reason, or ask ${escapeHtml(ctx.requestedByName || 'the agent')} a question first — it takes a minute.${t.appUrl ? ` Signed-in agents can also <a href="${escapeHtml(t.appUrl)}" style="color:${BLUE};">open the ticket in Ticket Pulse</a>.` : ''}</td></tr>`);
  rows.push(spacer(8));

  const expires = fmtDayLong(ctx.expiresAt);
  const footer = `This link is personal to you — please don't forward it.${expires ? ` It expires on ${escapeHtml(expires)}.` : ''}<br>Sent by Ticket Pulse on behalf of ${escapeHtml(ctx.requestedByName || 'the service desk')}${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}.`;
  const preheader = `${ctx.requestedByName || 'An agent'} needs your approval for ${requester.name || 'a request'}: ${t.subject || ''}`;
  return emailShell({ workspaceName: ctx.workspaceName, bodyRows: rows, footerHtml: footer, preheader });
}

/**
 * Requester (the agent): the verdict. ctx:
 *  { workspaceName, ticket:{ref, subject, appUrl}, approved:boolean, approverName, isSelf, changedFrom, note, conditionNote, signatureHtml, requester:{name} }
 */
export function renderRequesterDecisionEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const v = verdictOf(approved, ctx.conditionNote);
  const verdict = v.word;
  const tone = v.tone;
  const who = ctx.isSelf ? 'You' : (ctx.approverName || 'The approver');
  const forWhom = ctx.requester?.name ? ` for <b>${escapeHtml(ctx.requester.name)}</b>` : '';
  // Sentence case: the eyebrow above already carries the verdict in capitals; repeating it in
  // capitals inside the sentence shouted it twice (Vahid, 18 Sep 2026).
  const verdictWord = `<span style="color:${tone.color};font-weight:bold;">${escapeHtml(verdict.toLowerCase())}</span>`;
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
  rows.push(hero({
    art: v.art,
    alt: verdict,
    eyebrow: `${verdict}${ctx.changedFrom ? ' (changed)' : ''}`,
    eyebrowColor: tone.color,
    kicker: ctx.categoryName ? `${ctx.categoryName} approval` : null,
    title: t.subject || 'Ticket',
    meta: t.ref || null,
  }));
  rows.push(spacer(16));
  rows.push(`<tr><td>${card(`<div style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${sentence}</div>`, { bg: tone.bg, border: tone.line, accent: tone.color })}</td></tr>`);
  if (ctx.requester?.name) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${peopleRow(personCard({ label: 'Requested for', name: ctx.requester.name, lines: [ctx.requester.title, ctx.requester.location].filter(Boolean), photoCid: ctx.requester.photoCid || null, emphasis: true }))}</td></tr>`);
  }
  if (ctx.conditionNote) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel('Condition')}<div style="font-size:14px;line-height:20px;color:#7c2d12;">${escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>')}</div>`, { bg: '#fff7ed', border: '#fdba74', accent: '#f59e0b' })}</td></tr>`);
  }
  if (ctx.note) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel(ctx.isSelf ? 'Your note' : `Note from ${ctx.approverName || 'the approver'}`)}${escapeHtml(ctx.note).replace(/\r?\n/g, '<br>')}`, { accent: BLUE })}</td></tr>`);
  }
  if (ctx.signatureHtml) {
    rows.push(spacer(10));
    rows.push(`<tr><td style="font-family:${FONT};font-size:13px;line-height:18px;color:#334155;">${ctx.signatureHtml}</td></tr>`);
  }
  rows.push(spacer(18));
  if (t.appUrl) rows.push(`<tr><td>${button('Open the ticket', t.appUrl, { bg: approved ? '#059669' : '#334155' })}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">${approved ? 'The approval is recorded on the ticket — you can proceed.' : 'The rejection and the reason are recorded on the ticket.'}</td></tr>`);
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}. The full approval trail is on the ticket.`,
    preheader: `${who} ${verb} your approval request on ${t.ref || 'the ticket'}`,
  });
}

/**
 * Requester (the agent): the request moved to another approver (Approvals v2).
 * ctx: { workspaceName, ticket:{ref, subject, appUrl}, kind:'escalated'|'forwarded'|'auto',
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
  rows.push(hero({
    art: forwarded ? 'kind-forwarded' : 'kind-escalated',
    alt: forwarded ? 'Forwarded' : 'Escalated',
    eyebrow: forwarded ? 'Forwarded' : 'Escalated',
    eyebrowColor: TONES.amber.color,
    kicker: ctx.categoryName ? `${ctx.categoryName} approval` : `Approval ${forwarded ? 'forwarded' : 'escalated'}`,
    title: t.subject || '(no subject)',
    meta: t.ref || null,
  }));
  rows.push(spacer(16));
  rows.push(`<tr><td>${card(`<div style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${sentence}</div>`, { bg: '#fff7ed', border: '#fdba74', accent: '#f59e0b' })}</td></tr>`);
  rows.push(spacer(18));
  if (t.appUrl) rows.push(`<tr><td>${button('Open the ticket', t.appUrl, { bg: '#334155' })}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Nothing is needed from you — you will get another e-mail when the decision is made.</td></tr>`);
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}. The full approval trail is on the ticket.`,
    preheader: `${ctx.byName || 'The approver'} ${forwarded ? 'forwarded' : 'escalated'} your approval request on ${t.ref || 'the ticket'} to ${who}`,
  });
}

/**
 * Requester (the agent): the approver asked a question. ctx:
 *  { workspaceName, ticket:{ref, subject, appUrl}, approverName, question, requester:{name} }
 */
export function renderRequesterClarificationEmail(ctx) {
  const t = ctx.ticket || {};
  const rows = [];
  rows.push(hero({
    art: 'kind-question',
    alt: 'Question from the approver',
    eyebrow: 'Needs your answer',
    eyebrowColor: TONES.violet.color,
    kicker: 'Question from the approver',
    kickerColor: '#5b21b6',
    title: t.subject || 'Ticket',
    meta: t.ref || null,
  }));
  rows.push(spacer(16));
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};"><b>${escapeHtml(ctx.approverName || 'The approver')}</b> needs more information before deciding${ctx.requester?.name ? ` the request for <b>${escapeHtml(ctx.requester.name)}</b>` : ''}.</td></tr>`);
  rows.push(spacer(12));
  rows.push(`<tr><td>${card(`${sectionLabel('Their question')}<div style="font-size:15px;line-height:22px;">${escapeHtml(ctx.question || '')}</div>`, { bg: '#f5f3ff', border: '#ddd6fe', accent: '#7c3aed' })}</td></tr>`);
  rows.push(spacer(18));
  if (t.appUrl) rows.push(`<tr><td>${button('Answer on the ticket', t.appUrl, { bg: '#7c3aed' })}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Your answer goes back to ${escapeHtml(ctx.approverName || 'the approver')} by e-mail and the approval link re-opens for them.</td></tr>`);
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}.`,
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
  const kicker = ctx.kind === 'answer' ? 'Answer on an approval' : ctx.kind === 'comment' ? 'Note on an approval' : 'Question on an approval';
  const by = escapeHtml(ctx.authorName || 'An approver');
  const art = ctx.kind === 'answer' ? 'kind-answer' : ctx.kind === 'comment' ? 'kind-note' : 'kind-question';
  const eyebrow = ctx.kind === 'answer' ? 'Answer' : ctx.kind === 'comment' ? 'Note' : 'Question';
  const tone = ctx.kind === 'answer' ? TONES.green : TONES.violet;
  rows.push(hero({
    art,
    alt: eyebrow,
    eyebrow,
    eyebrowColor: tone.color,
    kicker: `${kicker}${ctx.categoryName ? ` · ${ctx.categoryName}` : ''}`,
    kickerColor: MUTED,
    title: t.subject || '(no subject)',
    meta: t.ref || null,
  }));
  rows.push(spacer(16));
  const lead = ctx.kind === 'answer'
    ? `<b>${by}</b> answered${ctx.recipient?.name ? ' your question' : ''}:`
    : ctx.kind === 'comment'
      ? `<b>${by}</b> left a note${ctx.isCc ? ' (you are copied)' : ' for you'}:`
      : `<b>${by}</b> has a question${ctx.isCc ? ' (you are copied)' : ' for you'}:`;
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${lead}</td></tr>`);
  rows.push(spacer(10));
  const body = ctx.bodyHtml ? (normalizeNoteHtmlForEmail(ctx.bodyHtml) || ctx.bodyHtml) : escapeHtml(ctx.bodyText || '').replace(/\n/g, '<br>');
  rows.push(`<tr><td>${card(`<div style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${body}</div>`, { accent: tone.color })}</td></tr>`);
  if (ctx.internalNote) {
    rows.push(spacer(8));
    rows.push(`<tr><td style="font-family:${FONT};font-size:12.5px;line-height:18px;color:#92400e;">Internal — the ticket requester is not on this message.</td></tr>`);
  }
  if (ctx.replyUrl || ctx.canReplyByEmail) {
    rows.push(spacer(16));
    if (ctx.replyUrl) rows.push(`<tr><td>${button(ctx.kind === 'question' ? 'Answer' : 'Reply', ctx.replyUrl)}</td></tr>`);
    rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">${ctx.canReplyByEmail ? 'Or simply reply to this e-mail — your answer lands on the request and everyone on it is told.' : 'Use the button to answer — this mailbox does not read replies.'}</td></tr>`);
  }
  const thread = Array.isArray(ctx.thread) ? ctx.thread.filter((m) => m && (m.bodyText || m.bodyHtml)) : [];
  if (thread.length) {
    rows.push(spacer(18));
    rows.push(`<tr><td style="font-family:${FONT};">${sectionLabel('Earlier on this request')}</td></tr>`);
    for (const m of thread.slice(-8)) {
      const who = escapeHtml(m.author?.name || m.author?.email || 'Someone');
      const when = m.createdAt ? fmtDay(m.createdAt) : '';
      const label = m.kind === 'question' ? 'asked' : m.kind === 'answer' ? 'answered' : m.kind === 'decision' ? 'decided' : m.kind === 'handoff' ? 'handed off' : 'wrote';
      const mb = m.bodyHtml ? (normalizeNoteHtmlForEmail(m.bodyHtml) || m.bodyHtml) : escapeHtml(m.bodyText || '').replace(/\n/g, '<br>');
      rows.push(`<tr><td style="padding:6px 0 0 12px;border-left:3px solid ${LINE};font-family:${FONT};font-size:13px;line-height:19px;color:#334155;"><b>${who}</b> ${label}${when ? ` · ${escapeHtml(when)}` : ''}${m.audience === 'internal' ? ' · internal' : ''}<div style="margin-top:2px;">${mb}</div></td></tr>`);
      rows.push(spacer(6));
    }
  }
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName || null,
    bodyRows: rows,
    footerHtml: 'Sent by Ticket Pulse. This message is part of an approval on the ticket above.',
    preheader: `${ctx.authorName || 'An approver'}: ${String(ctx.bodyText || '').slice(0, 120)}`,
  });
}

/**
 * Approvals v3 — the decision, reply-style, to the requester and the chain.
 * ctx: { workspaceName, categoryName, ticket:{ref,subject,appUrl|null}, approved, changedFrom, approverName,
 *   note, conditionNote, signatureHtml, recipient:{role,name}, requester:{name}, requestNote(Html), requestedByName, thread:[…] }
 */
export function renderDecisionThreadEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const v = verdictOf(approved, ctx.conditionNote);
  const verdict = v.word;
  const tone = v.tone;
  const rows = [];
  rows.push(hero({
    art: v.art,
    alt: verdict,
    eyebrow: verdict,
    eyebrowColor: tone.color,
    kicker: ctx.categoryName ? `${ctx.categoryName} approval` : 'Approval',
    kickerColor: MUTED,
    title: t.subject || '(no subject)',
    meta: t.ref || null,
  }));
  rows.push(spacer(16));
  const greet = ctx.recipient?.name ? `Hi ${escapeHtml(String(ctx.recipient.name).split(' ')[0])},` : 'Hello,';
  const forWhom = ctx.requester?.name && ctx.recipient?.role !== 'requester' ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${greet}<br><br><b>${escapeHtml(ctx.approverName || 'The approver')}</b> has <span style="color:${tone.color};font-weight:bold;">${escapeHtml(verdict.toLowerCase())}</span> the request${forWhom}${ctx.changedFrom ? ` (changed from ${escapeHtml(ctx.changedFrom === 'rejected' ? 'not approved' : ctx.changedFrom)})` : ''}.</td></tr>`);
  if (ctx.categoryName) {
    rows.push(spacer(14));
    rows.push(`<tr><td>${categoryCard({ categoryName: ctx.categoryName, amountLabel: ctx.amountLabel || null, tierLabel: ctx.tierLabel || null })}</td></tr>`);
  }
  if (ctx.conditionNote) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel('Condition')}<div style="font-size:15px;line-height:22px;color:#7c2d12;">${escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>')}</div>`, { bg: '#fff7ed', border: '#fdba74', accent: '#f59e0b' })}</td></tr>`);
  }
  if (ctx.note) {
    rows.push(spacer(12));
    rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${escapeHtml(ctx.note).replace(/\n/g, '<br>')}</td></tr>`);
  }
  if (ctx.signatureHtml) {
    rows.push(spacer(14));
    rows.push(`<tr><td style="font-family:${FONT};font-size:13px;line-height:18px;color:#334155;">${ctx.signatureHtml}</td></tr>`);
  }
  if (t.appUrl) {
    rows.push(spacer(16));
    rows.push(`<tr><td>${button('Open the ticket', t.appUrl, { bg: approved ? '#059669' : '#334155' })}</td></tr>`);
  }
  // History — quoted like a reply thread, newest first.
  const history = [];
  for (const m of (Array.isArray(ctx.thread) ? ctx.thread : []).slice().reverse()) {
    if (!m || !(m.bodyText || m.bodyHtml)) continue;
    const who = escapeHtml(m.author?.name || m.author?.email || 'Someone');
    const label = m.kind === 'question' ? 'asked' : m.kind === 'answer' ? 'answered' : m.kind === 'handoff' ? 'handed off' : 'wrote';
    const mb = m.bodyHtml ? (normalizeNoteHtmlForEmail(m.bodyHtml) || m.bodyHtml) : escapeHtml(m.bodyText || '').replace(/\n/g, '<br>');
    history.push(`<div style="margin:0 0 10px;padding:0 0 0 12px;border-left:3px solid ${LINE};"><div style="font-size:12.5px;color:${MUTED};">On ${escapeHtml(m.createdAt ? fmtDayLong(m.createdAt) : '')}, <b>${who}</b> ${label}${m.audience === 'internal' ? ' (internal)' : ''}:</div><div style="font-size:13.5px;line-height:19px;color:#334155;margin-top:2px;">${mb}</div></div>`);
  }
  if (ctx.requestNoteHtml || ctx.requestNote) {
    const rb = ctx.requestNoteHtml ? (normalizeNoteHtmlForEmail(ctx.requestNoteHtml) || ctx.requestNoteHtml) : escapeHtml(ctx.requestNote || '').replace(/\n/g, '<br>');
    history.push(`<div style="margin:0 0 10px;padding:0 0 0 12px;border-left:3px solid ${LINE};"><div style="font-size:12.5px;color:${MUTED};"><b>${escapeHtml(ctx.requestedByName || 'The agent')}</b> asked for approval:</div><div style="font-size:13.5px;line-height:19px;color:#334155;margin-top:2px;">${rb}</div></div>`);
  }
  if (history.length) {
    rows.push(spacer(20));
    rows.push(`<tr><td style="font-family:${FONT};">${sectionLabel('History')}${history.join('')}</td></tr>`);
  }
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}.${ctx.recipient?.role === 'requester' ? '' : ' The full approval trail is on the ticket.'}`,
    preheader: `${ctx.approverName || 'The approver'} ${verdict.toLowerCase()} — ${t.subject || t.ref || ''}`,
  });
}

export default {
  renderApproverRequestEmail, renderRequesterDecisionEmail, renderRequesterClarificationEmail, renderRequesterHandoffEmail,
  renderApprovalMessageEmail, renderDecisionThreadEmail, descriptionHtmlForEmail,
  normalizeNoteHtmlForEmail, dropEmptyTableColumns, textExcerpt, escapeHtml, initialsOf, emailShell,
};
