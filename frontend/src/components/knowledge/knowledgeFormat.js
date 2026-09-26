/** Plain formatting helpers for the Knowledge section (no components). */

/** "Software & Apps → Installation, Setup" from a category tree. */
export function categoryLabel(tree = [], categoryId, subcategoryIds = []) {
  const top = tree.find((c) => c.id === Number(categoryId));
  if (!top) return categoryId ? `Category #${categoryId}` : 'No category';
  const subs = (subcategoryIds || []).map((id) => top.subcategories?.find((s) => s.id === Number(id))?.name).filter(Boolean);
  return subs.length ? `${top.name} → ${subs.join(', ')}` : `${top.name} → all subcategories`;
}

export function fmtDuration(ms) {
  const v = Number(ms);
  if (!Number.isFinite(v) || v <= 0) return null;
  return v < 1000 ? `${Math.round(v)} ms` : `${(v / 1000).toFixed(1)} s`;
}

/** "today", "3 days ago", "2 weeks ago", "3 months ago", "1 year ago". */
export function agoWords(value, now = Date.now()) {
  if (!value) return null;
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return null;
  const days = Math.max(0, Math.floor((now - t) / 86400e3));
  const unit = (n, w) => `${n} ${w}${n === 1 ? '' : 's'} ago`;
  if (days < 1) return 'today';
  if (days < 14) return unit(days, 'day');
  if (days < 60) return unit(Math.floor(days / 7), 'week');
  if (days < 365) return unit(Math.floor(days / 30), 'month');
  return unit(Math.floor(days / 365), 'year');
}

/** R1 governance line for an article: "Verified 3 months ago · Review due". */
export function governanceLine(article, now = Date.now()) {
  if (!article || article.status !== 'published') return null;
  const verified = agoWords(article.lastVerifiedAt, now);
  const head = verified ? `Verified ${verified}` : 'Never verified';
  return article.needsReview ? `${head} · Review due` : head;
}

/**
 * Model reasons cite sources by id ("per article:1"); people read titles.
 * Unknown ids fall back to a plain noun, never the raw id.
 */
export function readableReason(text, sources = []) {
  if (!text) return text;
  const noun = { article: 'an article', ticket: 'a resolved ticket', solution: 'a verified solution', playbook: 'the playbook' };
  return String(text).replace(/\b(article|ticket|solution|playbook):(\d+)\b/gi, (m, type) => {
    const s = (sources || []).find((x) => String(x.sourceId).toLowerCase() === m.toLowerCase());
    return s?.title ? `“${s.title}”` : noun[type.toLowerCase()];
  });
}
