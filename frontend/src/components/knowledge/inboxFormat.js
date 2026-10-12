/**
 * Words for Knowledge → Inbox and Home. Pure.
 * `accept` is the main button; `done` is what the page says after it.
 */
export const KIND = Object.freeze({
  review: { label: 'Your draft', dot: 'bg-sky-500', accept: 'Publish', done: 'Published' },
  new_article: { label: 'New article', dot: 'bg-emerald-500', accept: 'Publish', done: 'Published' },
  add_section: { label: 'A section to add', dot: 'bg-emerald-500', accept: 'Add it', done: 'Added' },
  edit: { label: 'A change', dot: 'bg-sky-500', accept: 'Apply the change', done: 'Applied' },
  merge: { label: 'Two articles to merge', dot: 'bg-violet-500', accept: 'Merge them', done: 'Merged' },
  retire: { label: 'An article to retire', dot: 'bg-muted-foreground/60', accept: 'Archive it', done: 'Archived' },
  flag: { label: 'Something is wrong', dot: 'bg-amber-500', accept: 'Dealt with', done: 'Marked as dealt with' },
  question: { label: 'A question', dot: 'bg-amber-500', accept: 'Send the answer', done: 'Answered' },
  gap: { label: 'Not written down', dot: 'bg-amber-500', accept: 'Dealt with', done: 'Marked as dealt with' },
});

export function kindOf(item) {
  return KIND[item?.kind] || KIND.flag;
}

/** "Would touch about 14 tickets a month" — only when there is a number. */
export function impactWords(item) {
  const n = Math.round(Number(item?.impact) || 0);
  if (n <= 0) return '';
  if (item.kind === 'flag') return `the article was used in ${n} answer${n === 1 ? '' : 's'}`;
  return `about ${n} ticket${n === 1 ? '' : 's'} a month`;
}

/** Where the suggestion came from, with the count behind it. */
export function evidenceWords(item) {
  const e = item?.evidence || {};
  const tickets = Array.isArray(e.ticketIds) ? e.ticketIds.length : 0;
  const from = {
    steward: 'found by the nightly review',
    agent_flag: 'flagged by a person',
    agent_close: 'from a closed ticket',
    gap_finder: 'from unanswered tickets',
    person: 'proposed by a person',
    fs_import: 'imported from FreshService',
  }[item?.source] || '';
  return [from, tickets ? `${tickets} ticket${tickets === 1 ? '' : 's'} behind it` : ''].filter(Boolean).join(' · ');
}

const LEVEL_WORD = ['', 'Basic', 'Intermediate', 'Advanced', 'Expert'];
export function levelWord(level) {
  return LEVEL_WORD[Number(level) || 0] || '';
}

/** One line per category on Home: what there is and what needs someone. */
export function categoryLine(c) {
  const parts = [c.articles ? `${c.articles} article${c.articles === 1 ? '' : 's'}` : 'nothing written yet'];
  if (c.notChecked) parts.push(`${c.notChecked} not checked yet`);
  if (c.attention) parts.push(`${c.attention} need${c.attention === 1 ? 's' : ''} attention`);
  const runs = c.runs30 || {};
  if (runs.total) parts.push(`${runs.answered} of ${runs.total} tickets answered in 30 days`);
  return parts.join(' · ');
}
