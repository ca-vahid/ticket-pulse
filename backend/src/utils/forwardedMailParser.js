/**
 * Forwarded-mail parser (Mega 09-01 Phase FW-1). Zero dependencies.
 *
 * Detects a forwarded (or quoted) message at the TOP of an email body and
 * slices it into the forwarder's note and the original message, keeping the
 * original's HTML formatting. Two passes:
 *
 *   • TEXT pass — the body (HTML flattened to text) is scanned in its first
 *     ~40 non-empty lines for a header block: a `From:` line with a
 *     `Sent:`/`Date:` line within the next 6 lines (labels in en/de/fr/es),
 *     or an explicit client marker (Gmail `---------- Forwarded message
 *     ---------`, Apple `Begin forwarded message:`, OWA underscore rule). The
 *     block yields the original's name/email/date/subject/to/cc.
 *   • HTML pass — slices the raw HTML at the client's own quote container
 *     (`#divRplyFwdMsg` / `#appendonsend` / OWA `<hr style="display:inline-
 *     block;width:98%">` / classic Outlook `border-top:solid #E1E1E1 1.0pt`
 *     + `<b>From:</b>` / `.gmail_quote` / Apple `<blockquote type="cite">`).
 *
 * `isForward` is TRUE when a header block (or explicit marker) sits at the top
 * of the body AND nothing says it is a quoted REPLY instead: an explicit
 * forward marker or a forward subject prefix (FW/Fwd/WG/TR/RV/Enc…) makes it a
 * forward; a reply subject prefix (RE/AW/SV/Antw…) with a plain Outlook header
 * block is a quoted reply (`hasHeaderBlock` stays true so callers can still
 * use the quoted `From:`). The subject prefix is corroborating only — it never
 * makes a body without a header block a forward.
 *
 * Nested chains: only the TOP block is parsed; `segments` is reserved for the
 * P2 splitter (flag MAILBOX_FORWARD_SPLIT) and is always [] in v1.
 *
 * Fixture structure adapted from email-forward-parser (MIT, © Crisp IM) —
 * see backend/tests/fixtures/forwards/README.md.
 */

export const PARSER_VERSION = 'v1';

const FORWARD_PREFIX_RE = /^\s*(?:\[[^\]]{1,40}\]\s*)?(fw|fwd|wg|tr|rv|enc|vs|vb|doorst|ilt)\s*:/i;
const REPLY_PREFIX_RE = /^\s*(?:\[[^\]]{1,40}\]\s*)?(re|aw|sv|antw|antwort|r|odp|ynt)\s*:/i;
// Any leading chain of reply/forward prefixes ("FW: RE: AW: subject").
const PREFIX_CHAIN_RE = /^(?:\s*(?:\[[^\]]{1,40}\]\s*)?(?:re|aw|sv|antw|antwort|fw|fwd|wg|tr|rv|enc|vs|vb|doorst|ilt|r|odp|ynt)\s*:\s*)+/i;

// Header labels (en / de / fr / es), matched case-insensitively at line start.
const LABELS = {
  from: ['from', 'von', 'de', 'expéditeur', 'remitente'],
  date: ['sent', 'date', 'gesendet', 'datum', 'envoyé', 'envoye', 'enviado', 'enviado el', 'fecha'],
  to: ['to', 'an', 'à', 'a', 'para', 'destinataire'],
  cc: ['cc', 'kopie', 'copie à', 'copie a', 'copia', 'cc :'],
  subject: ['subject', 'betreff', 'objet', 'asunto', 'sujet'],
};
const ALL_LABELS = Object.entries(LABELS).flatMap(([key, names]) => names.map((n) => ({ key, name: n })))
  .sort((a, b) => b.name.length - a.name.length);
const LABEL_LINE_RE = new RegExp(
  `^\\s*\\*?\\*?(${ALL_LABELS.map((l) => escapeRe(l.name)).join('|')})\\*?\\*?\\s*:\\s*(.*)$`,
  'i',
);

const GMAIL_MARKER_RE = /^\s*-{2,}\s*(forwarded message|weitergeleitete nachricht|message transféré|message transfere|mensaje reenviado)\s*-{2,}\s*$/i;
const APPLE_MARKER_RE = /^\s*(begin forwarded message|anfang der weitergeleiteten (?:nachricht|e-mail)|début du message réexpédié|debut du message reexpedie|inicio del mensaje reenviado)\s*:?\s*$/i;
const OWA_RULE_RE = /^\s*_{10,}\s*$/;

const EMAIL_RE = /[A-Z0-9._%+'-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const HEAD_LINES = 40;
const DATE_WINDOW = 6;

const WEEKDAYS = /^(monday|tuesday|wednesday|thursday|friday|saturday|sunday|mon|tue|wed|thu|fri|sat|sun|montag|dienstag|mittwoch|donnerstag|freitag|samstag|sonntag|mo|di|mi|do|fr|sa|so|lundi|mardi|mercredi|jeudi|vendredi|samedi|dimanche|lun|mar|mer|jeu|ven|sam|dim|lunes|martes|miércoles|miercoles|jueves|viernes|sábado|sabado|domingo|mié|jue|vie|sáb|dom)\.?,?\s+/i;
const MONTHS = {
  januar: 'January', jänner: 'January', janvier: 'January', enero: 'January', jan: 'Jan',
  februar: 'February', février: 'February', fevrier: 'February', febrero: 'February', feb: 'Feb', févr: 'Feb',
  märz: 'March', maerz: 'March', mars: 'March', marzo: 'March', mär: 'Mar',
  april: 'April', avril: 'April', abril: 'April', apr: 'Apr', avr: 'Apr',
  mai: 'May', mayo: 'May',
  juni: 'June', juin: 'June', junio: 'June', jun: 'Jun',
  juli: 'July', juillet: 'July', julio: 'July', jul: 'Jul', juil: 'Jul',
  august: 'August', août: 'August', aout: 'August', agosto: 'August', aug: 'Aug',
  september: 'September', septembre: 'September', septiembre: 'September', sep: 'Sep', sept: 'Sep',
  oktober: 'October', octobre: 'October', octubre: 'October', okt: 'Oct', oct: 'Oct',
  november: 'November', novembre: 'November', noviembre: 'November', nov: 'Nov',
  dezember: 'December', décembre: 'December', decembre: 'December', diciembre: 'December', dez: 'Dec', déc: 'Dec', dic: 'Dec',
};

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* ------------------------------------------------------------------------ */
/* HTML → text                                                              */
/* ------------------------------------------------------------------------ */

const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', '#39': "'", '#160': ' ',
  eacute: 'é', egrave: 'è', agrave: 'à', auml: 'ä', ouml: 'ö', uuml: 'ü', szlig: 'ß', ccedil: 'ç', ntilde: 'ñ',
};

export function decodeEntities(s) {
  return String(s || '').replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, code) => {
    const lower = code.toLowerCase();
    if (ENTITIES[lower] !== undefined) return ENTITIES[lower];
    if (lower.startsWith('#x')) return safeChar(parseInt(lower.slice(2), 16), m);
    if (lower.startsWith('#')) return safeChar(parseInt(lower.slice(1), 10), m);
    return m;
  });
}

function safeChar(cp, fallback) {
  if (!Number.isFinite(cp) || cp < 9 || cp > 0x10ffff) return fallback;
  try { return String.fromCodePoint(cp); } catch { return fallback; }
}

/**
 * Flatten HTML to plain text lines: block closers and <br> become newlines,
 * tags are stripped, entities decoded, whitespace collapsed per line. Head/
 * style/script content is dropped.
 */
export function htmlToText(html) {
  if (!html) return '';
  let s = String(html);
  s = s.replace(/<!--[\s\S]*?-->/g, '');
  s = s.replace(/<(script|style|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, '');
  // A <br> followed by a source newline is ONE line break, not two.
  s = s.replace(/<br\s*\/?>[ \t]*\r?\n?/gi, '\n');
  s = s.replace(/<\/(p|div|tr|li|h[1-6]|blockquote|table|pre|section|article|header|footer)\s*>/gi, '\n');
  s = s.replace(/<(p|div|tr|li|h[1-6]|blockquote|table|pre|hr)\b[^>]*>/gi, '\n');
  s = s.replace(/<td\b[^>]*>/gi, ' ');
  s = s.replace(/<[^>]+>/g, '');
  s = decodeEntities(s);
  s = s.replace(new RegExp(String.fromCharCode(160), 'g'), ' ').replace(/\r\n?/g, '\n');
  return s.split('\n').map((l) => l.replace(/[ \t\f\v]+/g, ' ').trim()).join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Minimal text → HTML for text-only forwards (paragraph per blank line). */
export function textToHtml(text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return String(text || '')
    .replace(/\r\n?/g, '\n')
    .split(/\n{2,}/)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');
}

/* ------------------------------------------------------------------------ */
/* Address / date parsing                                                   */
/* ------------------------------------------------------------------------ */

/**
 * `Name <addr>`, `"Name" <addr>`, `Name [mailto:addr]`, `addr (Name)`, bare
 * `addr`, Outlook `Name <mailto:addr>` and `Name (addr)` → {name, email}.
 */
export function parseAddress(raw) {
  const s = decodeEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!s) return { name: null, email: null };
  const angled = s.match(/^(.*?)\s*[<[(]\s*(?:mailto:)?\s*([^<>[\]()\s]+@[^<>[\]()\s]+)\s*[>\])]\s*(.*)$/i);
  if (angled) {
    const email = angled[2].toLowerCase();
    const name = clean(angled[1] || angled[3]);
    return { name: name && name.toLowerCase() !== email ? name : null, email: EMAIL_RE.test(email) ? email : null };
  }
  const bare = s.match(EMAIL_RE);
  if (bare) {
    const email = bare[0].toLowerCase();
    const name = clean(s.replace(bare[0], ''));
    return { name: name || null, email };
  }
  return { name: clean(s) || null, email: null };
}

function clean(name) {
  return String(name || '')
    .replace(/^mailto:/i, '')
    .replace(/^[\s"'“”(]+|[\s"'“”,;:)]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

export function parseAddressList(raw) {
  const s = decodeEntities(String(raw || ''));
  if (!s.trim()) return [];
  // Split on ; or , outside of <>/[]/() and quotes.
  const parts = [];
  let depth = 0; let quote = false; let cur = '';
  for (const ch of s) {
    if (ch === '"') quote = !quote;
    if (!quote && (ch === '<' || ch === '[' || ch === '(')) depth += 1;
    if (!quote && (ch === '>' || ch === ']' || ch === ')')) depth = Math.max(0, depth - 1);
    if (!quote && depth === 0 && (ch === ';' || ch === ',')) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(parseAddress).filter((a) => a.email || a.name);
}

/**
 * Best-effort header date → Date (or null). Handles Outlook (`Monday,
 * September 1, 2026 9:41 AM`), Gmail (`Mon, Sep 1, 2026 at 9:41 AM`), Apple
 * (`September 1, 2026 at 9:41:12 AM PDT`), German (`Montag, 1. September 2026
 * 09:41`), French (`lundi 1 septembre 2026 09:41`), Spanish (`lunes, 1 de
 * septiembre de 2026 9:41`) and RFC 2822 (`Tue, 2 Sep 2026 07:15:03 -0700`).
 */
export function parseHeaderDate(raw) {
  let s = decodeEntities(String(raw || '')).replace(/\s+/g, ' ').trim();
  if (!s) return null;
  s = s.replace(WEEKDAYS, '');
  s = s.replace(/\b(at|um|à|a las|a la|às|om)\b\s+/gi, '');
  s = s.replace(/\b(de|del|der|des|du)\b\s+/gi, ' ');
  s = s.replace(/(\d{1,2})\.\s*(?=[A-Za-zÀ-ÿ])/g, '$1 '); // "1. September" → "1 September"
  s = s.replace(/(\d{1,2})\s+(\d{1,2})\s+(\d{4})/, (m, d, mo, y) => `${y}-${pad(mo)}-${pad(d)}`); // "01 09 2026"
  s = s.replace(/(\d{1,2})[./](\d{1,2})[./](\d{4})/, (m, d, mo, y) => `${y}-${pad(mo)}-${pad(d)}`); // "01.09.2026"
  s = s.replace(/[A-Za-zÀ-ÿ]+\.?/g, (word) => {
    const key = word.replace(/\.$/, '').toLowerCase();
    return MONTHS[key] || word;
  });
  s = s.replace(/\s+/g, ' ').trim();
  let d = new Date(s);
  if (Number.isNaN(d.getTime())) {
    // Drop a trailing zone token we can't read ("MESZ", "CEST", "(UTC-07:00)…").
    const stripped = s.replace(/\s*\([^)]*\)\s*$/, '').replace(/\s+[A-Z]{2,5}\s*$/, '').trim();
    d = new Date(stripped);
  }
  if (Number.isNaN(d.getTime())) {
    const iso = s.match(/(\d{4}-\d{2}-\d{2})\s+(\d{1,2}:\d{2}(?::\d{2})?)/);
    if (iso) d = new Date(`${iso[1]}T${iso[2].length === 5 ? `${iso[2]}:00` : iso[2]}`);
  }
  return Number.isNaN(d.getTime()) ? null : d;
}

function pad(n) { return String(n).padStart(2, '0'); }

/* ------------------------------------------------------------------------ */
/* Subject prefix                                                           */
/* ------------------------------------------------------------------------ */

/** {kind:'forward'|'reply'|null, prefix} for the FIRST prefix on the subject. */
export function subjectPrefix(subject) {
  const s = String(subject || '');
  const fw = s.match(FORWARD_PREFIX_RE);
  if (fw) return { kind: 'forward', prefix: fw[1].toUpperCase() };
  const re = s.match(REPLY_PREFIX_RE);
  if (re) return { kind: 'reply', prefix: re[1].toUpperCase() };
  return { kind: null, prefix: null };
}

/** Subject with every leading RE:/FW:/AW:/WG:… prefix removed. */
export function stripSubjectPrefixes(subject) {
  return String(subject || '').replace(PREFIX_CHAIN_RE, '').trim();
}

/* ------------------------------------------------------------------------ */
/* Text pass                                                                */
/* ------------------------------------------------------------------------ */

/**
 * Scan the top of the text for a header block. Returns null or
 * { marker, startLine, endLine, headers:{from,date,to,cc,subject} }.
 * `startLine` is the marker line (or the From line), `endLine` the last
 * header line — the original body starts after it.
 */
export function findHeaderBlock(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  let seenNonEmpty = 0;
  let marker = null;
  let markerLine = -1;
  for (let i = 0; i < lines.length && seenNonEmpty < HEAD_LINES; i += 1) {
    const line = lines[i];
    if (!line.trim()) continue;
    seenNonEmpty += 1;
    if (!marker) {
      if (GMAIL_MARKER_RE.test(line)) { marker = 'gmail'; markerLine = i; continue; }
      if (APPLE_MARKER_RE.test(line)) { marker = 'apple'; markerLine = i; continue; }
      if (OWA_RULE_RE.test(line)) { marker = 'owa'; markerLine = i; continue; }
    }
    const m = line.match(LABEL_LINE_RE);
    if (!m) continue;
    const key = labelKey(m[1]);
    if (key !== 'from') continue;
    // A From line only counts when a Sent/Date line follows within the window
    // (signatures and prose that mention "From:" never have one).
    const block = collectHeaders(lines, i);
    if (!block.headers.date) continue;
    const fromAddr = parseAddress(block.headers.from);
    if (!fromAddr.email && !fromAddr.name) continue;
    return {
      marker: marker && markerLine < i ? marker : (marker || null),
      startLine: marker && markerLine < i ? markerLine : i,
      endLine: block.endLine,
      headers: block.headers,
      from: fromAddr,
    };
  }
  // An explicit forward marker with a header block that carries no date
  // (rare Gmail plain-text variants) still counts when From is valid.
  if (marker && marker !== 'owa') {
    for (let i = markerLine + 1; i < Math.min(lines.length, markerLine + 12); i += 1) {
      const m = lines[i].match(LABEL_LINE_RE);
      if (!m || labelKey(m[1]) !== 'from') continue;
      const block = collectHeaders(lines, i);
      const fromAddr = parseAddress(block.headers.from);
      if (!fromAddr.email) break;
      return { marker, startLine: markerLine, endLine: block.endLine, headers: block.headers, from: fromAddr };
    }
  }
  return null;
}

function labelKey(label) {
  const lower = label.toLowerCase().replace(/\s*:$/, '').trim();
  const hit = ALL_LABELS.find((l) => l.name === lower);
  return hit ? hit.key : null;
}

/**
 * Collect the `Label: value` lines of one header block starting at `start`.
 * Blank lines inside the block are tolerated (HTML flattening and new
 * Outlook for Mac both insert them); wrapped To/Cc lists continue onto the
 * next line; a repeated label means a second (nested) block begins; the
 * first prose line after the date ends the block.
 */
function collectHeaders(lines, start) {
  const headers = { from: null, date: null, to: null, cc: null, subject: null };
  let endLine = start;
  let lastKey = null;
  let nonLabelSinceFrom = 0;
  let blankRun = 0;
  for (let j = start; j < lines.length; j += 1) {
    const line = lines[j];
    if (!line.trim()) {
      blankRun += 1;
      if (blankRun > 3) break;
      continue;
    }
    blankRun = 0;
    const m = line.match(LABEL_LINE_RE);
    if (m) {
      const key = labelKey(m[1]);
      if (key) {
        if (headers[key] !== null) break; // a repeated label → nested block
        headers[key] = m[2].trim();
        lastKey = key;
        endLine = j;
        continue;
      }
    }
    const continuation = lastKey && (lastKey === 'to' || lastKey === 'cc' || lastKey === 'from')
      && (line.includes('@') || line.includes(';'));
    if (continuation) {
      headers[lastKey] = `${headers[lastKey]} ${line.trim()}`;
      endLine = j;
      continue;
    }
    if (!headers.date) {
      nonLabelSinceFrom += 1;
      if (nonLabelSinceFrom > DATE_WINDOW) break;
      continue;
    }
    break; // prose after the block → the original body starts here
  }
  return { headers, endLine };
}

/* ------------------------------------------------------------------------ */
/* HTML pass                                                                */
/* ------------------------------------------------------------------------ */

/** Index just past the closing tag of the element whose opening tag starts at `open`. */
export function findElementEnd(html, open) {
  const tagMatch = html.slice(open).match(/^<([a-z][a-z0-9]*)/i);
  if (!tagMatch) return -1;
  const tag = tagMatch[1].toLowerCase();
  const re = new RegExp(`<\\/?${tag}\\b[^>]*>`, 'gi');
  re.lastIndex = open;
  let depth = 0;
  let m;
  while ((m = re.exec(html))) {
    const isClose = m[0][1] === '/';
    const selfClosing = /\/\s*>$/.test(m[0]);
    if (!isClose && !selfClosing) depth += 1;
    else if (isClose) {
      depth -= 1;
      if (depth === 0) return m.index + m[0].length;
    }
  }
  return -1;
}

function tagStartBefore(html, idx) {
  const lt = html.lastIndexOf('<', idx);
  return lt >= 0 ? lt : idx;
}

/**
 * Slice the HTML at the client's quote container. Returns null or
 * { client, noteHtml, headerHtml, originalHtml }.
 */
export function sliceHtml(html) {
  if (!html) return null;
  const s = String(html);

  // OWA / new Outlook / Outlook mobile: <div id="divRplyFwdMsg"> holds the
  // header block; the original body follows it as siblings (or inside
  // #mail-editor-reference-message-container on mobile).
  let idx = s.search(/<div\b[^>]*\bid=["']?divRplyFwdMsg["']?/i);
  if (idx >= 0) {
    const headerEnd = findElementEnd(s, idx);
    const container = s.search(/<div\b[^>]*\bid=["']?mail-editor-reference-message-container["']?/i);
    const hr = s.lastIndexOf('<hr', idx);
    const append = s.search(/<div\b[^>]*\bid=["']?appendonsend["']?/i);
    let cut = idx;
    if (hr >= 0 && hr > idx - 400) cut = hr;
    if (append >= 0 && append < idx) cut = Math.min(cut, append);
    if (container >= 0 && container < idx) cut = Math.min(cut, container);
    const client = container >= 0 ? 'outlook_mobile' : 'outlook_owa';
    return {
      client,
      noteHtml: s.slice(0, cut),
      headerHtml: s.slice(idx, headerEnd > 0 ? headerEnd : idx),
      originalHtml: headerEnd > 0 ? trimContainerTail(s.slice(headerEnd), container >= 0) : '',
    };
  }

  // Classic Outlook desktop (Win): header block in a div with the E1E1E1
  // top border, body follows as siblings.
  idx = s.search(/<div\b[^>]*style=["'][^"']*border-top:\s*solid\s*#E1E1E1\s*1\.0pt[^"']*["'][^>]*>/i);
  if (idx >= 0 && /<b>\s*(from|von|de|expéditeur|remitente)\s*:?\s*<\/b>/i.test(s.slice(idx, idx + 600))) {
    const headerEnd = findElementEnd(s, idx);
    return {
      client: 'outlook_classic',
      noteHtml: s.slice(0, idx),
      headerHtml: s.slice(idx, headerEnd > 0 ? headerEnd : idx),
      originalHtml: headerEnd > 0 ? s.slice(headerEnd) : '',
    };
  }

  // Gmail: <div class="gmail_quote"><div class="gmail_attr">header</div> original</div>
  idx = s.search(/<div\b[^>]*class=["'][^"']*\bgmail_quote\b[^"']*["'][^>]*>/i);
  if (idx >= 0) {
    const quoteEnd = findElementEnd(s, idx);
    const inner = s.slice(idx, quoteEnd > 0 ? quoteEnd : s.length);
    const attr = inner.search(/<div\b[^>]*class=["'][^"']*\bgmail_attr\b[^"']*["'][^>]*>/i);
    let headerHtml = '';
    let original = inner;
    if (attr >= 0) {
      const attrEnd = findElementEnd(inner, attr);
      headerHtml = inner.slice(attr, attrEnd > 0 ? attrEnd : attr);
      original = attrEnd > 0 ? inner.slice(attrEnd) : inner;
    } else {
      original = inner.replace(/^<div\b[^>]*>/i, '');
    }
    return {
      client: 'gmail',
      noteHtml: s.slice(0, idx),
      headerHtml,
      originalHtml: stripOuterWrapper(original),
    };
  }

  // Apple Mail: "Begin forwarded message:" then <blockquote type="cite">
  // whose first div is the header block.
  idx = s.search(/<blockquote\b[^>]*type=["']?cite["']?[^>]*>/i);
  if (idx >= 0 && /begin forwarded message|anfang der weitergeleiteten|début du message réexpédié|inicio del mensaje reenviado/i.test(htmlToText(s.slice(0, idx)))) {
    const bqEnd = findElementEnd(s, idx);
    const inner = s.slice(idx, bqEnd > 0 ? bqEnd : s.length).replace(/^<blockquote\b[^>]*>/i, '').replace(/<\/blockquote>\s*$/i, '');
    // Apple puts EACH header line in its own leading <div>; consume them
    // while they read as `Label:` lines, the rest is the original body.
    let cursor = 0;
    let headerHtml = '';
    for (;;) {
      const rest = inner.slice(cursor);
      const lead = rest.match(/^\s*(?:<br\s*\/?>\s*)*/i);
      const divAt = cursor + (lead ? lead[0].length : 0);
      if (!/^<div\b/i.test(inner.slice(divAt))) break;
      const divEnd = findElementEnd(inner, divAt);
      if (divEnd < 0) break;
      const divText = htmlToText(inner.slice(divAt, divEnd)).trim();
      if (!LABEL_LINE_RE.test(divText.split('\n')[0] || '')) break;
      headerHtml += inner.slice(divAt, divEnd);
      cursor = divEnd;
    }
    const original = headerHtml ? inner.slice(cursor) : inner;
    const markerIdx = s.slice(0, idx).search(/begin forwarded message|anfang der weitergeleiteten|début du message réexpédié|inicio del mensaje reenviado/i);
    return {
      client: 'apple_mail',
      noteHtml: s.slice(0, markerIdx >= 0 ? tagStartBefore(s, markerIdx) : idx),
      headerHtml,
      originalHtml: stripOuterWrapper(original),
    };
  }

  // OWA underscore rule without divRplyFwdMsg (plain-ish OWA / some mobile
  // builds): <hr style="display:inline-block;width:98%"> then the header.
  idx = s.search(/<hr\b[^>]*style=["'][^"']*display:\s*inline-block;\s*width:\s*98%[^"']*["'][^>]*>/i);
  if (idx >= 0) {
    const after = s.slice(idx);
    const fromIdx = after.search(/<b>\s*(from|von|de|expéditeur|remitente)\s*:?\s*<\/b>/i);
    if (fromIdx >= 0) {
      const hdrStart = idx + tagStartBefore(after, fromIdx);
      const wrapper = s.lastIndexOf('<div', hdrStart);
      const headerEnd = wrapper > idx ? findElementEnd(s, wrapper) : -1;
      return {
        client: 'outlook_owa',
        noteHtml: s.slice(0, idx),
        headerHtml: headerEnd > 0 ? s.slice(wrapper, headerEnd) : '',
        originalHtml: headerEnd > 0 ? s.slice(headerEnd) : after,
      };
    }
  }

  return null;
}

/** Drop the trailing `</div></div>` that closed the mobile reference container. */
function trimContainerTail(slice, inContainer) {
  if (!inContainer) return slice;
  return slice.replace(/(?:\s*<\/div>){1,2}\s*(<\/body>\s*<\/html>\s*)?$/i, '$1');
}

function stripOuterWrapper(html) {
  return String(html).replace(/^\s*(<br\s*\/?>\s*)+/i, '');
}

/* ------------------------------------------------------------------------ */
/* Entry point                                                              */
/* ------------------------------------------------------------------------ */

/**
 * @param {{ html?: string|null, text?: string|null, subject?: string|null }} input
 * @returns {{
 *   isForward: boolean, hasHeaderBlock: boolean, client: string|null,
 *   subjectPrefix: {kind:string|null, prefix:string|null}, marker: string|null,
 *   original: { name: string|null, email: string|null, date: Date|null, dateRaw: string|null,
 *               subject: string|null, to: Array<{name,email}>, cc: Array<{name,email}> },
 *   originalHtml: string|null, originalText: string|null,
 *   noteHtml: string|null, noteText: string|null, segments: Array
 * }}
 */
export function parseForwardedMail({ html = null, text = null, subject = null } = {}) {
  const prefix = subjectPrefix(subject);
  const empty = {
    isForward: false,
    hasHeaderBlock: false,
    client: null,
    marker: null,
    subjectPrefix: prefix,
    original: { name: null, email: null, date: null, dateRaw: null, subject: null, to: [], cc: [] },
    originalHtml: null,
    originalText: null,
    noteHtml: null,
    noteText: null,
    segments: [],
  };

  const flatText = text && String(text).trim() ? String(text) : htmlToText(html);
  if (!flatText.trim()) return empty;

  const block = findHeaderBlock(flatText);
  if (!block) return empty;

  const lines = flatText.replace(/\r\n?/g, '\n').split('\n');
  const noteText = lines.slice(0, block.startLine).join('\n').trim();
  const originalText = lines.slice(block.endLine + 1).join('\n').replace(/^\n+/, '').trim();

  const sliced = html ? sliceHtml(html) : null;
  const client = sliced?.client
    || (block.marker === 'gmail' ? 'gmail' : block.marker === 'apple' ? 'apple_mail' : block.marker === 'owa' ? 'outlook_owa' : (html ? 'unknown' : 'text'));

  const explicitForward = block.marker === 'gmail' || block.marker === 'apple';
  const isForward = explicitForward || prefix.kind === 'forward' || prefix.kind === null;

  const original = {
    name: block.from.name,
    email: block.from.email,
    date: parseHeaderDate(block.headers.date),
    dateRaw: block.headers.date || null,
    subject: block.headers.subject ? decodeEntities(block.headers.subject).trim() : null,
    to: parseAddressList(block.headers.to),
    cc: parseAddressList(block.headers.cc),
  };

  return {
    isForward,
    hasHeaderBlock: true,
    client,
    marker: block.marker,
    subjectPrefix: prefix,
    original,
    originalHtml: sliced ? (sliced.originalHtml || null) : null,
    originalText: originalText || null,
    noteHtml: sliced ? (sliced.noteHtml && htmlToText(sliced.noteHtml).trim() ? sliced.noteHtml : null) : null,
    noteText: noteText || null,
    segments: [],
  };
}

export default parseForwardedMail;
