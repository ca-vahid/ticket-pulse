/**
 * Plain-sentence helpers for My alerts (Mail & alerts). Pure functions so the
 * list rows, the editor summary and the tests all read the same words.
 */

export const PRIORITY_CHOICES = [
  { value: '', label: 'Any priority' },
  { value: '3', label: 'High and Urgent' },
  { value: '4', label: 'Urgent only' },
];

export const MAX_ALERT_CATEGORIES = 40;

/** "a", "a and b", "a, b and c". */
export function joinWords(list, last = 'and') {
  const xs = (list || []).filter(Boolean);
  if (xs.length <= 1) return xs[0] || '';
  return `${xs.slice(0, -1).join(', ')} ${last} ${xs[xs.length - 1]}`;
}

const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);

/** id → { id, name, path, isTop, parentId, childIds } from the options tree. */
export function indexCategoryTree(tree) {
  const map = new Map();
  for (const top of tree || []) {
    map.set(top.id, { id: top.id, name: top.name, path: top.name, isTop: true, parentId: null, childIds: (top.children || []).map((c) => c.id) });
    for (const c of top.children || []) {
      map.set(c.id, { id: c.id, name: c.name, path: `${top.name} › ${c.name}`, isTop: false, parentId: top.id, childIds: [] });
    }
  }
  return map;
}

/** Drop subcategories already covered by a ticked top; keep order; cap the count. */
export function tidyCategoryIds(ids, index) {
  const list = [...new Set((ids || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  const tops = new Set(list.filter((id) => index.get(id)?.isTop));
  return list.filter((id) => !tops.has(index.get(id)?.parentId)).slice(0, MAX_ALERT_CATEGORIES);
}

/** Editor summary: "Any category", "All of Devices & Hardware", "All of Devices & Hardware, and 2 others". */
export function categorySummary(ids, index) {
  const list = ids || [];
  if (!list.length) return 'Any category';
  const words = list.map((id) => {
    const c = index.get(id);
    if (!c) return 'a category no longer in use';
    return c.isTop && c.childIds.length ? `All of ${c.name}` : c.path;
  });
  if (words.length === 1) return words[0];
  if (words.length === 2) return `${words[0]} and ${words[1]}`;
  return `${words[0]}, and ${words.length - 1} others`;
}

const CHANNEL_WORDS = [
  ['channelTeams', 'Teams'],
  ['channelEmail', 'e-mail'],
  ['channelSms', 'SMS'],
  ['channelWhatsapp', 'WhatsApp'],
  ['channelPhone', 'a phone call'],
];

/** The names an alert row shows for its categories (server paths first, then the tree). */
function categoryNames(sub, index) {
  if (Array.isArray(sub.categories) && sub.categories.length) {
    return sub.categories.map((c) => c.path || c.name || index?.get(c.id)?.path || 'a category no longer in use');
  }
  return (sub.categoryIds || []).map((id) => index?.get(id)?.path || 'a category no longer in use');
}

/**
 * One alert as a sentence, e.g.
 * "New and escalated tickets in Devices & Hardware and Account & Access › RDP, by Teams and e-mail".
 */
export function alertSentence(sub, index = null) {
  const when = joinWords([
    sub.onCreated && 'new',
    sub.onPriorityRaised && 'escalated',
    sub.onRecategorized && 're-categorized',
  ]) || 'matching';
  const names = categoryNames(sub, index);
  let where = 'in any category';
  if (names.length > 3) where = `in ${names[0]}, ${names[1]} and ${names.length - 2} other categories`;
  else if (names.length) where = `in ${joinWords(names)}`;
  const prio = Number(sub.priorityMin) === 4 ? ' that are Urgent' : (Number(sub.priorityMin) === 3 ? ' that are High or Urgent' : '');
  const tag = sub.tagName ? ` tagged ${sub.tagName}` : '';
  const how = joinWords(CHANNEL_WORDS.filter(([k]) => sub[k]).map(([, w]) => w));
  const text = `${when} tickets ${where}${prio}${tag}${how ? `, by ${how}` : ''}`;
  return sub.isActive === false ? `Paused — ${text}` : cap(text);
}

/** A short default name for the editor ("Urgent tickets", "Devices & Hardware and 2 more"). */
export function autoAlertName(draft, index) {
  const ids = draft.categoryIds || [];
  if (ids.length) {
    const first = index.get(ids[0])?.path || 'Categories';
    return ids.length > 1 ? `${first} and ${ids.length - 1} more` : first;
  }
  if (String(draft.priorityMin) === '4') return 'Urgent tickets';
  if (String(draft.priorityMin) === '3') return 'High and Urgent tickets';
  if (draft.tagName) return `Tagged ${draft.tagName}`;
  return 'All tickets';
}

/** What still stops the alert from saving, in plain words (null = ready). */
export function draftProblem(draft) {
  if (!(draft.categoryIds || []).length && !draft.tagId && !draft.priorityMin) {
    return 'Pick some categories, a priority or a tag — otherwise this alert would fire for every ticket.';
  }
  const recat = draft.onRecategorized && (draft.categoryIds || []).length > 0;
  if (!draft.onCreated && !draft.onPriorityRaised && !recat) return 'Turn on at least one moment under When.';
  if (!CHANNEL_WORDS.some(([k]) => draft[k])) return 'Pick at least one way to reach you.';
  return null;
}
