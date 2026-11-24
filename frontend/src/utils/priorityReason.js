/**
 * Priority history in plain words (QA 11-23 #2).
 *
 * B1 writes one `priority_changed` activity row per change:
 *   details = { from, to, source, actorKind, actorName, actorEmail, via?, note? }
 *   source  ∈ requester_link | agent | ai_assessment | workflow | api | personal_key | repeat_report | sync
 * and the ticket carries `priorityReason = { level, source, actorName, at, note } | null`.
 *
 * The History tab prints the actor once per run, so the sentences here are
 * the words AFTER the name: "Dana Fox" + "raised the priority to Urgent from
 * their status link". All times are Pacific.
 */

const TZ = 'America/Vancouver';
const NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const RANK = { low: 1, medium: 2, high: 3, urgent: 4 };

/** 3 / '3' / 'high' / 'High' → 'High'; anything else → null. */
export function priorityName(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && NAMES[n]) return NAMES[n];
  const s = String(v).trim().toLowerCase();
  return RANK[s] ? NAMES[RANK[s]] : String(v).trim() || null;
}

const rank = (v) => RANK[String(priorityName(v) || '').toLowerCase()] || null;

function direction(from, to) {
  const a = rank(from); const b = rank(to);
  if (a && b && b > a) return 'raised';
  if (a && b && b < a) return 'lowered';
  return 'set';
}

const STAND_IN_NAMES = /^(api|public api|freshservice|workflow|ticket workflow|notification workflow|ticket pulse|ticket pulse ai|requester|system)$/i;
function personalName(v) {
  const s = String(v || '').trim();
  return s && !STAND_IN_NAMES.test(s) ? s : null;
}

/**
 * The row's note, unless it only repeats the line. B1's requester-link note is
 * "Raised the priority to Urgent from their status link." — the sentence
 * itself; "Asked for urgent after-hours help from their status link." adds
 * something and stays.
 */
function usefulNote(v) {
  const s = String(v || '').trim();
  if (!s) return null;
  if (/^raised the priority to \w+ from their status link\.?$/i.test(s)) return null;
  return s;
}

/** "changed the priority from Medium to High", or "set the priority to High" with no (or the same) from. */
function changed(from, to) {
  return from && from !== to ? `changed the priority from ${from} to ${to}` : `set the priority to ${to}`;
}

/**
 * One History line for a `priority_changed` row.
 * @returns { actor, actorKind, verb, detail, machine, source, from, to, workflowName }
 */
export function priorityChangeLine(details = {}, performedBy = null) {
  const d = details && typeof details === 'object' ? details : {};
  const from = priorityName(d.from);
  const to = priorityName(d.to) || 'a new level';
  // B1 stamps a stand-in name when there is no person ("API", "FreshService",
  // "Workflow", "Requester"); those are not names to print as a person.
  const name = personalName(d.actorName);
  const note = usefulNote(d.note);
  const base = { from, to, detail: note, machine: false, source: 'ticketpulse', workflowName: null };
  switch (d.source) {
  case 'requester_link': {
    // The link only ever raises; "lowered" is there for a correction.
    const dir = direction(from, to) === 'lowered' ? 'lowered' : 'raised';
    return { ...base, actor: name || personalName(performedBy) || 'The requester', actorKind: 'human', verb: `${dir} the priority to ${to} from their status link` };
  }
  case 'agent':
    return { ...base, actor: name || performedBy || 'An agent', actorKind: 'human', verb: changed(from, to) };
  case 'ai_assessment':
    return { ...base, actor: 'Ticket Pulse AI', actorKind: 'ai', verb: `set the priority to ${to}` };
  case 'workflow':
    return { ...base, actor: 'Workflow', actorKind: 'workflow', verb: changed(from, to), workflowName: name };
  case 'api':
    return { ...base, actor: name || 'Public API', actorKind: 'api', verb: `${changed(from, to)} through the API` };
  case 'personal_key':
    return { ...base, actor: name || performedBy || 'Someone', actorKind: 'personal_key', verb: `${changed(from, to)} with their API key` };
  case 'repeat_report':
    return { ...base, actor: 'Ticket Pulse', actorKind: 'system', verb: `raised the priority to ${to}: same problem reported again today` };
  case 'sync':
    return {
      ...base,
      actor: name || 'FreshService',
      actorKind: 'freshservice_sync',
      verb: `${changed(from, to)} in FreshService`,
      source: 'freshservice',
      // Without a person it is the sync's echo, not someone's decision.
      machine: !name,
    };
  default:
    return { ...base, actor: name || performedBy || 'Someone', actorKind: 'human', verb: changed(from, to) };
  }
}

/** "today, 10:17 AM" / "Fri 20 Nov, 10:17 AM" in Pacific time. */
export function pacificWhen(at, nowTs = Date.now()) {
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return null;
  const dayKey = (t) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(t));
  const time = d.toLocaleTimeString('en-US', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
  if (dayKey(d) === dayKey(nowTs)) return `today, ${time}`;
  if (dayKey(d) === dayKey(nowTs - 86400000)) return `yesterday, ${time}`;
  const sameYear = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(d)
    === new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric' }).format(new Date(nowTs));
  const day = d.toLocaleDateString('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }) }).replace(',', '');
  return `${day}, ${time}`;
}

/**
 * The "Why this priority" line, or null when there is nothing to say.
 * Hidden when the reason is null, or names a level the ticket no longer has
 * (a stale reason would explain the wrong thing).
 * @returns { who, when, note }
 */
export function priorityReasonText(reason, currentPriority, nowTs = Date.now()) {
  if (!reason || typeof reason !== 'object') return null;
  const level = priorityName(reason.level);
  const current = priorityName(currentPriority);
  if (level && current && level !== current) return null;
  const name = personalName(reason.actorName);
  const note = usefulNote(reason.note);
  const who = {
    requester_link: `${name || 'The requester'} raised it from their status link`,
    agent: `${name || 'An agent'} set it`,
    ai_assessment: 'The AI set it',
    workflow: name ? `The workflow “${name}” set it` : 'A workflow set it',
    api: `${name || 'An integration'} set it through the API`,
    personal_key: `${name || 'Someone'} set it with their API key`,
    repeat_report: 'Raised because the same problem was reported again today',
    sync: `${name || 'Someone'} set it in FreshService`,
  }[reason.source] || (name ? `${name} set it` : null);
  const when = reason.at ? pacificWhen(reason.at, nowTs) : null;
  if (!who && !note) return null;
  return { who, when, note };
}
