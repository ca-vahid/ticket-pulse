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
  return m ? m[1].trim() : null;
};

const ANCHOR_RE = /<a\b([^>]*?)\sstyle\s*=\s*"([^"]*)"([^>]*)>([\s\S]*?)<\/a>/gi;

function escapeAttr(value) {
  return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');
}

/**
 * Rewrites every anchor whose inline style carries BOTH a background and a
 * padding into a table-cell button. Anchors that are plain links, or already
 * sit inside a bulletproof cell (no padding on the anchor), are left alone,
 * which also makes the transform idempotent.
 */
export function bulletproofButtons(html) {
  const input = String(html || '');
  if (!input || !/<a\b/i.test(input)) return input;
  return input.replace(ANCHOR_RE, (whole, before, style, after, inner) => {
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
    const anchorStyle = [
      'display:inline-block',
      `color:${color}`,
      'text-decoration:none',
      `font-family:${fontFamily}`,
      fontWeight ? `font-weight:${fontWeight}` : null,
      fontSize ? `font-size:${fontSize}` : null,
      'line-height:1.2',
    ].filter(Boolean).join(';');
    const cellStyle = [
      `background-color:${bg}`,
      radius ? `border-radius:${radius}` : null,
      `padding:${padding}`,
      'text-align:center',
      'mso-padding-alt:0',
    ].filter(Boolean).join(';');
    return '<table role="presentation" border="0" cellpadding="0" cellspacing="0" style="display:inline-table;border-collapse:separate;">'
      + `<tr><td bgcolor="${escapeAttr(bg)}" style="${cellStyle}">`
      + `<a ${attrs} style="${anchorStyle}">${inner.trim()}</a>`
      + '</td></tr></table>';
  });
}

export default { bulletproofButtons };
