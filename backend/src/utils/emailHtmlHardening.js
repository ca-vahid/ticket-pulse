/**
 * E-mail HTML hardening for the mail clients that ignore modern CSS.
 *
 * Classic desktop Outlook renders HTML with the Word engine: `padding` and
 * `border-radius` on an `<a>` are dropped, so a "button" written as a padded
 * anchor arrives as a tight blue background hugging the text (QA 09-22 #3,
 * Alvina's "Open Ticket Pulse"). The bulletproof shape is a table cell that
 * carries the colour and the padding; the anchor inside carries only the text.
 * Every workflow template goes through this at send time, so an author can
 * keep writing the simple anchor.
 */

const STYLE_PROP = (style, name) => {
  const re = new RegExp(`(?:^|;)\\s*${name}\\s*:\\s*([^;]+)`, 'i');
  const m = re.exec(style);
  return m ? m[1].replace(/!important/gi, '').trim() : null;
};

// style="…" or style='…' (some authoring tools emit single quotes).
const ANCHOR_RE = /<a\b([^>]*?)\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')([^>]*)>([\s\S]*?)<\/a>/gi;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Rewrites every anchor whose inline style carries BOTH a background and a
 * padding into a table-cell button. Anchors that are plain links, or already
 * sit inside a bulletproof cell (the colour lives on the cell, so the anchor has
 * padding but no background), are left alone, which also makes the transform
 * idempotent.
 */
export function bulletproofButtons(html) {
  const input = String(html || '');
  if (!input || !/<a\b/i.test(input)) return input;
  return input.replace(ANCHOR_RE, (whole, before, dq, sq, after, inner) => {
    const style = dq ?? sq ?? '';
    const background = STYLE_PROP(style, 'background-color') || STYLE_PROP(style, 'background');
    const padding = STYLE_PROP(style, 'padding');
    if (!background || !padding) return whole;
    if (/<(table|td|img|div)\b/i.test(inner)) return whole;
    const bg = background.split(/\s+/)[0];
    const radius = STYLE_PROP(style, 'border-radius');
    const color = STYLE_PROP(style, 'color') || '#ffffff';
    const fontFamily = STYLE_PROP(style, 'font-family') || 'Arial, Helvetica, sans-serif';
    const fontWeight = STYLE_PROP(style, 'font-weight');
    const fontSize = STYLE_PROP(style, 'font-size');
    const attrs = `${before} ${after}`.replace(/\s+/g, ' ').trim();
    // Non-Outlook clients: the anchor carries the padding (and radius), so the
    // whole coloured area is clickable. Outlook's Word engine ignores padding on
    // an <a>, so the cell carries it there via mso-padding-alt; `padding:0` for
    // everyone else avoids doubling it. (mso-padding-alt:0 was the QA 09-28 bug:
    // it cancelled the cell padding in Outlook and the colour hugged the text.)
    const anchorStyle = [
      'display:inline-block',
      `padding:${padding}`,
      `color:${color}`,
      'text-decoration:none',
      radius ? `border-radius:${radius}` : null,
      `font-family:${fontFamily}`,
      fontWeight ? `font-weight:${fontWeight}` : null,
      fontSize ? `font-size:${fontSize}` : null,
      'line-height:1.2',
    ].filter(Boolean).join(';');
    const cellStyle = [
      `background-color:${bg}`,
      radius ? `border-radius:${radius}` : null,
      'padding:0',
      `mso-padding-alt:${padding}`,
      'text-align:center',
    ].filter(Boolean).join(';');
    return '<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="border-collapse:separate;">'
      + `<tr><td align="center" bgcolor="${escapeAttr(bg)}" style="${escapeAttr(cellStyle)}">`
      + `<a ${attrs} style="${escapeAttr(anchorStyle)}">${inner.trim()}</a>`
      + '</td></tr></table>';
  });
}

// The font every workflow e-mail falls back to (the engine's own blocks use it).
export const EMAIL_BASE_FONT = 'Arial,Helvetica,sans-serif';
const BASE_FONT_MARK = 'data-tp-base-font';

/**
 * Text a template leaves without a font-family gets the client's default:
 * Times in a browser (the Preview page) and classic Outlook, Aptos or Segoe UI
 * in new Outlook. So one e-mail looked different in Preview and in the inbox
 * (QA 10-21 #10). Wrapping the body in one font makes them agree; a template's
 * own font-family still wins. Idempotent.
 */
export function withBaseFont(html) {
  const input = String(html || '');
  if (!input.trim() || input.includes(BASE_FONT_MARK)) return input;
  const bodyTag = /<body\b([^>]*)>/i.exec(input);
  if (bodyTag) {
    const attrs = bodyTag[1] || '';
    const styled = /\sstyle\s*=\s*"([^"]*)"/i.exec(attrs);
    const nextAttrs = styled
      ? (/font-family\s*:/i.test(styled[1]) ? attrs : attrs.replace(styled[0], ` style="font-family:${EMAIL_BASE_FONT};${styled[1]}"`))
      : `${attrs} style="font-family:${EMAIL_BASE_FONT};"`;
    return input.replace(bodyTag[0], `<body${nextAttrs} ${BASE_FONT_MARK}="1">`);
  }
  return `<div ${BASE_FONT_MARK}="1" style="font-family:${EMAIL_BASE_FONT};">${input}</div>`;
}

/**
 * A paragraph that does not set its own margin gets the client's default: about
 * a line above and below in a browser, classic Outlook and a message opened in its
 * own window, but NONE in the new Outlook / Outlook on the web reading pane — the
 * lines of a reply ran together there (Vahid, 31 Oct 2026). Each <p> is given the
 * browser default inline for the sides it leaves unset, so every client agrees. A
 * `margin:` shorthand (signatures, templates) and Word's MsoNormal paragraphs
 * (quoted Outlook mail, margin 0 by design) are left alone. Idempotent.
 */
const PARAGRAPH_RE = /<p(?=[\s>/])([^>]*)>/gi;
const STYLE_ATTR_RE = /\sstyle\s*=\s*(?:"([^"]*)"|'([^']*)')/i;

export function paragraphSpacing(html) {
  const input = String(html || '');
  if (!/<p[\s>/]/i.test(input)) return input;
  return input.replace(PARAGRAPH_RE, (whole, attrs) => {
    if (/\bclass\s*=\s*["']?[^"'>]*\bMso/i.test(attrs)) return whole;
    const styleMatch = STYLE_ATTR_RE.exec(attrs);
    const style = styleMatch ? (styleMatch[1] ?? styleMatch[2] ?? '') : '';
    const props = style.split(';').map((d) => d.split(':')[0].trim().toLowerCase()).filter(Boolean);
    if (props.includes('margin')) return whole;
    const add = ['margin-top', 'margin-bottom'].filter((p) => !props.includes(p)).map((p) => `${p}:1em`);
    if (!add.length) return whole;
    const merged = [style.trim().replace(/;\s*$/, ''), ...add].filter(Boolean).join(';');
    const rest = styleMatch ? attrs.replace(styleMatch[0], '') : attrs;
    return `<p${rest.replace(/\s*\/?$/, '')} style="${escapeAttr(merged)}">`;
  });
}

/**
 * A picture written into the HTML as data (`src="data:image/png;base64,…"`) — a
 * signature logo pasted into Settings → Signatures — shows in a browser and in a
 * message opened in its own window, but the new Outlook reading pane and Gmail
 * block it, leaving an empty column (the signature looked shifted right, 31 Oct
 * 2026). Each one becomes an inline attachment referenced by cid:, which every
 * client shows. Identical pictures share one attachment; a picture over the cap,
 * or past the count, stays as it was.
 */
export const MAX_INLINE_DATA_IMAGE_BYTES = Math.floor(1.5 * 1024 * 1024);
export const MAX_INLINE_DATA_IMAGES = 12;
// All of them together: Graph's one-call sendMail takes ~4 MB per request, and a reply's own
// pictures and photos (replyEmailPictures, up to 2.5 MB) ride the same request.
export const MAX_INLINE_DATA_TOTAL_BYTES = 1024 * 1024;
const DATA_IMG_RE = /(<img\b[^>]*?\ssrc\s*=\s*)(["'])data:(image\/(?:png|jpe?g|gif|webp|bmp));base64,([A-Za-z0-9+/=\s]+)\2/gi;

export function inlineDataImages(html) {
  const input = String(html || '');
  if (!/<img\b[^>]*data:image\//i.test(input)) return { html: input, attachments: [] };
  const byData = new Map();
  const attachments = [];
  let total = 0;
  const out = input.replace(DATA_IMG_RE, (whole, head, quote, contentType, data) => {
    const contentBytes = data.replace(/\s+/g, '');
    const bytes = Math.floor(contentBytes.length * 0.75);
    if (bytes > MAX_INLINE_DATA_IMAGE_BYTES) return whole;
    let cid = byData.get(contentBytes);
    if (!cid) {
      if (attachments.length >= MAX_INLINE_DATA_IMAGES || total + bytes > MAX_INLINE_DATA_TOTAL_BYTES) return whole;
      total += bytes;
      cid = `tp-img-${attachments.length + 1}`;
      byData.set(contentBytes, cid);
      const ext = contentType.split('/')[1].replace('jpeg', 'jpg');
      attachments.push({ name: `image${attachments.length + 1}.${ext}`, contentType, contentBytes, contentId: cid });
    }
    return `${head}${quote}cid:${cid}${quote}`;
  });
  return { html: out, attachments };
}

/**
 * Every outgoing e-mail passes through this at the transport (Graph and SendGrid/SMTP),
 * whatever wrote it: replies, signatures, workflows, approvals, mentions.
 */
export function prepareOutboundEmail({ html, attachments = [] } = {}) {
  if (!html) return { html, attachments };
  const inlined = inlineDataImages(paragraphSpacing(html));
  return {
    html: inlined.html,
    attachments: [...(Array.isArray(attachments) ? attachments : []), ...inlined.attachments],
  };
}

export default { bulletproofButtons, withBaseFont, paragraphSpacing, inlineDataImages, prepareOutboundEmail };
