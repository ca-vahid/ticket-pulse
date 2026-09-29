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

export default { bulletproofButtons };
