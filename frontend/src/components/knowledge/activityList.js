// What the run page needs to know about the list it was opened from: the ids
// on that page (Previous / Next) and the list's URL filters (Back). Kept in
// sessionStorage so F5 on a run keeps its place; a run opened from a link
// simply has no neighbours.
const KEY = 'tp:knowledge:activity:list';

export function rememberList({ ids = [], search = '', offset = 0, total = 0 } = {}) {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ ids: ids.map(Number), search, offset, total }));
  } catch { /* private window: no neighbours, the page still works */ }
}

export function recallList() {
  try {
    const v = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return v && Array.isArray(v.ids) ? v : null;
  } catch { return null; }
}

/** Where a run sits in the remembered list: { prev, next, position, total, search }. */
export function neighboursOf(runId, list = recallList()) {
  const none = { prev: null, next: null, position: null, total: null, search: list?.search || '' };
  if (!list) return none;
  const i = list.ids.indexOf(Number(runId));
  if (i < 0) return none;
  return {
    prev: i > 0 ? list.ids[i - 1] : null,
    next: i < list.ids.length - 1 ? list.ids[i + 1] : null,
    position: (Number(list.offset) || 0) + i + 1,
    total: Number(list.total) || list.ids.length,
    search: list.search || '',
  };
}

/** "1–50 of 425" / "1 run" / "No runs". */
export function pageWords({ offset = 0, shown = 0, total = 0 } = {}) {
  if (!total) return 'No runs';
  if (total === 1) return '1 run';
  if (shown >= total && offset === 0) return `${total} runs`;
  return `${(offset + 1).toLocaleString()}–${(offset + shown).toLocaleString()} of ${total.toLocaleString()}`;
}
