/**
 * After a person sets the priority (QA 11-23 #2, Assignment Review): the
 * requester's raise through their status link, or an agent's change. The AI's
 * own signals ("Single-user impact", "No outage or deadline language") stay on
 * the ticket and used to sit under the requester's note as if they backed it.
 * They are the AI's EARLIER assessment, and are labelled so.
 *
 * Detection: `priorityReason.source` (B1's contract), else the legacy marker
 * the urgency link stamps (`priorityConfidence: 'requester'`).
 */

const PERSON_SOURCES = { requester_link: 'raised', agent: 'changed', personal_key: 'changed' };
const NAMES = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const levelName = (v) => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (Number.isInteger(n) && NAMES[n]) return NAMES[n];
  const s = String(v).trim().toLowerCase();
  return Object.values(NAMES).find((x) => x.toLowerCase() === s) || null;
};

/**
 * @returns null when the priority is the AI's own, else
 *   { who, verb: 'raised'|'changed', level, note, earlierLabel, aiLevel }
 */
export function priorityOverrideFor(ticket, run = null) {
  if (!ticket) return null;
  const reason = ticket.priorityReason && typeof ticket.priorityReason === 'object' ? ticket.priorityReason : null;
  const byRequesterLegacy = String(ticket.priorityConfidence || '').toLowerCase() === 'requester';
  const source = reason?.source && PERSON_SOURCES[reason.source] ? reason.source : byRequesterLegacy ? 'requester_link' : null;
  if (!source) return null;
  const verb = PERSON_SOURCES[source];
  const requesterName = ticket.requester?.name || null;
  // "Requester" is B1's stand-in when it had no name, not a name.
  const named = String(reason?.actorName || '').trim();
  const who = (named && !/^requester$/i.test(named) ? named : null)
    || (source === 'requester_link' ? requesterName || 'the requester' : 'an agent');
  const level = levelName(reason?.level) || levelName(ticket.assessedPriorityId) || levelName(ticket.assessedPriority) || levelName(ticket.priority);
  const rawNote = String(reason?.note || (byRequesterLegacy ? ticket.priorityRationale : '') || '').trim();
  // B1's stock link note only repeats the headline.
  const note = rawNote && !/^raised the priority to \w+ from their status link\.?$/i.test(rawNote) ? rawNote : null;
  // The AI's own level: this run's assessment, else the ticket's assessed level
  // when the urgency link has not overwritten it with the requester's.
  const runLevel = levelName(run?.recommendation?.assessedPriority ?? run?.recommendation?.priority);
  const assessed = byRequesterLegacy ? null : levelName(ticket.assessedPriorityId) || levelName(ticket.assessedPriority);
  const aiLevel = [runLevel, assessed].find((l) => l && l !== level) || null;
  // The rationale is the AI's only when it is not the person's note.
  const rationale = String(ticket.priorityRationale || '').trim();
  const aiRationale = rationale && !byRequesterLegacy && rationale !== note ? rationale : null;
  const signals = Array.isArray(ticket.priorityEvidence) ? ticket.priorityEvidence.filter(Boolean).slice(0, 4) : [];
  const headline = `Priority: ${level || 'changed'}, ${verb} by ${who}${source === 'requester_link' ? ' from their status link' : ''}`;
  return {
    who,
    verb,
    level,
    note,
    headline,
    earlierLabel: `The AI's earlier assessment (before ${who} ${verb} it)`,
    aiLevel,
    aiRationale,
    signals,
  };
}

/** The "TP Urgent" tag's tooltip: the person's choice first, then the AI's earlier view. */
export function priorityOverrideTitle(o) {
  if (!o) return null;
  const earlier = [o.aiLevel ? `rated ${o.aiLevel}` : null, o.aiRationale, o.signals.length ? `signals: ${o.signals.join(', ')}` : null].filter(Boolean);
  return [
    `${o.headline}${o.note ? `: ${o.note}` : ''}`,
    earlier.length ? `${o.earlierLabel}: ${earlier.join('; ')}` : null,
  ].filter(Boolean).join('. ');
}
