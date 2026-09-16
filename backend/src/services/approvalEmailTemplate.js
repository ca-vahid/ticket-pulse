/**
 * Approval e-mails (MEGA-0901 AP-2). Table-based, inline-styled HTML that
 * survives Outlook desktop / OWA / Gmail / Apple Mail: a 640px white card on a
 * slate ground, Arial stack, no REMOTE images (Outlook blocks data URIs and
 * remote pictures by default). People photos ride along as inline (cid:)
 * attachments; initials circles (plain table cells) are the fallback.
 *
 * Everything user-supplied is escaped here; the request note arrives already
 * sanitized by ticketApprovalService (allow-list) and is only *normalized* for
 * mail clients (fixed widths / empty spreadsheet columns stripped, borders
 * and padding applied) — see normalizeNoteHtmlForEmail.
 */
import sanitizeHtml from 'sanitize-html';

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

function spacer(h = 16) {
  return `<tr><td height="${h}" style="height:${h}px;line-height:${h}px;font-size:1px;">&nbsp;</td></tr>`;
}

function pill(label, { bg, color }) {
  return `<span style="display:inline-block;padding:3px 10px;border-radius:999px;background:${bg};color:${color};font-family:${FONT};font-size:11px;line-height:16px;font-weight:bold;letter-spacing:0.4px;text-transform:uppercase;">${escapeHtml(label)}</span>`;
}

const TONES = {
  amber: { bg: '#fef3c7', color: '#92400e' },
  blue: { bg: '#dbeafe', color: '#1e40af' },
  green: { bg: '#d1fae5', color: '#065f46' },
  red: { bg: '#fee2e2', color: '#991b1b' },
  violet: { bg: '#ede9fe', color: '#5b21b6' },
  slate: { bg: '#e2e8f0', color: '#334155' },
};

function initialsCircle(name, size = 40) {
  const font = size >= 40 ? 14 : 12;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr><td width="${size}" height="${size}" align="center" valign="middle" style="width:${size}px;height:${size}px;border-radius:${size / 2}px;background:#dbeafe;color:#1d4ed8;font-family:${FONT};font-size:${font}px;font-weight:bold;line-height:${size}px;">${escapeHtml(initialsOf(name))}</td></tr></table>`;
}

function photoCircle(cid, name, size) {
  // Inline attachment referenced by cid: — the picture is INSIDE the message (no remote fetch, works
  // with images-off policies). Outlook desktop ignores border-radius; the square photo is still right.
  return `<img src="cid:${escapeHtml(cid)}" width="${size}" height="${size}" alt="${escapeHtml(initialsOf(name))}" style="display:block;width:${size}px;height:${size}px;border-radius:${size / 2}px;border:0;">`;
}

function personRow({ label, name, meta, size = 40, photoCid = null }) {
  return [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>',
    `<td width="${size + 12}" valign="middle" style="padding:0 12px 0 0;">${photoCid ? photoCircle(photoCid, name, size) : initialsCircle(name, size)}</td>`,
    `<td valign="middle" style="font-family:${FONT};">`,
    `<div style="font-size:11px;line-height:14px;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</div>`,
    `<div style="font-size:15px;line-height:20px;font-weight:bold;color:${INK};">${escapeHtml(name || 'Unknown')}</div>`,
    meta ? `<div style="font-size:12.5px;line-height:17px;color:${MUTED};">${escapeHtml(meta)}</div>` : '',
    '</td></tr></table>',
  ].join('');
}

function factCell(label, valueHtml) {
  return `<td width="50%" valign="top" style="padding:0 8px 10px 0;font-family:${FONT};"><div style="font-size:11px;line-height:14px;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">${escapeHtml(label)}</div><div style="font-size:14px;line-height:20px;color:${INK};font-weight:bold;">${valueHtml || '—'}</div></td>`;
}

const PRIORITY_DOT = { Urgent: '#dc2626', High: '#f97316', Medium: '#10b981', Low: '#64748b' };
function priorityHtml(label) {
  if (!label) return '—';
  const color = PRIORITY_DOT[label] || '#94a3b8';
  return `<span style="display:inline-block;width:8px;height:8px;border-radius:4px;background:${color};margin:0 6px 1px 0;"></span>${escapeHtml(label)}`;
}

function button(label, url, { bg = BLUE } = {}) {
  return [
    '<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;"><tr>',
    `<td align="center" bgcolor="${bg}" style="border-radius:8px;background:${bg};">`,
    `<a href="${escapeHtml(url)}" target="_blank" style="display:inline-block;padding:12px 26px;font-family:${FONT};font-size:15px;line-height:20px;font-weight:bold;color:#ffffff;text-decoration:none;border-radius:8px;">${escapeHtml(label)} &rarr;</a>`,
    '</td></tr></table>',
  ].join('');
}

function card(innerHtml, { bg = '#f8fafc', border = LINE } = {}) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;background:${bg};border:1px solid ${border};border-radius:10px;"><tr><td style="padding:14px 16px;font-family:${FONT};font-size:14px;line-height:21px;color:${INK};">${innerHtml}</td></tr></table>`;
}

function sectionLabel(text) {
  return `<div style="font-family:${FONT};font-size:11px;line-height:14px;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};margin:0 0 6px;">${escapeHtml(text)}</div>`;
}

/**
 * The shell: slate ground → 640px white card with a brand band on top and a
 * muted footer below. `bodyRows` are <tr> strings for the card body table.
 */
export function emailShell({ workspaceName, statusPill, bodyRows, footerHtml, preheader = '' }) {
  const band = [
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;"><tr>',
    `<td width="36" valign="middle" style="padding:0 10px 0 0;"><table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr><td width="36" height="36" align="center" valign="middle" bgcolor="${BLUE}" style="width:36px;height:36px;border-radius:9px;background:${BLUE};color:#ffffff;font-family:${FONT};font-size:14px;font-weight:bold;line-height:36px;">TP</td></tr></table></td>`,
    `<td valign="middle" style="font-family:${FONT};"><div style="font-size:15px;line-height:19px;font-weight:bold;color:${INK};">Ticket Pulse</div><div style="font-size:12px;line-height:16px;color:${MUTED};">${escapeHtml(workspaceName ? `${workspaceName} workspace` : 'Service desk')}</div></td>`,
    statusPill ? `<td align="right" valign="middle">${statusPill}</td>` : '',
    '</tr></table>',
  ].join('');
  return [
    '<!DOCTYPE html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="x-apple-disable-message-reformatting"><title></title></head>',
    '<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%;">',
    preheader ? `<div style="display:none;max-height:0;overflow:hidden;font-size:1px;line-height:1px;color:#f1f5f9;">${escapeHtml(preheader)}${'&nbsp;&zwnj;'.repeat(40)}</div>` : '',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;background:#f1f5f9;"><tr><td align="center" style="padding:24px 12px;">',
    '<!--[if mso]><table role="presentation" width="640" cellpadding="0" cellspacing="0" border="0"><tr><td><![endif]-->',
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:separate;max-width:640px;background:#ffffff;border:1px solid ${LINE};border-radius:14px;">`,
    `<tr><td style="padding:18px 28px;border-bottom:1px solid ${LINE};">${band}</td></tr>`,
    '<tr><td style="padding:24px 28px 8px;">',
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

/**
 * Approver: "your decision is needed". ctx:
 *  { workspaceName, categoryName, ticket:{ref, subject, createdAt, dueBy, priorityLabel, typeLabel, categoryPath, statusLabel, description, appUrl},
 *    requester:{name,title,department,location,photoCid?}, requestedByName, requestedByPhotoCid?, approverName,
 *    noteHtml (already sanitized + placeholders substituted), clarification:{question,answer}|null,
 *    otherApprovers:[{name,status}], decisionUrl, expiresAt, reRequest:boolean }
 */
export function renderApproverRequestEmail(ctx) {
  const t = ctx.ticket || {};
  const requester = ctx.requester || {};
  const rows = [];
  const kicker = ctx.categoryName ? `${ctx.categoryName} approval` : 'Approval';
  const headline = ctx.reRequest
    ? `${kicker} — re-requested with the answer you asked for`
    : `${kicker} — your decision is needed`;
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${BLUE};">${escapeHtml(headline)}</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || 'Ticket')}</td></tr>`);
  const metaBits = [t.ref, t.createdAt ? `created ${fmtDay(t.createdAt)}` : null, t.dueBy ? `due ${fmtDay(t.dueBy)}` : null].filter(Boolean);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(metaBits.join('  ·  '))}</td></tr>`);
  rows.push(spacer(18));

  // People
  const requesterMeta = [requester.title, requester.location && !(requester.title || '').toLowerCase().includes(String(requester.location).toLowerCase()) ? requester.location : null,
    requester.department && requester.department !== requester.location ? requester.department : null].filter(Boolean).join(' · ');
  rows.push(`<tr><td>${personRow({ label: 'Requested for', name: requester.name || 'Unknown requester', meta: requesterMeta, photoCid: requester.photoCid || null })}</td></tr>`);
  rows.push(spacer(12));
  rows.push(`<tr><td>${personRow({ label: 'Asked by', name: ctx.requestedByName || 'Agent', meta: ctx.workspaceName ? `${ctx.workspaceName} workspace` : null, size: 32, photoCid: ctx.requestedByPhotoCid || null })}</td></tr>`);
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
    const noteHtml = h.note ? `<p style="margin:8px 0 0;font-size:14px;line-height:20px;color:${INK};"><b>Their note:</b> ${escapeHtml(h.note)}</p>` : '';
    rows.push(`<tr><td>${card(`<p style="margin:0;font-family:${FONT};font-size:14px;line-height:20px;color:${INK};">${lead}</p>${noteHtml}`, { bg: '#fff7ed', border: '#fdba74' })}</td></tr>`);
    rows.push(spacer(14));
  }

  // Facts
  rows.push('<tr><td><table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse:collapse;">'
    + `<tr>${factCell('Priority', priorityHtml(t.priorityLabel))}${factCell('Type', escapeHtml(t.typeLabel || '—'))}</tr>`
    + `<tr>${factCell('Category', escapeHtml(t.categoryPath || '—'))}${factCell('Status', escapeHtml(t.statusLabel || '—'))}</tr>`
    + (ctx.amountLabel ? `<tr>${factCell('Amount', `<span style="font-size:15px;">${escapeHtml(ctx.amountLabel)}</span>`)}${factCell('Approval tier', escapeHtml(ctx.tierLabel || 'Tier 1'))}</tr>` : '')
    + '</table></td></tr>');
  rows.push(spacer(6));

  // Clarification thread (re-request)
  if (ctx.clarification?.answer) {
    const q = ctx.clarification.question ? `<p style="margin:0 0 6px;color:#5b21b6;"><b>You asked:</b> ${escapeHtml(ctx.clarification.question)}</p>` : '';
    rows.push(`<tr><td>${card(`${q}<p style="margin:0;"><b>${escapeHtml(ctx.requestedByName || 'The agent')} replied:</b> ${escapeHtml(ctx.clarification.answer)}</p>`, { bg: '#f5f3ff', border: '#ddd6fe' })}</td></tr>`);
    rows.push(spacer(14));
  }

  // Note
  if (ctx.noteHtml) {
    rows.push(`<tr><td>${card(`${sectionLabel(`Note from ${ctx.requestedByName || 'the agent'}`)}${ctx.noteHtml}`)}</td></tr>`);
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
  return emailShell({
    workspaceName: ctx.workspaceName,
    statusPill: pill(ctx.reRequest ? 'Re-requested' : 'Approval requested', TONES.amber),
    bodyRows: rows,
    footerHtml: footer,
    preheader,
  });
}

/**
 * Requester (the agent): the verdict. ctx:
 *  { workspaceName, ticket:{ref, subject, appUrl}, approved:boolean, approverName, isSelf, changedFrom, note, requester:{name} }
 */
export function renderRequesterDecisionEmail(ctx) {
  const t = ctx.ticket || {};
  const approved = !!ctx.approved;
  const verdict = approved ? (ctx.conditionNote ? 'Approved with condition' : 'Approved') : 'Rejected';
  const tone = approved ? TONES.green : TONES.red;
  const who = ctx.isSelf ? 'You' : (ctx.approverName || 'The approver');
  const forWhom = ctx.requester?.name ? ` for <b>${escapeHtml(ctx.requester.name)}</b>` : '';
  const verdictWord = `<span style="color:${tone.color};font-weight:bold;">${verdict.toUpperCase()}</span>`;
  // Sentence shapes are load-bearing (inbox filters + tests): "<actor> decided your approval request",
  // "changed the decision on your approval request", "You approved your own approval request".
  const sentence = ctx.isSelf
    ? (ctx.changedFrom
      ? `You changed the decision on your own approval request${forWhom}: ${verdictWord}`
      : `You ${approved ? 'approved' : 'rejected'} your own approval request${forWhom}.`)
    : (ctx.changedFrom
      ? `${escapeHtml(who)} changed the decision on your approval request${forWhom}: ${verdictWord}`
      : `${escapeHtml(who)} decided your approval request${forWhom}: ${verdictWord}`);
  const verb = ctx.changedFrom ? `changed the decision to ${verdict.toLowerCase()} on` : (approved ? 'approved' : 'rejected');
  const rows = [];
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${tone.color};">${escapeHtml(`${verdict}${ctx.changedFrom ? ' (changed)' : ''}`)}</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || 'Ticket')}</td></tr>`);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(t.ref || '')}</td></tr>`);
  rows.push(spacer(16));
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${sentence}</td></tr>`);
  if (ctx.conditionNote) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel('Condition')}<div style="font-size:14px;line-height:20px;color:#7c2d12;">${escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>')}</div>`, { bg: '#fff7ed', border: '#fdba74' })}</td></tr>`);
  }
  if (ctx.note) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel(ctx.isSelf ? 'Your note' : `Note from ${ctx.approverName || 'the approver'}`)}${escapeHtml(ctx.note).replace(/\r?\n/g, '<br>')}`)}</td></tr>`);
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
    statusPill: pill(verdict, tone),
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
  let sentence;
  if (ctx.kind === 'forwarded') sentence = `<b>${by}</b> forwarded your approval request${forWhom} to <b>${escapeHtml(who)}</b>, who will make the final decision.`;
  else if (ctx.kind === 'auto') sentence = `<b>${by}</b> approved your request${forWhom} at ${escapeHtml(ctx.fromTierName || 'Tier 1')}. The amount is above that tier's limit, so it has moved on to <b>${escapeHtml(who)}</b> (${escapeHtml(ctx.toTierName || 'next tier')}) for the final approval.`;
  else sentence = `<b>${by}</b> escalated your approval request${forWhom} to <b>${escapeHtml(who)}</b> (${escapeHtml(ctx.toTierName || 'next tier')}).`;
  const rows = [];
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">Approval ${ctx.kind === 'forwarded' ? 'forwarded' : 'escalated'}</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || '(no subject)')}</td></tr>`);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(t.ref || '')}</td></tr>`);
  rows.push(spacer(16));
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${sentence}</td></tr>`);
  rows.push(spacer(18));
  if (t.appUrl) rows.push(`<tr><td>${button('Open the ticket', t.appUrl, { bg: '#334155' })}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Nothing is needed from you — you will get another e-mail when the decision is made.</td></tr>`);
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    statusPill: pill(ctx.kind === 'forwarded' ? 'Forwarded' : 'Escalated', TONES.amber),
    bodyRows: rows,
    footerHtml: `Sent by Ticket Pulse${ctx.workspaceName ? ` · ${escapeHtml(ctx.workspaceName)} workspace` : ''}. The full approval trail is on the ticket.`,
    preheader: `${ctx.byName || 'The approver'} ${ctx.kind === 'forwarded' ? 'forwarded' : 'escalated'} your approval request on ${t.ref || 'the ticket'} to ${who}`,
  });
}

/**
 * Requester (the agent): the approver asked a question. ctx:
 *  { workspaceName, ticket:{ref, subject, appUrl}, approverName, question, requester:{name} }
 */
export function renderRequesterClarificationEmail(ctx) {
  const t = ctx.ticket || {};
  const rows = [];
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:#5b21b6;">Question from the approver</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || 'Ticket')}</td></tr>`);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(t.ref || '')}</td></tr>`);
  rows.push(spacer(16));
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};"><b>${escapeHtml(ctx.approverName || 'The approver')}</b> needs more information before deciding${ctx.requester?.name ? ` the request for <b>${escapeHtml(ctx.requester.name)}</b>` : ''}.</td></tr>`);
  rows.push(spacer(12));
  rows.push(`<tr><td>${card(`${sectionLabel('Their question')}<div style="font-size:15px;line-height:22px;">${escapeHtml(ctx.question || '')}</div>`, { bg: '#f5f3ff', border: '#ddd6fe' })}</td></tr>`);
  rows.push(spacer(18));
  if (t.appUrl) rows.push(`<tr><td>${button('Answer on the ticket', t.appUrl, { bg: '#7c3aed' })}</td></tr>`);
  rows.push(`<tr><td style="padding-top:10px;font-family:${FONT};font-size:13px;line-height:19px;color:${MUTED};">Your answer goes back to ${escapeHtml(ctx.approverName || 'the approver')} by e-mail and the approval link re-opens for them.</td></tr>`);
  rows.push(spacer(8));
  return emailShell({
    workspaceName: ctx.workspaceName,
    statusPill: pill('Needs your answer', TONES.violet),
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
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">${escapeHtml(kicker)}${ctx.categoryName ? ` · ${escapeHtml(ctx.categoryName)}` : ''}</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || '(no subject)')}</td></tr>`);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(t.ref || '')}</td></tr>`);
  rows.push(spacer(16));
  const lead = ctx.kind === 'answer'
    ? `<b>${by}</b> answered${ctx.recipient?.name ? ` your question` : ''}:`
    : ctx.kind === 'comment'
      ? `<b>${by}</b> left a note${ctx.isCc ? ' (you are copied)' : ' for you'}:`
      : `<b>${by}</b> has a question${ctx.isCc ? ' (you are copied)' : ' for you'}:`;
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${lead}</td></tr>`);
  rows.push(spacer(10));
  const body = ctx.bodyHtml ? (normalizeNoteHtmlForEmail(ctx.bodyHtml) || ctx.bodyHtml) : escapeHtml(ctx.bodyText || '').replace(/\n/g, '<br>');
  rows.push(`<tr><td>${card(`<div style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${body}</div>`)}</td></tr>`);
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
    statusPill: pill(ctx.kind === 'answer' ? 'Answer' : ctx.kind === 'comment' ? 'Note' : 'Question', ctx.kind === 'answer' ? TONES.green : TONES.violet),
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
  const verdict = approved ? (ctx.conditionNote ? 'Approved with condition' : 'Approved') : 'Rejected';
  const tone = approved ? TONES.green : TONES.red;
  const rows = [];
  rows.push(`<tr><td style="font-family:${FONT};font-size:12px;line-height:16px;font-weight:bold;letter-spacing:0.6px;text-transform:uppercase;color:${MUTED};">${escapeHtml(ctx.categoryName ? `${ctx.categoryName} approval` : 'Approval')} · ${escapeHtml(verdict)}</td></tr>`);
  rows.push(`<tr><td style="padding-top:6px;font-family:${FONT};font-size:22px;line-height:28px;font-weight:bold;color:${INK};">${escapeHtml(t.subject || '(no subject)')}</td></tr>`);
  rows.push(`<tr><td style="padding-top:4px;font-family:Consolas,'Courier New',monospace;font-size:12.5px;line-height:18px;color:${MUTED};">${escapeHtml(t.ref || '')}</td></tr>`);
  rows.push(spacer(16));
  const greet = ctx.recipient?.name ? `Hi ${escapeHtml(String(ctx.recipient.name).split(' ')[0])},` : 'Hello,';
  const forWhom = ctx.requester?.name && ctx.recipient?.role !== 'requester' ? ` for ${escapeHtml(ctx.requester.name)}` : '';
  rows.push(`<tr><td style="font-family:${FONT};font-size:15px;line-height:22px;color:${INK};">${greet}<br><br><b>${escapeHtml(ctx.approverName || 'The approver')}</b> has <span style="color:${tone.color};font-weight:bold;">${escapeHtml(verdict.toLowerCase())}</span> the request${forWhom}${ctx.changedFrom ? ` (changed from ${escapeHtml(ctx.changedFrom)})` : ''}.</td></tr>`);
  if (ctx.conditionNote) {
    rows.push(spacer(12));
    rows.push(`<tr><td>${card(`${sectionLabel('Condition')}<div style="font-size:15px;line-height:22px;color:#7c2d12;">${escapeHtml(ctx.conditionNote).replace(/\n/g, '<br>')}</div>`, { bg: '#fff7ed', border: '#fdba74' })}</td></tr>`);
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
    statusPill: pill(verdict, tone),
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
