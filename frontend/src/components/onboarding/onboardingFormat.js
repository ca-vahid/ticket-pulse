// Onboarding / Offboarding: labels and formatters shared by the panels.

export const FAMILY_STATUS = {
  open: { tone: 'blue', label: 'Open' },
  closed: { tone: 'green', label: 'Closed' },
  cancelled: { tone: 'grey', label: 'Cancelled' },
};

export const MODE_INFO = {
  off: { tone: 'grey', label: 'Off', hint: 'Nothing happens. FreshService stays the organiser.' },
  // 2 Oct 2026 (Vahid): "Shadow", the word Auto-help uses for the same idea.
  // The stored value stays 'observe'.
  observe: { tone: 'amber', label: 'Shadow', hint: 'Every HR notice is read and the family it would build is recorded under Activity. No ticket is touched.' },
  live: { tone: 'green', label: 'Live', hint: 'Families are built and kept in step: children, due dates, date changes, cancellations.' },
};

export const EVENT_MODE = {
  observe: { tone: 'amber', label: 'Shadow' },
  live: { tone: 'green', label: 'Live' },
  manual: { tone: 'blue', label: 'Manual' },
};

export const OUTCOME = {
  done: { tone: 'green', label: 'Done' },
  recorded: { tone: 'amber', label: 'Recorded' },
  skipped: { tone: 'grey', label: 'Left for a person' },
  failed: { tone: 'red', label: 'Failed' },
};

export const DECISION_LABEL = {
  create_family: 'New family',
  create_family_after_the_fact: 'New family (after the fact)',
  duplicate_linked: 'Re-sent notice linked',
  move_dates: 'Dates moved',
  office_changed: 'Office changed',
  cancel_family: 'Family cancelled',
  link_nh: 'NH ticket linked',
  notice_is_ticket: 'Notice handled',
  no_family: 'No open family',
  no_date: 'No clear date',
  switch_after_the_fact: 'Switched to after the fact',
  ignored: 'Ignored',
};

export const KIND_LABEL = { offboarding: 'Offboarding', onboarding: 'Onboarding', leave: 'Leave', office_change: 'Transfer' };

/** Ticket status → dot tone (Open blue, Pending amber, Resolved/Closed green, gone grey). */
export function ticketTone(status) {
  const s = String(status || '').toLowerCase();
  if (s.includes('closed') || s.includes('resolved')) return 'green';
  if (s.includes('pending') || s.includes('waiting')) return 'amber';
  if (s === 'deleted' || s === 'spam') return 'grey';
  return 'blue';
}

export function fmtDate(value, { withYear = false } = {}) {
  if (!value) return '—';
  const iso = String(value).length === 10 ? `${value}T12:00:00Z` : value;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}), ...(String(value).length === 10 ? { timeZone: 'UTC' } : {}),
  });
}

export function fmtWhen(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// ---------------------------------------------------------------- change history labels

const SIDE_LABEL = { leave: 'Leave', officeChange: 'Transfer' };

export function changeFieldLabel(field, { templateLabels = {}, templates = {}, item = null } = {}) {
  if (field === 'mode') return 'Mode';
  if (field === 'parentAssigneeTechId') return 'Parent assignee';
  let m = field.match(/^(leave|officeChange)\.(assigneeTechId|park)$/);
  if (m) return `${SIDE_LABEL[m[1]]} — ${m[2] === 'park' ? 'park until the date' : 'assignee'}`;
  m = field.match(/^templates\.(\w+)\.order$/);
  if (m) return `${templateLabels[m[1]] || m[1]} — order`;
  m = field.match(/^templates\.(\w+)\[([\w-]+)\](?:\.(\w+))?$/);
  if (m) {
    const list = templateLabels[m[1]] || m[1];
    const title = (templates[m[1]] || []).find((i) => i.key === m[2])?.title || item?.title || m[2];
    const f = { title: 'title', dueOffsetDays: 'due offset', assigneeTechId: 'assignee', groupId: 'group' }[m[3]];
    return f ? `${list} — ${title}: ${f}` : `${list} — ${title}`;
  }
  return field;
}

export function changeValueLabel(field, value, { techById = new Map(), groupById = new Map() } = {}) {
  if (value === null || value === undefined) {
    if (/assigneeTechId$/.test(field)) return 'AI routing';
    if (/groupId$/.test(field)) return 'No group';
    if (/\]$/.test(field)) return 'not in the list';
    return '—';
  }
  if (/assigneeTechId$/.test(field)) return techById.get(Number(value))?.name || `Technician ${value}`;
  if (/groupId$/.test(field)) return groupById.get(Number(value))?.name || `Group ${value}`;
  if (field === 'mode') return MODE_INFO[value]?.label || value;
  if (/\.park$/.test(field)) return value ? 'yes' : 'no';
  if (/dueOffsetDays$/.test(field)) return `${value >= 0 ? '+' : ''}${value} days`;
  if (Array.isArray(value)) return value.join(', ');
  if (typeof value === 'object') return value.title ? `${value.title} (${value.dueOffsetDays >= 0 ? '+' : ''}${value.dueOffsetDays ?? 0} days)` : JSON.stringify(value);
  return String(value);
}
