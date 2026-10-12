/**
 * Words and small rules for Knowledge → Library and the article page. Pure.
 */

/** One word per article (server `health`), with a dot colour. Never a pill. */
export const HEALTH = Object.freeze({
  checked: { label: 'Checked', dot: 'bg-emerald-500', hint: 'Someone with the skill confirmed this article' },
  not_checked: { label: 'Not checked yet', dot: 'bg-sky-500', hint: 'Written, not yet confirmed by someone with the skill' },
  needs_look: { label: 'Needs a look', dot: 'bg-amber-500', hint: 'People said it was wrong or unclear; it is out of automatic answers until someone checks it' },
  out_of_date: { label: 'Out of date', dot: 'bg-amber-500', hint: 'Past its review date' },
  draft: { label: 'Draft', dot: 'bg-muted-foreground/50', hint: 'Not published' },
  archived: { label: 'Archived', dot: 'bg-muted-foreground/30', hint: 'Out of search and answers' },
});

export function healthOf(article) {
  return HEALTH[article?.health] || HEALTH.not_checked;
}

/** The health filter of the list, as the options of its select. */
export const HEALTH_FILTERS = Object.freeze([
  { value: '', label: 'Everything' },
  { value: 'checked', label: 'Checked' },
  { value: 'not_checked', label: 'Not checked yet' },
  { value: 'needs_look', label: 'Needs a look' },
  { value: 'out_of_date', label: 'Out of date' },
  { value: 'draft', label: 'Drafts' },
]);

/**
 * The list request for what the Library shows.
 *   scope  { view: 'all' | 'mine' | 'attention' | 'none', categoryId, subcategoryId }
 *   health one of HEALTH_FILTERS values
 * Returns one or two param objects ("needs attention" is two lists merged).
 */
export function listRequests({ scope = {}, health = '', limit = 50, offset = 0 } = {}) {
  const base = { limit, offset, sort: 'title' };
  if (scope.categoryId) base.categoryId = scope.categoryId;
  if (scope.subcategoryId) base.subcategoryId = scope.subcategoryId;
  if (scope.view === 'none') base.uncategorised = true;
  // The server reads "me" as the signed-in person.
  if (scope.view === 'mine') base.owner = 'me';
  if (scope.view === 'attention') {
    return [{ ...base, status: 'published', confidence: 'needs_look' }, { ...base, status: 'published', review: 'due' }];
  }
  if (health === 'draft') return [{ ...base, status: 'draft' }];
  if (health === 'out_of_date') return [{ ...base, status: 'published', review: 'due' }];
  if (health === 'checked' || health === 'not_checked' || health === 'needs_look') return [{ ...base, status: 'published', confidence: health }];
  return [base];
}

/** Merge list pages without repeats, by title. */
export function mergeArticles(lists = []) {
  const seen = new Map();
  for (const list of lists) for (const a of list || []) if (a && !seen.has(a.id)) seen.set(a.id, a);
  return [...seen.values()].sort((a, b) => String(a.title || '').localeCompare(String(b.title || '')));
}

/** "12 articles", "1 article", "Nothing yet". */
export function countWords(n, one = 'article', many = 'articles') {
  const count = Number(n) || 0;
  if (!count) return 'Nothing yet';
  return `${count} ${count === 1 ? one : many}`;
}

/** The title of the list for a scope. */
export function scopeTitle(scope = {}, tree = null) {
  if (scope.view === 'mine') return 'Mine';
  if (scope.view === 'attention') return 'Needs attention';
  if (scope.view === 'none') return 'No category yet';
  const cat = (tree?.categories || []).find((c) => c.id === Number(scope.categoryId));
  if (!cat) return 'All articles';
  const sub = (cat.subcategories || []).find((s) => s.id === Number(scope.subcategoryId));
  return sub ? `${cat.name} › ${sub.name}` : cat.name;
}

/** How an article did in use, always with the counts ("Used in 14 answers · 9 marked good"). */
export function usageWords(article) {
  const quoted = Number(article?.timesQuoted) || 0;
  const use = article?.use || {};
  const parts = [];
  parts.push(quoted ? `Used in ${quoted} answer${quoted === 1 ? '' : 's'}` : 'Not used in an answer yet');
  const judged = (Number(use.good) || 0) + (Number(use.partial) || 0) + (Number(use.wrong) || 0);
  if (judged) {
    parts.push(`${use.good || 0} of ${judged} judged good`);
    if (use.wrong) parts.push(`${use.wrong} judged wrong`);
  }
  if (use.flagged) parts.push(`flagged ${use.flagged} time${use.flagged === 1 ? '' : 's'}`);
  return parts.join(' · ');
}

/** A stable anchor id for a section heading. */
export function sectionAnchor(heading, index) {
  const slug = String(heading || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return `s${index}-${slug || 'section'}`;
}
