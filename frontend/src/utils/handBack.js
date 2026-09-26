import { Gauge, GraduationCap, MapPin, MessageSquare } from 'lucide-react';

/**
 * Hand-back reasons (QA 09-25 item 3) + assignable-only helpers (item 6),
 * shared by the assignee pickers, the bulk bar and the review surfaces.
 */
export const HAND_BACK_OPTIONS = [
  { code: 'location', label: 'Location issue', hint: 'Needs someone on site or nearer the requester', Icon: MapPin },
  { code: 'capacity', label: 'Capacity full', hint: 'No room for it right now', Icon: Gauge },
  { code: 'competency', label: 'Competency mismatch', hint: 'Outside my skills for this category', Icon: GraduationCap },
  { code: 'other', label: 'Other', hint: 'Say briefly why', Icon: MessageSquare },
];

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

/** Team first, then assignable-only people from other teams (QA 09-25 item 6). */
export function splitTeams(list) {
  const team = [];
  const others = [];
  for (const t of list || []) (t.assignableOnly ? others : team).push(t);
  return { team, others };
}
