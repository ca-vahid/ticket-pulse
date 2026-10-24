/** Plain helpers for Knowledge -> Settings -> Confluence (QA 10-23 #4). No components. */
import { timeAgo } from '../tickets/ticketUi';

export const IMPORT_ACTIVE = new Set(['queued', 'running']);
const plural = (n, word, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;
const num = (n) => Number(n || 0).toLocaleString('en-US');

export const RUN_KIND_WORDS = Object.freeze({ analyze: 'Looked at the pages', import: 'One-time import', nightly: 'Nightly check' });
export const RUN_STATUS_WORDS = Object.freeze({ running: 'Running', done: 'Done', failed: 'Failed', skipped: 'Skipped' });
export const SKIP_REASON_WORDS = Object.freeze({
  no_connection: 'not connected to Confluence',
  no_selection: 'no spaces or sections picked',
  import_first: 'the one-time import has not run yet',
});
export const LABEL_WORDS = Object.freeze({
  technical_solutions: 'Technical solutions',
  policy: 'Policy',
  meeting_notes: 'Meeting notes',
  project_docs: 'Project docs',
  stale: 'Stale',
  other: 'Other',
});

/** "3 new, 1 repeat, 2 skipped (view limits)" for one run's counts. */
export function runCounts(run) {
  const c = run?.counts || {};
  if (run?.status === 'skipped') return SKIP_REASON_WORDS[c.reason] ? `Skipped: ${SKIP_REASON_WORDS[c.reason]}.` : 'Skipped.';
  const parts = run?.kind === 'analyze'
    ? [c.pagesSeen !== undefined ? `${plural(c.pagesSeen, 'page')} read` : null, c.labelled ? `${c.labelled} sections labelled` : null]
    : run?.kind === 'import'
      ? [
        `${c.created || 0} new`,
        c.mergeSuggested ? `${plural(c.mergeSuggested, 'repeat')} sent to the Inbox` : null,
        c.alreadyImported ? `${c.alreadyImported} already in` : null,
        c.restricted ? `${c.restricted} skipped (view limits)` : null,
        c.empty ? `${c.empty} empty` : null,
        c.failed ? `${c.failed} failed` : null,
        c.overLimit ? `${c.overLimit} left for the next run` : null,
      ]
      : [
        `${c.changed || 0} changed`, `${c.newPages || 0} new`, `${c.retired || 0} gone`,
        c.editedInTp ? `${c.editedInTp} also edited here` : null,
        c.failed ? `${c.failed} failed` : null,
        c.deferred ? `${c.deferred} left for tomorrow` : null,
        c.retireSkipped ? 'nothing retired (Confluence did not list everything)' : null,
      ];
  const owners = c.noSkilledOwner ? ` ${plural(c.noSkilledOwner, 'page')} went to a category where nobody has Intermediate.` : '';
  const text = parts.filter(Boolean).join(', ');
  return `${text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}.` : ''}${owners}`.trim();
}

/** "Importing… 40 of 120 pages" while the job runs; the result once it ends. */
export function importLine(state) {
  if (!state) return 'Not imported yet.';
  if (IMPORT_ACTIVE.has(state.status)) {
    const p = state.progress || {};
    return state.status === 'queued' || !p.total ? 'Starting the import…' : `Importing… ${p.done || 0} of ${plural(p.total, 'page')}`;
  }
  const when = state.at ? timeAgo(state.at) : '';
  if (state.status === 'interrupted' || state.status === 'failed') return `The last import stopped ${when}: ${state.error || 'run it again'}.`;
  return `Last import ${when}: ${runCounts({ kind: 'import', counts: state.counts })}`;
}

export function money(usd) {
  const v = Number(usd);
  if (usd === null || usd === undefined || !Number.isFinite(v)) return null;
  return v > 0 && v < 0.01 ? 'under US$0.01' : `US$${v.toFixed(2)}`;
}

/** "12 pages · 3,400 words · updated 2 months ago" */
export function nodeStats(node) {
  if (!node) return '';
  return [plural(node.pages || 1, 'page'), `${num(node.subtreeWords ?? node.words)} words`, node.lastUpdated ? `updated ${timeAgo(node.lastUpdated)}` : null].filter(Boolean).join(' · ');
}

// ---------------------------------------------------------------- selection

export const emptySelection = () => ({ spaces: [], include: [], exclude: [], wholeSpaces: [], includeRestricted: false });

export function normalizeSelection(sel) {
  const s = sel || {};
  return {
    spaces: Array.isArray(s.spaces) ? s.spaces : [],
    include: Array.isArray(s.include) ? s.include.map(String) : [],
    exclude: Array.isArray(s.exclude) ? s.exclude.map(String) : [],
    wholeSpaces: Array.isArray(s.wholeSpaces) ? s.wholeSpaces.map(String) : [],
    includeRestricted: s.includeRestricted === true,
  };
}

/** Map(pageId -> parentId) for every node of the analyzed trees. */
export function parentMap(spaces = []) {
  const map = new Map();
  const walk = (nodes, parent) => { for (const n of nodes || []) { map.set(String(n.id), parent); walk(n.children, String(n.id)); } };
  for (const s of spaces) walk(s.tree, null);
  return map;
}

/** The same rule as the server: the nearest ticked / unticked ancestor decides, else the whole space. */
export function isPicked(id, parents, sel, spaceId) {
  const seen = new Set();
  let cur = String(id);
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    if (sel.exclude.includes(cur)) return false;
    if (sel.include.includes(cur)) return true;
    cur = parents.get(cur) || null;
  }
  return sel.wholeSpaces.includes(String(spaceId));
}

/** Tick or untick one section (its descendants follow; their own marks are cleared). */
export function toggleNode(sel, node, parents, spaceId) {
  const id = String(node.id);
  const below = new Set();
  const walk = (n) => { for (const c of n.children || []) { below.add(String(c.id)); walk(c); } };
  walk(node);
  const picked = isPicked(id, parents, sel, spaceId);
  const keep = (list) => list.filter((x) => x !== id && !below.has(x));
  const next = { ...sel, include: keep(sel.include), exclude: keep(sel.exclude) };
  // With its own mark gone it follows its ancestors; mark it only when that is not what we want.
  const want = !picked;
  if (isPicked(id, parents, next, spaceId) !== want) {
    if (want) next.include = [...next.include, id];
    else next.exclude = [...next.exclude, id];
  }
  return next;
}

/** Pages picked in the analyzed trees. */
export function countPicked(spaces, sel) {
  const parents = parentMap(spaces);
  let n = 0;
  const walk = (nodes, spaceId) => { for (const node of nodes || []) { if (isPicked(node.id, parents, sel, spaceId)) n += 1; walk(node.children, spaceId); } };
  for (const s of spaces || []) walk(s.tree, s.id);
  return n;
}

export function sameSelection(a, b) {
  const key = (s) => {
    const n = normalizeSelection(s);
    return JSON.stringify([n.spaces.map((x) => String(x.id)).sort(), [...n.include].sort(), [...n.exclude].sort(), [...n.wholeSpaces].sort(), n.includeRestricted]);
  };
  return key(a) === key(b);
}

/** "2 spaces, 5 sections picked" for people who can only read. */
export function selectionLine(sel) {
  const s = normalizeSelection(sel);
  if (!s.spaces.length) return 'No spaces picked yet.';
  const parts = [plural(s.spaces.length, 'space')];
  if (s.wholeSpaces.length) parts.push(`${s.wholeSpaces.length} whole`);
  if (s.include.length) parts.push(plural(s.include.length, 'section'));
  if (s.exclude.length) parts.push(`${s.exclude.length} left out`);
  return `${parts.join(', ')} picked.`;
}
