/**
 * Words for Knowledge → Answering (the dial per category). Pure.
 */
export const LEVEL_LABELS = Object.freeze({
  off: 'Off',
  draft: 'Draft only',
  suggest: 'Suggest to agent',
  send: 'Send when sure',
});

export const LEVEL_HINTS = Object.freeze({
  off: 'Auto-help never drafts here',
  draft: 'Recorded and shown on the ticket; nothing goes out',
  suggest: 'A ready reply waits for an agent to send or edit',
  send: 'Sends by itself when the answer is sure',
});

export function levelLabel(level) {
  return LEVEL_LABELS[level] || LEVEL_LABELS.draft;
}

/**
 * The options of one dial select. The first one clears the row back to
 * "follow the row above"; "Send when sure" is offered but disabled, with the
 * reason, until the category may use it.
 */
export function levelOptions({ inherited = 'draft', parentName = null, canSend = false, sendLockedWhy = null } = {}) {
  return [
    ...(parentName ? [{ value: '', label: `Same as ${parentName}`, hint: levelLabel(inherited) }] : []),
    ...['off', 'draft', 'suggest', 'send'].map((value) => ({
      value,
      label: LEVEL_LABELS[value],
      hint: value === 'send' && !canSend ? (sendLockedWhy || 'Not earned yet') : LEVEL_HINTS[value],
      disabled: value === 'send' && !canSend,
    })),
  ];
}

const criterion = (readiness, key) => (readiness?.criteria || []).find((c) => c.key === key) || null;

/** Where a category stands toward "Send when sure": { tone, words }. */
export function readinessState(category) {
  if (category?.resolved?.alwaysChecked) return { tone: 'locked', words: 'Always checked by a person' };
  const readiness = category?.readiness;
  if (readiness?.met) return { tone: 'ready', words: 'Earned' };
  const reviewed = criterion(readiness, 'reviewed');
  if (!reviewed || !Number(reviewed.value)) return { tone: 'none', words: 'No reviewed answers yet' };
  return { tone: 'progress', words: `${reviewed.value} of ${reviewed.target} reviewed` };
}

/** The short line under an unearned category: what is still missing. */
export function progressWords(readiness) {
  const good = criterion(readiness, 'good');
  const sends = criterion(readiness, 'approve_sends');
  const wrong = criterion(readiness, 'no_recent_wrong');
  const parts = [];
  if (good && good.value !== null && Number(good.n) > 0) parts.push(`${good.value} % good (needs ${good.target} %)`);
  if (wrong && Number(wrong.value) > 0) parts.push(`${wrong.value} marked wrong recently`);
  if (sends) parts.push(`${sends.value} of ${sends.target} sent by agents`);
  return parts.join(' · ');
}

/** What a run did, from its evidence ({ action: { level, ceiling, reason } }). */
export function actionWords(evidence) {
  const action = evidence?.action;
  if (!action) return null;
  const why = {
    as_set: null,
    one_step_down: 'one level down: the answer was not fully sure',
    recorded_only: 'recorded only: the answer was doubtful',
    not_earned: 'suggested: this category has not earned sending yet',
    always_checked: 'suggested: this category is always checked by a person',
    not_eligible: 'suggested: the answer was not complete enough to send',
    category_off: 'off for this category',
    probe: 'a test run',
    not_drafted: null,
  }[action.reason] ?? null;
  return { level: levelLabel(action.level), ceiling: levelLabel(action.ceiling), why };
}

export const BAND_LABELS = Object.freeze({ high: 'Sure', medium: 'Fairly sure', low: 'Doubtful' });
