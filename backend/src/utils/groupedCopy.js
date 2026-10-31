/**
 * A grouped copy is the same alert or request arriving again, folded into the
 * first ticket by ticket grouping. It is stored as noise ("Grouped: same request
 * as TP-n") so queues and the pipeline skip it, but in Analytics it is a repeat,
 * not junk: counted on its own line so the noise share means junk only
 * (Vahid, 31 Oct 2026).
 */
export const GROUPED_COPY_PREFIX = 'Grouped:';

export function isGroupedCopy(ticket) {
  return String(ticket?.noiseRuleMatched || '').startsWith(GROUPED_COPY_PREFIX);
}

export const GROUPED_COPY_WHERE = Object.freeze({ noiseRuleMatched: { startsWith: GROUPED_COPY_PREFIX } });

export const NOT_GROUPED_COPY_WHERE = Object.freeze({
  OR: [{ noiseRuleMatched: null }, { NOT: { noiseRuleMatched: { startsWith: GROUPED_COPY_PREFIX } } }],
});

export function shareOf(count, total) {
  return { count, pct: total ? Number(((count / total) * 100).toFixed(1)) : 0 };
}
