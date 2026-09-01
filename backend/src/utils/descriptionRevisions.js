import { escapeHtml, looksLikeRealHtml, plainTextToHtml } from './htmlContent.js';

/**
 * Description "added later" blocks — ONE visual language for content that
 * lands on a ticket description after creation (Mega 08-31 cross-phase note):
 *
 *   • Phase PA: "— Resubmitted <date> via API key "…" —" (Power Apps / API
 *     resubmissions append the new description; nothing is ever replaced —
 *     the description has no history anywhere else).
 *   • Phase AF (later): "— Source material (pasted) —" for the Autofill block.
 *
 * Rendering is deliberately plain HTML (hr + strong header + div body) so it
 * survives sanitizeBodyHtml, the FS mirror, and tag-stripping → descriptionText.
 * `<details>` support can be added here in one place later.
 */

/** Stable marker prefix — used to spot prior blocks in a description. */
export const REVISION_MARKER_PREFIX = '— ';

export function formatRevisionDate(date = new Date(), timeZone = 'UTC') {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone, year: 'numeric', month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
    }).format(date).replace(',', '');
  } catch {
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }
}

/** Body content → HTML fragment (real HTML kept, plain text escaped + <br>). */
export function bodyToHtml(raw) {
  const value = raw === null || raw === undefined ? '' : String(raw);
  if (!value.trim()) return '';
  return looksLikeRealHtml(value) ? value : (plainTextToHtml(value) || '');
}

/**
 * Render one revision block. `label` is the human header WITHOUT the em-dash
 * frame (e.g. 'Resubmitted 2026-09-01 14:03 via API key "Coreshack intake"');
 * it is escaped here. `bodyHtml` must already be safe HTML (bodyToHtml).
 */
export function renderRevisionBlock({ label, bodyHtml, withRule = true }) {
  const header = `<p><strong>${REVISION_MARKER_PREFIX}${escapeHtml(label)} —</strong></p>`;
  const body = bodyHtml ? `<div>${bodyHtml}</div>` : '';
  return `${withRule ? '<hr>' : ''}${header}${body}`;
}

/**
 * Append a revision block to an existing description HTML. An empty existing
 * description gets the block without the leading rule (nothing to separate).
 * Returns the new description HTML.
 */
export function appendRevision(existingHtml, { label, body }) {
  const bodyHtml = bodyToHtml(body);
  const existing = existingHtml ? String(existingHtml) : '';
  const block = renderRevisionBlock({ label, bodyHtml, withRule: Boolean(existing.trim()) });
  return existing.trim() ? `${existing}\n${block}` : block;
}

/** Same tag-stripping the ticket service applies for descriptionText (kept local — that helper is private). */
export function htmlToText(html) {
  if (!html) return '';
  return String(html)
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<br\s*\/?>(?=.)/gi, '\n')
    .replace(/<\/(p|div|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Whitespace-insensitive "does this text already appear in the description?". */
export function descriptionAlreadyContains(descriptionText, candidateText) {
  const norm = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
  const hay = norm(descriptionText);
  const needle = norm(candidateText);
  if (!needle) return true;
  if (!hay) return false;
  return hay.includes(needle);
}

export default {
  renderRevisionBlock, appendRevision, bodyToHtml, htmlToText, formatRevisionDate, descriptionAlreadyContains,
};
