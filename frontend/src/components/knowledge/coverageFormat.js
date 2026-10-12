/**
 * Words and order for the coverage map (Knowledge → Gaps). Pure.
 */

/** The gap of a category: tickets nothing answered, plus searches that found nothing. */
export function gapOf(c) {
  return (Number(c?.notAnswered) || 0) + (Number(c?.searchMisses) || 0);
}

/** Biggest gap first; then the categories with demand and nothing written; then by demand. */
export function coverageSort(rows = []) {
  const empty = (c) => (c.articles ? 0 : 1);
  return [...rows].sort((a, b) => gapOf(b) - gapOf(a) || empty(b) - empty(a) || (Number(b.tickets30) || 0) - (Number(a.tickets30) || 0) || String(a.name).localeCompare(String(b.name)));
}

/** One short sentence per row: the thing worth acting on, or nothing. */
export function coverageNote(c) {
  const tickets = Number(c.tickets30) || 0;
  const gap = gapOf(c);
  if (!c.articles && tickets >= 10) {
    return c.couldWrite ? `${tickets} tickets and nothing written yet` : `${tickets} tickets, nothing written, and nobody has the skill recorded to write it`;
  }
  if (gap >= 3) return `${gap} could not be answered${c.openGaps ? `; ${c.openGaps} in the inbox as gap${c.openGaps === 1 ? '' : 's'}` : ''}`;
  if (c.attention) return `${c.attention} article${c.attention === 1 ? '' : 's'} need${c.attention === 1 ? 's' : ''} attention`;
  if (c.notChecked) return `${c.notChecked} not checked yet`;
  if (c.openItems) return `${c.openItems} item${c.openItems === 1 ? '' : 's'} in the inbox`;
  return '';
}

/** "Sure answers were right 9 of 11 times" for a category's calibration, or ''. */
export function calibrationWords(calibration) {
  const high = calibration?.high;
  if (!high || !Number(high.judged)) return '';
  return `sure answers were right ${high.right} of ${high.judged} times`;
}

/** What the nightly review last did, in a sentence. */
export function reviewWords(last) {
  if (!last?.at) return 'It has not run yet.';
  const c = last.counts || {};
  const parts = [
    c.overlap && `${c.overlap} to merge`, c.unused && `${c.unused} never used`, c.needsLook && `${c.needsLook} doubtful`, c.outOfDate && `${c.outOfDate} out of date`,
    c.houseRules && `${c.houseRules} to tidy`, c.gaps && `${c.gaps} not written down`, c.edits && `${c.edits} change${c.edits === 1 ? '' : 's'}`, c.questions && `${c.questions} question${c.questions === 1 ? '' : 's'}`,
  ].filter(Boolean);
  return `Read ${last.scanned} article${last.scanned === 1 ? '' : 's'}; raised ${parts.length ? parts.join(', ') : 'nothing new'}.`;
}
