/**
 * Auto-help P1 (plans/AUTO_HELP_P1_PLAN.md §1–3): the vocabulary of what
 * happens to an answer after it is drafted, and the pure maths on top of it —
 * edit distance, the reply classifier's keyword fast path, the per-playbook
 * metrics and the server-enforced readiness gate for auto mode.
 *
 * No I/O here: the services load rows and call these; the tests pin the maths.
 *
 * Two separate facts per run (a run can have both):
 *   decision  what the agent did with the staged answer
 *             agent_sent | agent_edited_sent | agent_dismissed | auto_sent
 *   outcome   how the follow-up loop ended
 *             resolved_silence | resolved_confirmed | help_requested |
 *             reopened | agent_took_over | no_reply_left_open | loop_stopped
 */

export const DECISIONS = Object.freeze({
  SENT: 'agent_sent',
  EDITED_SENT: 'agent_edited_sent',
  DISMISSED: 'agent_dismissed',
  AUTO_SENT: 'auto_sent',
});
export const SENT_DECISIONS = Object.freeze([DECISIONS.SENT, DECISIONS.EDITED_SENT, DECISIONS.AUTO_SENT]);
export const APPROVE_SENT_DECISIONS = Object.freeze([DECISIONS.SENT, DECISIONS.EDITED_SENT]);

export const OUTCOMES = Object.freeze({
  RESOLVED_SILENCE: 'resolved_silence',
  RESOLVED_CONFIRMED: 'resolved_confirmed',
  HELP_REQUESTED: 'help_requested',
  REOPENED: 'reopened',
  AGENT_TOOK_OVER: 'agent_took_over',
  NO_REPLY_LEFT_OPEN: 'no_reply_left_open',
  // The loop could not go on safely (ticket deleted / spam / noise / merged,
  // moved off Pending, Auto-help or the playbook switched off or deleted):
  // woken like any park, nothing sent, nothing closed. outcomeDetail says why.
  LOOP_STOPPED: 'loop_stopped',
});
export const RESOLVED_OUTCOMES = Object.freeze([OUTCOMES.RESOLVED_SILENCE, OUTCOMES.RESOLVED_CONFIRMED]);
/**
 * Outcomes of a staged answer that was never sent (integration W1/W2), kept
 * out of OUTCOMES so the per-playbook loop metrics (sent answers only) are
 * unchanged:
 *   withdrawn      the morning settle recategorized the ticket (or judged it
 *                  noise / not actionable / an approval) — outcomeDetail.withdrawn.why
 *   superseded_by  a higher reply owner took the first reply (an agent's own
 *                  reply) — outcomeDetail.supersededBy
 */
export const PRE_SEND_OUTCOMES = Object.freeze({ WITHDRAWN: 'withdrawn', SUPERSEDED_BY: 'superseded_by' });
/** An outcome that closes the loop for good (a reopen can still follow a resolution). */
export const FINAL_OUTCOMES = Object.freeze([
  OUTCOMES.HELP_REQUESTED, OUTCOMES.REOPENED, OUTCOMES.AGENT_TOOK_OVER, OUTCOMES.NO_REPLY_LEFT_OPEN, OUTCOMES.LOOP_STOPPED,
  PRE_SEND_OUTCOMES.WITHDRAWN, PRE_SEND_OUTCOMES.SUPERSEDED_BY,
]);

export const DISMISS_REASONS = Object.freeze([
  { value: 'wrong_answer', label: 'Wrong answer' },
  { value: 'not_needed', label: 'Not needed' },
  { value: 'other', label: 'Other' },
]);
export const DISMISS_REASON_VALUES = Object.freeze(DISMISS_REASONS.map((r) => r.value));

/** Resolution marker on tickets.resolved_by_kind — excluded from agent closing numbers. */
export const AUTO_HELP_RESOLVED_KIND = 'auto_help';
/** A reopen within this long after an Auto-help resolution counts against the answer. */
export const REOPEN_WINDOW_MS = 7 * 24 * 3600e3;

// ---------- readiness gate (auto mode) ----------

export const READINESS = Object.freeze({
  minReviewed: 30,
  minGoodPct: 85,
  recentWindow: 30, // no "wrong" among the newest N reviews
  minApproveSends: 20,
  minUnchangedPct: 70,
  maxReopenPct: 5,
});

function pct(n, d) {
  return d ? Math.round((n / d) * 1000) / 10 : null;
}

/**
 * The auto-mode readiness gate for one playbook (plans/AUTO_HELP_P1_PLAN.md §3).
 * @param {object} input
 *   reviews   [{ verdict, reviewedAt }] — any order
 *   approve   { sends, unchanged, reopened } — approve-mode sends only
 *   sensitive boolean
 * @returns {{ met: boolean, criteria: Array<{ key, label, met, value, target, n }> }}
 */
export function evaluateReadiness({ reviews = [], approve = {}, sensitive = false, backtest = null } = {}, bar = READINESS) {
  const sorted = [...(reviews || [])]
    .filter((r) => r && r.verdict)
    .sort((a, b) => new Date(b.reviewedAt || 0).getTime() - new Date(a.reviewedAt || 0).getTime());
  const reviewed = sorted.length;
  const good = sorted.filter((r) => r.verdict === 'good').length;
  const recent = sorted.slice(0, bar.recentWindow);
  const recentWrong = recent.filter((r) => r.verdict === 'wrong').length;
  const sends = Number(approve.sends) || 0;
  const unchanged = Number(approve.unchanged) || 0;
  const reopened = Number(approve.reopened) || 0;
  const goodPct = pct(good, reviewed);
  const unchangedPct = pct(unchanged, sends);
  const reopenPct = pct(reopened, sends);

  const criteria = [
    { key: 'reviewed', label: `At least ${bar.minReviewed} reviewed shadow drafts`, value: reviewed, target: bar.minReviewed, n: reviewed, met: reviewed >= bar.minReviewed },
    { key: 'good', label: `At least ${bar.minGoodPct} % of them good`, value: goodPct, target: bar.minGoodPct, n: reviewed, met: reviewed > 0 && goodPct >= bar.minGoodPct },
    { key: 'no_recent_wrong', label: `No "wrong" in the last ${bar.recentWindow} reviews`, value: recentWrong, target: 0, n: recent.length, met: reviewed >= bar.minReviewed && recentWrong === 0 },
    { key: 'approve_sends', label: `At least ${bar.minApproveSends} approve-mode sends`, value: sends, target: bar.minApproveSends, n: sends, met: sends >= bar.minApproveSends },
    { key: 'unchanged', label: `At least ${bar.minUnchangedPct} % sent unchanged`, value: unchangedPct, target: bar.minUnchangedPct, n: sends, met: sends > 0 && unchangedPct >= bar.minUnchangedPct },
    { key: 'reopen', label: `Reopened at most ${bar.maxReopenPct} %`, value: reopenPct, target: bar.maxReopenPct, n: sends, met: sends > 0 && reopenPct <= bar.maxReopenPct },
    { key: 'not_sensitive', label: 'Not a sensitive playbook (password, MFA, access, security)', value: sensitive ? 'sensitive' : 'not sensitive', target: 'not sensitive', n: null, met: !sensitive },
  ];
  // Backtest reviews are shown next to the gate but never count toward it.
  const bt = backtest && typeof backtest === 'object' ? backtest : { reviewed: 0, good: 0 };
  return {
    met: criteria.every((c) => c.met),
    criteria,
    backtest: { reviewed: Number(bt.reviewed) || 0, good: Number(bt.good) || 0, goodPct: pct(Number(bt.good) || 0, Number(bt.reviewed) || 0), gating: false },
  };
}

/** Runs whose reviews and sends may gate approve/auto mode: never backtests or test runs. */
export const NON_GATING_TRIGGERS = Object.freeze(['backtest', 'test']);

/**
 * The evidence the readiness gate reads, from run rows
 * ({ trigger, playbookVersion, reviewVerdict, reviewedAt, decision, outcome }):
 * only the CURRENT playbook version counts (a new version — changed
 * instructions, scope, follow-up — starts from zero), and backtest / test
 * runs never gate (they are reported as a separate, non-gating line).
 */
export function readinessEvidence(rows = [], { currentVersion = null } = {}) {
  const hasVersion = currentVersion !== null && currentVersion !== undefined;
  const inVersion = (r) => !hasVersion || Number(r.playbookVersion) === Number(currentVersion);
  const list = (rows || []).filter((r) => r && inVersion(r));
  const gating = list.filter((r) => !NON_GATING_TRIGGERS.includes(r.trigger));
  const backtestReviewed = list.filter((r) => r.trigger === 'backtest' && r.reviewVerdict);
  const approveSent = gating.filter((r) => APPROVE_SENT_DECISIONS.includes(r.decision));
  return {
    reviews: gating.filter((r) => r.reviewVerdict).map((r) => ({ verdict: r.reviewVerdict, reviewedAt: r.reviewedAt })),
    approve: {
      sends: approveSent.length,
      unchanged: approveSent.filter((r) => r.decision === DECISIONS.SENT).length,
      reopened: approveSent.filter((r) => r.outcome === OUTCOMES.REOPENED).length,
    },
    backtest: { reviewed: backtestReviewed.length, good: backtestReviewed.filter((r) => r.reviewVerdict === 'good').length },
  };
}

// ---------- edit distance ----------

const WORD_CAP = 1500;

function words(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, ''))
    .filter(Boolean)
    .slice(0, WORD_CAP);
}

/**
 * Normalized word-level edit distance, 0 (same words) .. 1 (nothing kept).
 * Case, whitespace and surrounding punctuation are ignored, so re-flowing a
 * paragraph or fixing a comma is "unchanged"; swapping a step is not.
 */
export function editDistance(before, after) {
  const a = words(before);
  const b = words(after);
  if (!a.length && !b.length) return 0;
  if (!a.length || !b.length) return 1;
  let prev = new Array(b.length + 1);
  let cur = new Array(b.length + 1);
  for (let j = 0; j <= b.length; j += 1) prev[j] = j;
  for (let i = 1; i <= a.length; i += 1) {
    cur[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, cur] = [cur, prev];
  }
  return Math.round((prev[b.length] / Math.max(a.length, b.length)) * 1000) / 1000;
}

export function median(values = []) {
  const v = (values || []).map(Number).filter(Number.isFinite).sort((x, y) => x - y);
  if (!v.length) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 1000) / 1000;
}

// ---------- requester reply: keyword fast path ----------

// Where a reply's own words end and the quoted mail begins. Single-line
// markers; the multi-line ones (Gmail's wrapped "On … wrote:", Outlook's
// From/Sent header block) are found by quoteStartLine below.
const QUOTE_LINE = /^\s*(?:>|-{2,}\s*original message|_{5,}|get outlook for|sent from my\b)/i;
const GMAIL_ON = /^\s*on\b/i;
const GMAIL_WROTE = /^\s*on\b[\s\S]{0,400}?\bwrote\s*:/i;
const OUTLOOK_FROM = /^\s*from\s*:/i;
const OUTLOOK_NEXT = /^\s*(?:sent|date|to|cc|subject)\s*:/i;

function quoteStartLine(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (QUOTE_LINE.test(line)) return i;
    // Gmail wraps long attributions: "On Fri, 9 Oct 2026 at 10:00, Ticket Pulse <\nit@example.com> wrote:"
    if (GMAIL_ON.test(line) && GMAIL_WROTE.test(lines.slice(i, i + 4).join(' '))) return i;
    // Outlook header block: "From: …" followed by Sent:/Date:/To:/Subject: within a few lines.
    if (OUTLOOK_FROM.test(line) && lines.slice(i + 1, i + 5).some((l) => OUTLOOK_NEXT.test(l))) return i;
  }
  return -1;
}

/** The requester's own words: quoted history, Outlook/Gmail headers and "sent from" lines cut off. */
export function ownWords(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const cut = quoteStartLine(lines);
  return (cut >= 0 ? lines.slice(0, cut) : lines).join('\n').replace(/\s+/g, ' ').trim();
}

// Strict ALLOW-LIST (P1 audit, round 2): the WHOLE reply — quotes cut,
// trimmed, at most FAST_MAX_CHARS — must be one short confirmation, optionally
// with a thanks, e.g. "That worked, thanks!", "All sorted, cheers",
// "Fixed, thank you", "Works now, thanks!". Anything else (a second clause,
// a device, a time, a "but") is the model's call; the model's doubt is a person.
const CONFIRM_CORE = String.raw`(?:(?:yes|yep|great|perfect|brilliant|awesome|excellent|lovely|ok(?:ay)?)[,!.]?\s+)?(?:(?:that|it|this)\s+(?:worked|works(?:\s+now)?|did\s+the\s+trick|fixed\s+it|sorted\s+it)|works\s+now|working\s+now|(?:all\s+)?sorted(?:\s+now)?|(?:all\s+)?fixed(?:\s+now)?|(?:all\s+)?resolved(?:\s+now)?|all\s+good(?:\s+now)?|got\s+it\s+working|(?:you\s+can|please|feel\s+free\s+to)\s+close\s+(?:it|this|the\s+ticket|this\s+ticket))`;
const THANKS = String.raw`(?:thanks(?:\s+(?:so|very)\s+much|\s+a\s+lot)?|thank\s+you(?:\s+(?:so|very)\s+much)?|cheers|ta|many\s+thanks|much\s+appreciated|appreciate\s+it)`;
const CONFIRM_ONLY = new RegExp(String.raw`^(?:${THANKS}[,!.]*\s+)?${CONFIRM_CORE}(?:[,!.;]*\s*${THANKS})?[\s!.:)]*$`, 'i');
// Veto words, belt and braces on top of the allow-list: negations (with and
// without apostrophes), trouble, time and contrast words.
export const TROUBLE_TOKENS = /(?:\b(?:no|not|never|nothing|nope|yet|broken|again|still|help|sorry|issues?|problems?|errors?|fail\w*|but|however|though|although|except|only|colleague|anymore|stopped|crash(?:es|ed|ing)?|froze|frozen|freez\w*|dead|came\s+back|then|until|wait|actually|other|isnt|wont|doesnt|cant|didnt|dont|havent|arent|wasnt|couldnt|shouldnt|wouldnt|hasnt)\b|n['’]t\b|\?)/i;
const FAST_MAX_CHARS = 60;

/**
 * Cheap first pass over a requester's reply to an Auto-help answer. It only
 * ever CONFIRMS, and only when the whole reply is one short confirmation
 * (plus a thanks) from the allow-list. Everything else returns null: the
 * model decides, and when the model can't (error, budget cap, "unclear") a
 * person does.
 * @returns {'confirmed' | null}
 */
export function classifyReplyFast(text) {
  const own = ownWords(text).replace(/[‘’]/g, "'").trim();
  if (!own || own.length > FAST_MAX_CHARS) return null;
  if (TROUBLE_TOKENS.test(own)) return null;
  return CONFIRM_ONLY.test(own) ? 'confirmed' : null;
}

// ---------- per-playbook metrics (team-safe: per playbook, never per person) ----------

/**
 * Metrics for one playbook from its run rows (minimal columns).
 * rows: [{ decision, editDistance, dismissReason, outcome, gateDecision, costUsd, inputTokens, outputTokens,
 *          createdAt, reviewVerdict, reviewedAt, ticketId }]
 * csatByTicket: Map<ticketId, { score, total }> for Auto-help-resolved tickets.
 */
export function playbookMetrics(rows = [], { csatByTicket = new Map(), sensitive = false, monthStart = null, followUpCost = null, currentVersion = null } = {}) {
  const sentRows = rows.filter((r) => SENT_DECISIONS.includes(r.decision));
  const approveSent = rows.filter((r) => APPROVE_SENT_DECISIONS.includes(r.decision));
  const unchanged = rows.filter((r) => r.decision === DECISIONS.SENT).length;
  const edited = rows.filter((r) => r.decision === DECISIONS.EDITED_SENT);
  const dismissed = rows.filter((r) => r.decision === DECISIONS.DISMISSED);
  const staged = rows.filter((r) => r.gateDecision === 'staged_for_agent').length;
  const decided = approveSent.length + dismissed.length;
  const count = (o) => sentRows.filter((r) => r.outcome === o).length;
  const outcomes = {};
  for (const o of Object.values(OUTCOMES)) outcomes[o] = { n: count(o), pct: pct(count(o), sentRows.length) };
  const waiting = sentRows.filter((r) => !r.outcome).length;

  // CSAT on tickets Auto-help resolved (and that stayed resolved) — always with N.
  const scores = [];
  for (const r of sentRows) {
    if (!RESOLVED_OUTCOMES.includes(r.outcome)) continue;
    const c = csatByTicket.get(r.ticketId);
    if (c && Number.isFinite(Number(c.score))) scores.push({ score: Number(c.score), total: Number(c.total) || 4 });
  }
  // "Satisfied" = at least three quarters of the scale (3 of 4, 4 of 5).
  const csat = scores.length
    ? {
      n: scores.length,
      avg: Math.round((scores.reduce((s, x) => s + x.score, 0) / scores.length) * 10) / 10,
      outOf: scores[0].total,
      satisfied: scores.filter((x) => x.score / (x.total || 4) >= 0.75).length,
    }
    : { n: 0, avg: null, outOf: 4, satisfied: 0 };

  const costed = rows.filter((r) => Number.isFinite(Number(r.costUsd)) && r.costUsd !== null);
  const tokened = rows.filter((r) => Number(r.inputTokens) || Number(r.outputTokens));
  // Reply checks after the send are booked in their own month (auto_help_cost_entries).
  const extraTotal = Number(followUpCost?.totalUsd) || 0;
  const extraMonth = Number(followUpCost?.monthUsd) || 0;
  const costTotal = costed.reduce((s, r) => s + Number(r.costUsd), 0) + extraTotal;
  const monthRows = monthStart ? costed.filter((r) => new Date(r.createdAt) >= monthStart) : [];
  const round4 = (x) => Math.round(x * 10000) / 10000;

  const readiness = evaluateReadiness({ ...readinessEvidence(rows, { currentVersion }), sensitive });

  return {
    staged,
    sent: sentRows.length,
    waiting,
    outcomes,
    approve: {
      decided,
      unchanged: { n: unchanged, pct: pct(unchanged, decided) },
      edited: { n: edited.length, pct: pct(edited.length, decided), medianEditDistance: median(edited.map((r) => r.editDistance)) },
      dismissed: {
        n: dismissed.length,
        pct: pct(dismissed.length, decided),
        reasons: Object.fromEntries(DISMISS_REASON_VALUES.map((v) => [v, dismissed.filter((r) => r.dismissReason === v).length])),
      },
    },
    csat,
    cost: {
      runsWithCost: costed.length,
      totalUsd: round4(costTotal),
      perRunUsd: costed.length ? round4(costTotal / costed.length) : null,
      monthUsd: round4(monthRows.reduce((s, r) => s + Number(r.costUsd), 0) + extraMonth),
      followUpUsd: round4(extraTotal),
      monthRuns: monthRows.length,
      inputTokens: tokened.reduce((s, r) => s + (Number(r.inputTokens) || 0), 0),
      outputTokens: tokened.reduce((s, r) => s + (Number(r.outputTokens) || 0), 0),
    },
    readiness,
  };
}

/** Start of the current calendar month (UTC) — the cost cap's window. */
export function monthStartUtc(now = new Date()) {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

// ---------- out-of-office / auto-replies ----------

const AUTO_REPLY_SUBJECT = /^\s*(?:(?:re|aw|fw|fwd)\s*:\s*)*(?:automatic reply|auto(?:matic|mated)?[- ]?(?:reply|response)|out of (?:the )?office|ooo\b|absence|away from (?:the )?office)/i;

/**
 * An out-of-office / automatic reply stored as a requester reply. It is not
 * an answer to the Auto-help message. Mail headers are authoritative when the
 * thread entry kept them (Auto-Submitted, X-Autoreply, X-Autorespond,
 * Precedence). Without headers the TEXT must be nothing but out-of-office
 * wording: one "I'm out of the office / on leave / away (until <date>)"
 * sentence plus boilerplate (thanks for your e-mail, limited access, who to
 * contact, back on, a sign-off). Any other sentence, a question mark, or an
 * intent / problem word in the date part ("… until Friday, can someone test
 * it", "… so I'll try it then") makes it a real reply. A subject alone
 * ("Automatic reply: …") only counts when the body is empty.
 */
export function isAutoReplyEntry(entry) {
  if (!entry) return false;
  const raw = entry.rawPayload && typeof entry.rawPayload === 'object' ? entry.rawPayload : {};
  const headers = raw.headers && typeof raw.headers === 'object' ? raw.headers : raw;
  const h = (name) => {
    const key = Object.keys(headers).find((k) => k.toLowerCase().replace(/[-_]/g, '') === name);
    return key ? String(headers[key] ?? '').toLowerCase().trim() : '';
  };
  const autoSubmitted = h('autosubmitted');
  if (autoSubmitted && autoSubmitted !== 'no') return true;
  if (h('xautoreply') || h('xautorespond') || h('xautoresponse')) return true;
  if (['auto_reply', 'bulk', 'junk'].includes(h('precedence'))) return true;
  const subject = String(entry.title || raw.subject || '').trim();
  const own = ownWords(entry.bodyText || entry.content || '').replace(/[‘’]/g, "'").trim();
  if (!own) return Boolean(subject) && AUTO_REPLY_SUBJECT.test(subject);
  return oooOnlyText(own);
}

const OOO_SENTENCE = /^(?:automatic reply|auto[- ]?reply|out of (?:the )?office(?: reply)?)?\s*(?:thank you for your (?:e-?mail|message)\s*)?(?:i am|i'm|im)?\s*(?:currently\s+)?(?:out of (?:the )?office|on (?:annual |parental |sick |vacation |holiday )?leave|on (?:vacation|holiday)|away(?: from (?:the|my) (?:office|desk))?)(?:\s+(?:until|till|returning|and returning on|back on|from)\s+(.{0,60}?))?(?:\s*,?\s*with (?:limited|no) access to (?:e-?mail|email|my e-?mail))?$/i;
const OOO_BOILERPLATE = [
  /^(?:automatic reply|auto[- ]?reply|out of (?:the )?office(?: reply)?)$/i,
  /^thank(?:s| you) for your (?:e-?mail|message)$/i,
  /^i (?:will|shall) (?:have (?:limited|no) access to (?:e-?mail|email|my e-?mail)|(?:respond|reply|get back to you)(?: [a-z ]{0,40})?|be back (?:on|in the office on) [\w ,/-]{0,30})$/i,
  /^(?:for (?:urgent|immediate) (?:matters|issues|requests|queries|assistance)|in my absence|if (?:it is |this is )?urgent)[, ][^?]{0,120}$/i,
  /^(?:i will be )?(?:back|returning)(?: in the office)? on [\w ,/-]{1,30}$/i,
  /^(?:kind |best |warm )?regards(?:[, ][a-z ]{0,40})?$/i,
  /^[a-z]+(?: [a-z]+){0,2}$/i, // a signature name, validated below against intent words
];
const OOO_INTENT = /\b(?:can|could|please|someone|try|trying|tried|test|tested|testing|works?|worked|working|fixed|fix|broken|still|not|no|issues?|problems?|help|error|crash\w*|fail\w*|sorted|thanks?|cheers|so|but|then)\b/i;

function oooOnlyText(own) {
  if (own.includes('?')) return false;
  const sentences = own.split(/[.!;:\n]+/).map((x) => x.trim().replace(/[,\s]+$/, '')).filter(Boolean);
  if (!sentences.length) return false;
  let sawOoo = false;
  for (const sentence of sentences) {
    const m = OOO_SENTENCE.exec(sentence);
    if (m) {
      if (m[1] && OOO_INTENT.test(m[1])) return false; // "until Friday, can someone test it"
      sawOoo = true;
      continue;
    }
    const boiler = OOO_BOILERPLATE.findIndex((re) => re.test(sentence));
    if (boiler < 0) return false;
    // A bare short line counts as a signature only when it carries no intent words.
    if (boiler === OOO_BOILERPLATE.length - 1 && OOO_INTENT.test(sentence)) return false;
  }
  return sawOoo;
}
