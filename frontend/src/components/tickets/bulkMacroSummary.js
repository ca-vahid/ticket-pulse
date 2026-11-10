/**
 * Helpers for the bulk-bar Macros confirm (QA 11-09 #9): chunking the
 * selection for the server, merging the per-chunk summaries it returns, and
 * turning the summary into the plain lines the confirm shows.
 */

// The server takes up to 50 per call. Apply goes in smaller steps so the bar
// can say how far it has got and no single request runs long.
export const PREVIEW_CHUNK = 50;
export const APPLY_CHUNK = 10;

export const chunk = (ids, size) => {
  const out = [];
  for (let i = 0; i < ids.length; i += size) out.push(ids.slice(i, i + size));
  return out;
};
export const ticketsLabel = (n) => `${n} ticket${n === 1 ? '' : 's'}`;
const refList = (refs) => {
  const shown = refs.filter(Boolean).slice(0, 3).join(', ');
  const more = refs.length - Math.min(refs.length, 3);
  return shown ? ` (${shown}${more > 0 ? ` +${more}` : ''})` : '';
};

/** Several chunk summaries from the server, as one. */
export function mergeBulkSummaries(summaries) {
  const out = { total: 0, willRun: 0, replies: 0, nothingToDo: [], unavailable: [], skips: [], notices: [] };
  const skips = new Map();
  const notices = new Map();
  for (const s of summaries.filter(Boolean)) {
    out.total += s.total || 0;
    out.willRun += s.willRun || 0;
    out.replies += s.replies || 0;
    out.nothingToDo.push(...(s.nothingToDo || []));
    out.unavailable.push(...(s.unavailable || []));
    for (const g of s.skips || []) {
      const key = `${g.type}|${g.reason || ''}`;
      if (!skips.has(key)) skips.set(key, { ...g, refs: [] });
      skips.get(key).refs.push(...(g.refs || []));
    }
    for (const g of s.notices || []) {
      if (!notices.has(g.notice)) notices.set(g.notice, { ...g, refs: [] });
      notices.get(g.notice).refs.push(...(g.refs || []));
    }
  }
  const counted = (m) => [...m.values()].map((g) => ({ ...g, count: g.refs.length })).sort((a, b) => b.count - a.count);
  out.skips = counted(skips);
  out.notices = counted(notices);
  return out;
}

/** The plain-language lines the confirm shows: { tone, text }. */
export function summaryLines(summary) {
  if (!summary) return [];
  const lines = [];
  const nothing = summary.nothingToDo.length;
  lines.push({
    tone: 'run',
    text: summary.willRun === 0
      ? `Nothing to do on ${summary.total === 1 ? 'this ticket' : `these ${summary.total} tickets`}.`
      : `Will run on ${ticketsLabel(summary.willRun)}${nothing ? `; nothing to do on ${nothing}${refList(summary.nothingToDo)}` : ''}.`,
  });
  for (const g of summary.skips) {
    lines.push({ tone: 'skip', text: `On ${g.count}${refList(g.refs)}, “${g.summary}” is skipped${g.reason ? `: ${g.reason}` : ''}.` });
  }
  for (const g of summary.notices) {
    lines.push({ tone: 'notice', text: `On ${g.count}${refList(g.refs)}: ${g.notice}` });
  }
  if (summary.unavailable.length) {
    const first = summary.unavailable[0];
    lines.push({ tone: 'error', text: `${ticketsLabel(summary.unavailable.length)} could not be checked and will be left alone${first?.error ? `: ${first.error}` : ''}.` });
  }
  if (summary.replies > 0) {
    lines.push({ tone: 'mail', text: summary.replies === 1 ? 'The reply goes to that ticket’s own requester.' : `Each of the ${summary.replies} replies goes to its own ticket’s requester, one message per ticket.` });
  }
  return lines;
}
