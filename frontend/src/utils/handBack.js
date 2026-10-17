import { ChevronsUp, Gauge, GraduationCap, KeyRound, MapPin, MessageSquare } from 'lucide-react';

/**
 * Hand-back reasons (QA 09-25 item 3) + assignable-only helpers (item 6),
 * shared by the assignee pickers, the bulk bar and the review surfaces.
 *
 * QA 10-16 item 1: the same reasons are asked for EVERY change of agent
 * (cleared or moved to another person), with two more: Access / permission
 * limited, and Escalate - shown only when the ticket goes back to the queue.
 */
export const HAND_BACK_OPTIONS = [
  { code: 'location', label: 'Location issue', hint: 'Needs someone on site or nearer the requester', Icon: MapPin },
  { code: 'capacity', label: 'Capacity full', hint: 'No room for it right now', Icon: Gauge },
  { code: 'competency', label: 'Competency mismatch', hint: 'Outside my skills for this category', Icon: GraduationCap },
  { code: 'access', label: 'Access / permission limited', hint: 'Needs access or rights I do not have', Icon: KeyRound },
  { code: 'other', label: 'Other', hint: 'Say briefly why', Icon: MessageSquare },
  {
    code: 'escalate',
    label: 'Escalate to Advanced Troubleshooting Team',
    hint: 'Needs someone more advanced in this category',
    Icon: ChevronsUp,
    unassignOnly: true,
  },
];

/** The reasons for a dialog: 'unassign' (back to the queue) or 'reassign' (to a named person). */
export function reasonOptions(mode = 'unassign') {
  return HAND_BACK_OPTIONS.filter((o) => mode === 'unassign' || !o.unassignOnly);
}

export function handBackLabel(code) {
  if (code === 'skipped') return 'No reason given';
  return HAND_BACK_OPTIONS.find((o) => o.code === code)?.label || null;
}

/** True when the signed-in person is this technician (matched by e-mail). */
export function isSignedInAs(user, tech) {
  const me = String(user?.email || '').trim().toLowerCase();
  const them = String(tech?.email || '').trim().toLowerCase();
  return Boolean(me && them && me === them);
}

/**
 * Does this assignee change ask for a reason? Only a change of agent: someone
 * is on the ticket and it moves to someone else. Not a first assignment of an
 * unassigned ticket, not picking it up yourself, not the same person again.
 * Clearing the assignee is handled by the Unassigned path.
 */
export function asksChangeReason({ fromId, toId, toTech = null, me = null }) {
  if (fromId == null || toId == null) return false;
  if (Number(fromId) === Number(toId)) return false;
  if (toTech && isSignedInAs(me, toTech)) return false;
  return true;
}

/** Team first, then assignable-only people from other teams (QA 09-25 item 6). */
export function splitTeams(list) {
  const team = [];
  const others = [];
  for (const t of list || []) (t.assignableOnly ? others : team).push(t);
  return { team, others };
}

/**
 * The newest Escalate on a ticket, from its audit rows (the hand-back writes
 * `details.handBack` with the escalation snapshot): { by, scope, level, at }.
 */
export function latestEscalation(activities) {
  const rows = (activities || [])
    .filter((a) => a?.details?.handBack?.code === 'escalate')
    .sort((a, b) => new Date(b.performedAt || 0) - new Date(a.performedAt || 0));
  const row = rows[0];
  if (!row) return null;
  const hb = row.details.handBack;
  const esc = hb.escalation || {};
  return {
    by: esc.fromTechName || hb.fromTechName || row.performedBy || null,
    scope: esc.scope || [esc.categoryName, esc.subcategoryName].filter(Boolean).join(' / ') || null,
    level: esc.level || null,
    note: hb.note || null,
    at: row.performedAt || null,
  };
}

/** "Escalated by Alex Doe: needs someone more advanced in Networking / VPN". */
export function escalationLine(esc) {
  if (!esc) return null;
  const who = esc.by || esc.fromTechName || 'the previous assignee';
  const scope = esc.scope || null;
  return `Escalated by ${who}: needs someone more advanced${scope ? ` in ${scope}` : ''}`;
}
