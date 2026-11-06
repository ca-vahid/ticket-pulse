/**
 * Teams assistant routing (plans/TEAMS_BOT_COMMANDS_PLAN.md, P0). Pure
 * functions, no I/O.
 *
 * Today any message of 60+ characters is offered as a new ticket, so "can you
 * show me every time-off request still waiting for me to approve" became an
 * Autofill draft. Now:
 *   pictures                         -> Autofill (unchanged)
 *   300+ characters or 3+ lines      -> Autofill (a pasted chat or e-mail)
 *   "my tickets" / "settings" / "hi" -> the bot commands (unchanged)
 *   reads as a question to the bot   -> the assistant
 *   reads as a request for IT (60+)  -> Autofill
 *   60+ characters, can't tell       -> ask: "a request for IT, or a question for me?"
 *   anything shorter                 -> the assistant (which can still offer a ticket)
 *
 * keywordIntents() is the deterministic router the fallback cards use (AI
 * off, Shadow, over budget, failing): the same six tool executors, picked by
 * keywords instead of a model.
 */

export const ROUTE_LIMITS = Object.freeze({
  AUTOFILL_CHARS: 300,
  AUTOFILL_LINES: 3,
  UNSURE_CHARS: 60, // today's Autofill threshold
});

const lc = (s) => String(s || '').trim().toLowerCase();

// "show me…", "what's waiting for me", "how many…", "is #231164 closed", "who's out".
const QUESTION_START = /^(please\s+)?(show|list|give|tell|find|check|get|pull up|display|what|what's|whats|wat|which|how many|how much|how's|hows|any|anything|anyone|anybody|is|are|am|was|were|do|does|did|have|has|when|when's|whens|where|where's|wheres|who|who's|whos|whose|status|can you (show|list|tell|find|check|get|give|pull)|could you (show|list|tell|find|check|get|give|pull)|can i see|i want to see|i'd like to see|let me see)\b/i;
// The things the bot knows about, said about the asker.
const BOT_DOMAIN = /\b(approv\w*|aprov\w*|sign[- ]?off|time[- ]?off|time away|leave|vacay|vacation|holiday request|pto|availability|who'?s (out|off|away|in|wfh)|(out|off|away|wfh) (today|tomorrow)|overdue|due (today|this week|tomorrow)|my (tickets?|queue|plate|requests?|approvals?|leave|vacation|time off|day|week)|for me|on me|waiting (for|on) me|pending for me|assigned to me|tickets? (do i|i have)|days? (left|remaining)|status of)\b/i;
const TICKET_REF = /\bTP[- ]?\d{1,7}\b|(?<![\w&])#\d{4,12}\b/i;
const BARE_NUMBER = /(?<![\w.#-])\d{4,12}(?![\w.-])/;

// A problem or a request someone wants IT to act on.
const REQUEST_WORDS = /\b(not working|doesn'?t work|isn'?t working|won'?t (start|open|load|connect|print|turn on|work)|broken|broke|crash\w*|freez\w*|error|errors|keeps? (restarting|crashing|freezing|asking|failing|logging)|can'?t (log ?in|sign ?in|access|open|connect|print|see|get)|cannot|unable to|stopped working|failed|failing|locked out|reset (my|the|a) password|password reset|need (a|an|new|access|help|someone)|please (install|set up|setup|add|remove|create|fix|help)|request(ing)? (a|an|access|new)|set up (a|an)|install|new starter|new hire|onboard\w*|offboard\w*|laptop|printer|monitor|vpn|outlook|teams meeting|license|licence|mfa|phone|headset|docking|dock|can someone|could someone|someone (look|check|help)|help me with)\b/i;

/** Does this text read as a question to the bot? strong = the opening or the subject says so. */
export function questionSignals(text) {
  const t = String(text || '').trim();
  const strong = QUESTION_START.test(t) && (BOT_DOMAIN.test(t) || TICKET_REF.test(t) || BARE_NUMBER.test(t) || /\b(me|my|i)\b/i.test(t))
    || BOT_DOMAIN.test(t)
    || TICKET_REF.test(t);
  const weak = /\?\s*$/.test(t) || QUESTION_START.test(t);
  return { strong, weak };
}

export function requestSignals(text) {
  return REQUEST_WORDS.test(String(text || ''));
}

/**
 * Where a message goes. { route: 'autofill' | 'command' | 'assistant' | 'unsure', reason }.
 * `isCommand` is teamsIntakeService.isBotCommand (passed in to keep this pure).
 */
export function classifyMessage(text, { hasPictures = false, isCommand = () => false } = {}) {
  const t = String(text || '').trim();
  if (hasPictures) return isCommand(t) ? { route: 'command', reason: 'command' } : { route: 'autofill', reason: 'pictures' };
  if (!t) return { route: 'command', reason: 'empty' };
  if (isCommand(t)) return { route: 'command', reason: 'command' };
  const lines = t.split('\n').filter((l) => l.trim()).length;
  if (t.length >= ROUTE_LIMITS.AUTOFILL_CHARS || lines >= ROUTE_LIMITS.AUTOFILL_LINES) return { route: 'autofill', reason: 'long' };
  const q = questionSignals(t);
  const r = requestSignals(t);
  const long = t.length >= ROUTE_LIMITS.UNSURE_CHARS;
  if (q.strong && !r) return { route: 'assistant', reason: 'question' };
  if (q.strong && r) return long ? { route: 'unsure', reason: 'question_and_request' } : { route: 'assistant', reason: 'question' };
  if (q.weak && !r) return { route: 'assistant', reason: 'question' };
  if (r) return long ? (q.weak ? { route: 'unsure', reason: 'question_and_request' } : { route: 'autofill', reason: 'request' }) : { route: 'assistant', reason: 'short' };
  return long ? { route: 'unsure', reason: 'unclear' } : { route: 'assistant', reason: 'short' };
}

/** Ticket references in a message: TP-1042, #231164, or a bare number of 4+ digits. */
export function ticketRefsIn(text) {
  const t = String(text || '');
  const out = [];
  for (const m of t.matchAll(/\bTP[- ]?(\d{1,7})\b/gi)) out.push(`TP-${m[1]}`);
  for (const m of t.matchAll(/(?<![\w&])#(\d{4,12})\b/g)) out.push(`#${m[1]}`);
  if (!out.length) for (const m of t.matchAll(/(?<![\w.#-])(\d{4,12})(?![\w.-])/g)) out.push(m[1]);
  return [...new Set(out)].slice(0, 3);
}

const TIME_AWAY = /\b(time[- ]?off|time away|leave|vacay|vacation|holiday request|holidays?|pto|availability|days? off|sick day)\b/i;
const MY_TIME_AWAY = /\b(my (next )?(vacation|vacay|leave|time[- ]?off|holiday|pto|time away)|days? (left|remaining)|(vacation|leave|pto) (days|balance)|my (leave |time[- ]?off |vacation )?(request|balance)s?)\b/i;

/**
 * Deterministic intent: which tool(s) to run for a message, by keywords.
 * Returns [{ tool, input }] (empty = help card).
 */
export function keywordIntents(text) {
  const t = lc(text);
  if (!t) return [];
  const approvalWord = /\b(approv\w*|aprov\w*|sign[- ]?off|decide|decision)/.test(t);
  if (TIME_AWAY.test(t) && MY_TIME_AWAY.test(t) && !/\b(waiting (for|on) me|for me to|i need to|need my)\b/.test(t)) {
    return [{ tool: 'my_time_away', input: { scope: /\b(left|remaining|balance|this year)\b/.test(t) ? 'this_year' : 'upcoming' } }];
  }
  if (TIME_AWAY.test(t) && (approvalWord || /\b(waiting|pending|requests?)\b/.test(t))) {
    return [{ tool: 'time_away_waiting_for_me', input: {} }];
  }
  if (approvalWord) {
    if (/\b(i (asked|requested|sent|raised)|asked for|my requests?)\b/.test(t)) return [{ tool: 'my_pending_approvals', input: { side: 'i_asked' } }];
    return [{ tool: 'my_pending_approvals', input: { side: 'to_decide' } }, { tool: 'time_away_waiting_for_me', input: {} }];
  }
  const refs = ticketRefsIn(text);
  if (refs.length) return refs.map((ref) => ({ tool: 'ticket_status', input: { ref } }));
  if (/\b(who|anyone|anybody|everyone)\b/.test(t) &&/\b(away|out|off|wfh|working from home|in today|in tomorrow|on leave|on vacation|sick)\b/.test(t)) {
    return [{ tool: 'who_is_away', input: { date: /\btomorrow\b/.test(t) ? 'tomorrow' : 'today' } }];
  }
  if (/\b(overdue|late|past due|breach\w*)\b/.test(t)) return [{ tool: 'my_tickets', input: { filter: 'overdue' } }];
  if (/\bdue (today|now)\b|\btoday\b.*\b(due|plate)\b|\bmy plate\b/.test(t)) return [{ tool: 'my_tickets', input: { filter: 'due_today' } }];
  if (/\b(this week|due (soon|this week)|week)\b/.test(t) && /\b(tickets?|due)\b/.test(t)) return [{ tool: 'my_tickets', input: { filter: 'due_this_week' } }];
  if (/\b(pending|waiting on (the )?(requester|someone|them))\b/.test(t) && /\btickets?\b/.test(t)) return [{ tool: 'my_tickets', input: { filter: 'pending' } }];
  if (/\b(my tickets?|my queue|open tickets?|tickets? (do i|i have|assigned)|assigned to me)\b/.test(t)) return [{ tool: 'my_tickets', input: { filter: 'open' } }];
  return [];
}

/** "Start over" clears the short conversation memory. */
export function isStartOver(text) {
  return /^(start over|start again|reset|new question|forget (it|that)|never ?mind)[.!]*$/i.test(String(text || '').trim());
}

export default { classifyMessage, keywordIntents, ticketRefsIn, questionSignals, requestSignals, isStartOver, ROUTE_LIMITS };
