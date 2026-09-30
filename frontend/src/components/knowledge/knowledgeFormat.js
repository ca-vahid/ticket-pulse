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

/** System tags shown with a friendly label (the tag itself stays as stored). */
export const TAG_LABELS = Object.freeze({ 'drafted-from-tickets': 'Drafted from tickets' });

/** A tag as people read it: a known system slug gets its label, anything else is shown as typed. */
export function tagLabel(tag) {
  const t = String(tag ?? '');
  return TAG_LABELS[t.toLowerCase()] || t;
}

/** Tags that are system markers, not topics (the source moved to its own field, MEGA 09-28). */
export function isSystemTag(tag) {
  return Object.prototype.hasOwnProperty.call(TAG_LABELS, String(tag ?? '').toLowerCase());
}

/** An article's topics: its tags minus any legacy system marker. */
export function articleTopics(article) {
  return (article?.tags || []).filter((t) => !isSystemTag(t));
}

/**
 * Where an article came from, as its own line (never mixed into topics):
 * the server's `sourceLabel`, else a friendly word for the legacy tag / source.
 */
export function articleSourceLabel(article) {
  if (!article) return null;
  if (article.sourceLabel) return article.sourceLabel;
  if (article.source === 'fs_solution') return 'FreshService';
  const legacy = (article.tags || []).find((t) => isSystemTag(t));
  return legacy ? tagLabel(legacy) : null;
}

const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * The playbook summary line (Knowledge v2, MEGA 09-28 §6.8) from the
 * server's `summary`: [{ key, text }] parts joined with " · ". Article titles
 * are rendered separately (as links) by the caller.
 */
export function playbookSummaryParts(summary) {
  if (!summary) return [];
  const parts = [];
  const subs = Number(summary.subcategoryCount) || 0;
  parts.push({ key: 'scope', text: subs ? `Answers tickets in ${plural(subs, 'subcategory', 'subcategories')}` : 'Answers tickets anywhere in its category' });
  if (summary.useWords) parts.push({ key: 'words', text: 'only when the words match' });
  const pbRules = Number(summary.stayQuietCount) || 0;
  const wsRules = Number(summary.workspaceRuleCount) || 0;
  if (pbRules || wsRules) {
    const bits = [pbRules ? plural(pbRules, 'playbook rule') : null, wsRules ? plural(wsRules, 'workspace rule') : null].filter(Boolean);
    parts.push({ key: 'quiet', text: `Stays quiet on ${bits.join(' + ')}` });
  }
  const arts = (summary.articles || []).length;
  const total = Number(summary.articleTotalPublished) || 0;
  parts.push({
    key: 'articles',
    text: arts
      ? `Prefers ${plural(arts, 'article')} in its category${total ? ` (searches all ${total} published)` : ''}`
      : `No article in its category yet${total ? ` — search still reaches all ${total} published` : ''}`,
  });
  return parts;
}

/** "Last 30 days: this version would take N tickets (saved version: M)." */
export function previewMatchLine(preview, { isNew = false } = {}) {
  if (!preview) return '';
  const days = Number(preview.days) || 30;
  const takes = Number(preview.draftTakes) || 0;
  const was = isNew || preview.savedTakes === null || preview.savedTakes === undefined ? 'new playbook' : `saved version: ${preview.savedTakes}`;
  return `Last ${days} days: this version would take ${plural(takes, 'ticket')} (${was}).`;
}

/** The AI fit check's one-line reason on a "Not this playbook" run. */
export function fitReasonOf(run) {
  if (!run) return null;
  // The backend sends the fit check as `fit` on the run view and keeps it in
  // `transcript.fit`; `reasons` carries "Not this playbook: <reason>".
  const fromReasons = (list) => {
    const line = (Array.isArray(list) ? list : []).find((r) => /^Not this playbook:/i.test(String(r)));
    return line ? String(line).replace(/^Not this playbook:\s*/i, '') : null;
  };
  return run.fit?.reason || run.transcript?.fit?.reason || fromReasons(run.reasons) || fromReasons(run.transcript?.reasons)
    || run.checks?.fit?.reason || run.fitCheck?.reason || run.fitReason || run.reason || run.transcript?.reason || null;
}

export function isNotThisPlaybook(run) {
  return run?.gateDecision === 'not_this_playbook';
}

/**
 * A playbook's match block as the builder edits it. A legacy playbook saved
 * before Knowledge v2 has no `useWords`: its words were required, so it
 * counts as on when it has any.
 */
export function normaliseMatch(match) {
  const keywords = match?.keywords || [];
  const excludeKeywords = match?.excludeKeywords || [];
  const useWords = typeof match?.useWords === 'boolean' ? match.useWords : (keywords.length + excludeKeywords.length) > 0;
  return { whenToHelp: String(match?.whenToHelp || ''), useWords, keywords, excludeKeywords };
}
