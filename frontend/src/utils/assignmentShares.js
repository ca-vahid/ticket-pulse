/** Ticket shares (QA 10-16 item 4): the editor's checks, the same as the server's. */

export const sharesTotal = (members) => (members || []).reduce((sum, m) => sum + (Number(m.pct) || 0), 0);

/** Problems that stop a save, in plain words (the server checks the same). */
export function draftProblems(draft) {
  const problems = [];
  const sum = sharesTotal(draft.members);
  if (draft.members.some((m) => !Number.isInteger(Number(m.pct)) || Number(m.pct) < 1 || Number(m.pct) > 100)) {
    problems.push('Each share must be a whole percent from 1 to 100.');
  }
  if (draft.members.length && sum !== 100) {
    problems.push(sum < 100 ? `Total ${sum}% — add ${100 - sum}% to save.` : `Total ${sum}% — take off ${sum - 100}% to save.`);
  }
  if (draft.mode !== 'off' && !draft.members.length) problems.push('Add the people who share the tickets before switching it on.');
  if (draft.mode !== 'off' && !draft.categoryIds.length) problems.push('Pick at least one category before switching it on.');
  return problems;
}
