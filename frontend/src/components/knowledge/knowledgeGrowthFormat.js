/** Plain helpers for the Knowledge growth pieces (Auto-help P1): gaps, backtests, drafts. No components. */

export const GAP_REASON_WORDS = Object.freeze({
  no_sources: 'nothing in Knowledge matched',
  no_grounded_source: 'no article to cite',
  insufficient_context: 'only partly covered by articles',
  uncited_step: 'a step had no source',
  model_declined: 'not answered by what was found',
  not_picked_up: 'not picked up by the playbook\'s keywords',
});

/** "3 not picked up by the playbook's keywords · 2 nothing in Knowledge matched" — the two biggest reasons. */
export function reasonLine(reasons = {}) {
  return Object.entries(reasons || {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 2)
    .map(([code, n]) => `${n} ${GAP_REASON_WORDS[code] || code.replace(/_/g, ' ')}`)
    .join(' · ');
}

export const BACKTEST_DEFAULT_N = 20;
export const BACKTEST_MAX_N = 50;

export function money(usd) {
  const v = Number(usd);
  if (usd === null || usd === undefined || !Number.isFinite(v)) return '—';
  if (v > 0 && v < 0.01) return 'under US$0.01';
  return `US$${v.toFixed(2)}`;
}

/** "about US$0.43 (≈ US$0.02 a run, from 42 recent runs)" */
export function estimateLine(est) {
  if (!est) return '';
  const basis = est.basis === 'history'
    ? `≈ ${money(est.perRunUsd)} a run, from ${est.sampleRuns} recent run${est.sampleRuns === 1 ? '' : 's'}`
    : `≈ ${money(est.perRunUsd)} a run at ${est.model || 'the Auto-help model'}'s list price`;
  return `about ${money(est.totalUsd)} (${basis})`;
}

export const MAX_PICKED = 12;

/** "TP-12, #241406 and 55" -> ['TP-12', '#241406', '55'] (deduped; one past MAX_PICKED so the UI can say "too many"). */
export function parseTicketRefs(text) {
  const out = [];
  for (const raw of String(text || '').split(/[\s,;]+/)) {
    const ref = raw.trim();
    if (!ref || !/^(?:TP-\d+|#?\d+)$/i.test(ref)) continue;
    const norm = ref.toUpperCase();
    if (!out.includes(norm)) out.push(norm);
    if (out.length > MAX_PICKED) break;
  }
  return out;
}

/**
 * Schema field names a model once echoed into reviewer notes ("doesNotApply
 * is thin") read as words. The server does this for new drafts; this covers
 * drafts saved before it did.
 */
export function readableNotes(text) {
  return String(text || '')
    .replace(/\bdoes_?not_?apply\b/gi, 'When this doesn\u2019t apply')
    .replace(/\bused_?ticket_?ids\b/gi, 'the source tickets')
    .replace(/\breviewer_?notes\b/gi, 'these notes');
}
