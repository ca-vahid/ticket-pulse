/**
 * Ticket shares (QA 10-16 item 4; rules per category with internal groups
 * QA 11-26 #3–6): the editor's checks and words, the same as the server's
 * (backend services/assignmentShares/rules.js).
 */

const list = (v) => (Array.isArray(v) ? v : []);

export const sharesTotal = (members) => list(members).reduce((sum, m) => sum + (Number(m?.pct) || 0), 0);
/** The percent named outright: people plus groups. */
export const explicitPct = (rule) => sharesTotal(rule?.members) + sharesTotal(rule?.groups);
export const restOn = (rule) => rule?.rest?.evenly === true;
/** What "the rest, split evenly" takes: 100 − the named percent (0 when off or nobody is picked, as the server counts it). */
export const restPct = (rule) => (restOn(rule) && list(rule?.rest?.techIds).length ? Math.max(0, 100 - explicitPct(rule)) : 0);
export const hasShares = (rule) => list(rule?.members).length > 0 || list(rule?.groups).length > 0 || (restOn(rule) && list(rule?.rest?.techIds).length > 0);
const round1 = (n) => Math.round(n * 10) / 10;
export const eachPct = (pct, n) => (n > 0 ? round1(pct / n) : 0);

const joinWords = (words) => (words.length <= 1 ? words.join('') : `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * Problems that stop a save, in plain words (the server checks the same).
 * @param {object} draft  { mode, categoryIds, members, groups, rest }
 * @param {object} ctx
 * @param {Map<number, {name, memberIds}>} ctx.groupsById  the workspace's internal groups
 * @param {(id:number) => string} ctx.nameOf
 */
export function draftProblems(draft, { groupsById = new Map(), nameOf = (id) => `Technician ${id}` } = {}) {
  const problems = [];
  const members = list(draft?.members);
  const groups = list(draft?.groups);
  const evenly = restOn(draft);
  const restIds = list(draft?.rest?.techIds);
  const all = [...members, ...groups];
  if (all.some((m) => !Number.isInteger(Number(m.pct)) || Number(m.pct) < 1 || Number(m.pct) > 100)) {
    problems.push('Each share must be a whole percent from 1 to 100.');
  }
  const sum = explicitPct(draft);
  if (evenly) {
    if (!restIds.length) problems.push('Pick the people who split the rest evenly.');
    else if (sum >= 100) problems.push(`The named shares already make ${sum}%, so nothing is left to split evenly. Lower a share or stop splitting the rest.`);
  } else if (all.length && sum !== 100) {
    problems.push(sum < 100 ? `Total ${sum}% — add ${100 - sum}% to save.` : `Total ${sum}% — take off ${sum - 100}% to save.`);
  }
  // A person may be in one place only.
  const places = new Map();
  const place = (id, where) => places.set(Number(id), [...(places.get(Number(id)) || []), where]);
  members.forEach((m) => place(m.techId, 'named on their own'));
  groups.forEach((g) => {
    const info = groupsById.get(Number(g.groupId));
    list(info?.memberIds).forEach((id) => place(id, `in ${info.name}`));
  });
  if (evenly) restIds.forEach((id) => place(id, 'in the rest'));
  for (const [id, where] of places) {
    if (where.length > 1) problems.push(`${nameOf(id)} is on this rule more than once (${joinWords([...new Set(where)])}). Keep each person in one place.`);
  }
  if (draft?.mode !== 'off' && !hasShares(draft)) problems.push('Add the people who share the tickets before switching it on.');
  if (draft?.mode !== 'off' && !list(draft?.categoryIds).length) problems.push('Pick at least one category before switching it on.');
  return problems;
}

/** A rule's name: what the admin typed, else its categories ("Vendor Invoices"). */
export function ruleLabel(rule, categoryNames = new Map()) {
  if (rule?.name) return rule.name;
  const names = list(rule?.categoryIds).map((id) => categoryNames.get(Number(id))).filter(Boolean);
  if (!names.length) return 'New rule';
  return names.length <= 3 ? names.join(', ') : `${names.slice(0, 2).join(', ')} and ${names.length - 2} more`;
}

/** One line: "Juniors 50% · rest split evenly across 4 people". */
export function ruleSummary(rule, { groupsById = new Map(), nameOf = (id) => `Technician ${id}` } = {}) {
  const parts = [];
  for (const g of list(rule?.groups)) parts.push(`${groupsById.get(Number(g.groupId))?.name || 'A group'} ${g.pct}%`);
  const members = list(rule?.members);
  if (members.length && members.length <= 2) members.forEach((m) => parts.push(`${nameOf(m.techId)} ${m.pct}%`));
  else if (members.length) parts.push(`${plural(members.length, 'person', 'people')} ${sharesTotal(members)}%`);
  const restIds = list(rule?.rest?.techIds);
  if (restOn(rule) && restIds.length) parts.push(`rest split evenly across ${plural(restIds.length, 'person', 'people')}`);
  return parts.length ? parts.join(' · ') : 'Nobody yet';
}

/**
 * Which other rule holds each category (a category can be in one rule only).
 * @returns {Map<number, string>} category id → that rule's name
 */
export function categoryOwners(rules, exceptId, categoryNames = new Map()) {
  const owners = new Map();
  for (const r of list(rules)) {
    if (r.id === exceptId) continue;
    for (const id of list(r.categoryIds)) owners.set(Number(id), ruleLabel(r, categoryNames));
  }
  return owners;
}
