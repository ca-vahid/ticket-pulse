/**
 * Approve with conditions, as a conversation (Vahid, 26 Oct 2026).
 *
 * An approver who approves "with conditions" no longer closes the request.
 * The conditions become separate items the technician who asked answers one
 * by one ("can be met" + how, or "can't be met as asked" + why). The answers
 * go straight back to the approver, who approves (accepting them), sends
 * changed conditions back, asks someone, or does not approve. Only then is
 * the request approved, and the agreed conditions travel with the verdict.
 *
 * Stored on ticket_approvals.conditions (JSONB):
 *   { round, setBy, setByName, setAt,
 *     items: [{ id, text, response: 'can_meet'|'cant_meet'|null, answer, answeredBy, answeredByName, answeredAt }],
 *     submittedAt, submittedBy, submittedByName }
 * The row is info_requested while IT answers and pending once the answers
 * are in, so every surface that already knows those states keeps working.
 */

export const RESPONSES = ['can_meet', 'cant_meet'];
export const MAX_CONDITIONS = 20;
const MAX_TEXT = 2000;
const MAX_ANSWER = 4000;

const clean = (v, max) => String(v ?? '').replace(/\r\n?/g, '\n').replace(/[ \t]+/g, ' ').trim().slice(0, max);
const key = (text) => clean(text, MAX_TEXT).toLowerCase().replace(/\s+/g, ' ');

/**
 * One block of text as a list of conditions: bullet, dash or numbered lines
 * start a new condition; other lines continue the one above. Text with no
 * list markers at all is one condition per non-empty line.
 */
export function splitConditionText(text) {
  const lines = String(text ?? '').replace(/\r\n?/g, '\n').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return { lead: null, items: [] };
  const MARK = /^(?:[-*•▪◦·]|\d{1,2}[.)]|[a-z][.)])\s+/i;
  if (!lines.some((l) => MARK.test(l))) return { lead: null, items: lines.slice(0, MAX_CONDITIONS) };
  const items = [];
  const lead = [];
  for (const line of lines) {
    if (MARK.test(line)) items.push(line.replace(MARK, '').trim());
    else if (items.length) items[items.length - 1] = `${items[items.length - 1]} ${line}`;
    else lead.push(line);
  }
  // Words before the first bullet introduce the list; they stay the approver's note.
  return { lead: lead.join(' ') || null, items: items.filter(Boolean).slice(0, MAX_CONDITIONS) };
}

export function splitConditions(text) {
  return splitConditionText(text).items;
}

/** The stored state, or null when the row has no conditions. */
export function readConditions(raw) {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.items) || raw.items.length === 0) return null;
  return {
    round: Number(raw.round) || 1,
    setBy: raw.setBy || null,
    setByName: raw.setByName || null,
    setAt: raw.setAt || null,
    note: raw.note || null,
    submittedAt: raw.submittedAt || null,
    submittedBy: raw.submittedBy || null,
    submittedByName: raw.submittedByName || null,
    items: raw.items.filter((i) => i && i.text).map((i, n) => ({
      id: Number(i.id) || n + 1,
      text: String(i.text),
      response: RESPONSES.includes(i.response) ? i.response : null,
      answer: i.answer || null,
      answeredBy: i.answeredBy || null,
      answeredByName: i.answeredByName || null,
      answeredAt: i.answeredAt || null,
    })),
  };
}

/**
 * The conditions an approver sent, as items. `input` is a list of strings or
 * { id?, text } objects; when absent, the free-text condition is split. An
 * item whose text is unchanged from the previous round keeps its answer.
 */
export function conditionItems(input, conditionNote = null, prior = null) {
  let texts;
  if (Array.isArray(input)) texts = input.map((c) => (typeof c === 'string' ? c : c?.text));
  else texts = splitConditions(conditionNote);
  const seen = new Set();
  const list = [];
  for (const t of texts) {
    const text = clean(t, MAX_TEXT);
    if (!text || seen.has(key(text))) continue;
    seen.add(key(text));
    list.push(text);
  }
  const before = new Map((prior?.items || []).map((i) => [key(i.text), i]));
  return list.slice(0, MAX_CONDITIONS).map((text, n) => {
    const old = before.get(key(text));
    return old
      ? { ...old, id: n + 1, text }
      : { id: n + 1, text, response: null, answer: null, answeredBy: null, answeredByName: null, answeredAt: null };
  });
}

/** Same conditions, in any order? (An approver re-sending them unchanged is accepting the answers.) */
export function sameConditions(a = [], b = []) {
  if (a.length !== b.length) return false;
  const left = new Set(a.map((i) => key(i.text)));
  return b.every((i) => left.has(key(i.text)));
}

export function isAnswered(item) {
  if (!item || !RESPONSES.includes(item.response)) return false;
  return item.response === 'can_meet' || Boolean(clean(item.answer, MAX_ANSWER));
}

/** Who the request is waiting on: 'it' (answers due), 'approver' (answers in) or null (no conditions). */
export function waitingOn(state, status) {
  if (!state) return null;
  if (status === 'info_requested' && !state.submittedAt) return 'it';
  if (status === 'info_requested') return 'requester';
  if (status === 'pending' && state.submittedAt) return 'approver';
  return null;
}

/** Merge a technician's answers into the items (by id). Unknown ids are ignored. */
export function mergeAnswers(items, answers, who = {}) {
  const byId = new Map((Array.isArray(answers) ? answers : []).map((a) => [Number(a?.id), a]));
  const now = new Date().toISOString();
  return items.map((item) => {
    const a = byId.get(Number(item.id));
    if (!a) return item;
    const response = RESPONSES.includes(a.response) ? a.response : null;
    const answer = clean(a.answer, MAX_ANSWER) || null;
    if (response === item.response && answer === item.answer) return item;
    return { ...item, response, answer, answeredBy: who.email || null, answeredByName: who.name || null, answeredAt: now };
  });
}

export const RESPONSE_LABEL = { can_meet: 'Can be met', cant_meet: "Can't be met as asked" };

/**
 * The agreed conditions as plain text — kept on conditionNote when the
 * request is finally approved, so the verdict card, e-mails, Teams and the
 * API (which already read conditionNote) all carry them.
 */
export function agreedSummary(state) {
  if (!state) return null;
  return state.items.map((i, n) => {
    const head = `${n + 1}. ${i.text}`;
    if (!i.response) return `${head}\n   Not answered.`;
    return `${head}\n   ${RESPONSE_LABEL[i.response]}${i.answer ? `: ${i.answer}` : '.'}`;
  }).join('\n');
}

/** Plain list for notes and e-mail previews. */
export function conditionsText(items) {
  return (items || []).map((i, n) => `${n + 1}. ${i.text}`).join('\n');
}

export function countCantMeet(state) {
  return (state?.items || []).filter((i) => i.response === 'cant_meet').length;
}
