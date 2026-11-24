/**
 * The assignment rules' own sentences on a run (QA 11-23 #6): Level match's
 * move or keep sentence, and the same-day follow-up routing ("Would send to
 * Eli Park: same problem as TP-1042 reported today."). B2 writes the
 * sentences; this only finds them and says whether anything changed.
 *
 * Level match: `run.recommendation.levelMatch` (also a `level_match` step when
 * it would move). Follow-up: `run.recommendation.followUpRouting` (also a
 * `followup_routing` step when it would move); older spellings are read too.
 * Repeat report: `run.recommendation.repeatReport`.
 */

const FOLLOW_UP_KEYS = ['followUp', 'followUpRouting', 'followupRouting', 'sameDayFollowUp'];
const FOLLOW_UP_KINDS = new Set(['follow_up', 'followup', 'follow_up_routing', 'followup_routing', 'same_day_follow_up']);

const text = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);

function stepRecord(run, match) {
  const steps = Array.isArray(run?.steps) ? run.steps : [];
  const step = steps.find((s) => s?.output && typeof s.output === 'object' && match(s));
  return step ? step.output : null;
}

const NOT_APPLIED_WORDS = {
  dry_run: 'this was a test run',
  locked: 'an earlier rule had already chosen the person',
  suggest_only: 'the run only suggested a person; it did not assign',
};

/** "Shadow: nothing was changed." / "Not applied: …" / null when it acted. */
function modeNote(record) {
  const mode = String(record?.mode || '').toLowerCase();
  if (mode === 'shadow') return 'Shadow: nothing was changed.';
  if (mode === 'live' && record.applied === false && record.outcome && /move|rout/i.test(String(record.outcome))) {
    const code = text(record.notAppliedReason);
    const why = (code && (NOT_APPLIED_WORDS[code] || code.replace(/_/g, ' '))) || (record.locked ? NOT_APPLIED_WORDS.locked : null);
    return why ? `Not applied: ${why}.` : 'Not applied.';
  }
  return null;
}

/**
 * @returns Array<{ key, label, sentence, note, extra: string[] }>
 */
export function assignmentRuleLines(run) {
  const rec = run?.recommendation && typeof run.recommendation === 'object' ? run.recommendation : {};
  const lines = [];

  const level = (rec.levelMatch && typeof rec.levelMatch === 'object' ? rec.levelMatch : null)
    || stepRecord(run, (s) => s.stepName === 'level_match' || s.output.kind === 'level_match');
  if (level && text(level.sentence)) {
    const skipped = Array.isArray(level.skipped) ? level.skipped : [];
    lines.push({
      key: 'level_match',
      label: 'Level match',
      sentence: text(level.sentence),
      note: modeNote(level),
      // Who else was passed over, beyond the one the sentence already names.
      extra: skipped.slice(1).map((s) => text(s?.sentenceTail) || text(s?.reason)).filter(Boolean),
    });
  }

  const followKey = FOLLOW_UP_KEYS.find((k) => rec[k] && typeof rec[k] === 'object');
  const follow = (followKey ? rec[followKey] : null)
    || stepRecord(run, (s) => FOLLOW_UP_KINDS.has(String(s.output.kind || s.stepName || '')));
  if (follow && text(follow.sentence)) {
    lines.push({
      key: 'follow_up',
      label: 'Same-day follow-up',
      sentence: text(follow.sentence),
      note: modeNote(follow),
      extra: [follow.applied === true ? 'A private note on the ticket suggests merging the two.' : null].filter(Boolean),
      relatedTicketId: follow.relatedTicketId || null,
      relatedRef: text(follow.relatedRef),
    });
  }

  // The same-day repeat priority bump (it raises whatever the routing mode).
  const repeat = rec.repeatReport && typeof rec.repeatReport === 'object' ? rec.repeatReport : null;
  if (repeat && text(repeat.sentence)) {
    lines.push({
      key: 'repeat_report',
      label: 'Repeat report',
      sentence: text(repeat.sentence),
      note: null,
      extra: [],
      relatedTicketId: repeat.relatedTicketId || null,
      relatedRef: text(repeat.relatedRef),
    });
  }
  return lines;
}
