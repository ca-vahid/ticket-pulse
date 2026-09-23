/**
 * Line spacing for e-mail signatures — the same rule the backend applies at
 * send time (userSignatureService.applySignatureSpacing), so the preview on
 * Mail & alerts shows exactly what recipients get (23 Sep 2026: the preview
 * used class-based rules, which an inline `margin:0` from a pasted or
 * templated signature always beat — picking Relaxed changed nothing).
 *
 * Only <p> is touched: <div> has no default margin, so rewriting it would
 * collapse deliberate table/div layouts for no benefit.
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

function stripMarginDeclarations(style) {
  return String(style || '')
    .split(';')
    .map((decl) => decl.trim())
    .filter((decl) => decl && !/^margin(?:-top|-bottom|-left|-right)?\s*:/i.test(decl))
    .join('; ');
}

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
