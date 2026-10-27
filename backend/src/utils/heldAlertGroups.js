/**
 * Held mail grouped by device (QA 10-26 #3). Pure — nothing here touches the database.
 *
 * A NAS, a UPS or a backup appliance mails from its own address, so one sender
 * is one device. When it has a bad hour it sends dozens of alerts in a few
 * minutes; the per-sender create cap opens tickets for the first few and holds
 * the rest, and the review list used to show every one of them as its own line
 * (103 on a Monday morning, from two Synology units).
 *
 * Here those rows become one group per device, and inside it one line per
 * alert KIND: the subject with the device tag gone and every number masked
 * ("Drive 9 …" and "Drive 12 …" are the same kind; "Storage Pool 1 has
 * crashed" is not). Kinds that read like a failure sort first, then kinds that
 * have no ticket yet, so a new and worse alert is never buried under sixty
 * copies of a harmless one.
 */
import { coarseTemplate } from '../services/ticketGrouping/rules.js';

/** Held rows from one sender before they are shown as a group. */
export const GROUP_MIN_ROWS = 3;

/** How far back a ticket from the same device counts as "the ticket for this kind". */
export const KIND_TICKET_LOOKBACK_HOURS = 24;

const TERMINAL = ['Resolved', 'Closed', 'Deleted', 'Spam'];

// Words that mean something broke. Deliberately short: "warning", "low",
// "out-of-date" are not here, so a full-disk notice does not outrank a crash.
const ATTENTION = /\b(crash(?:ed|es)?|fail(?:ed|s|ure|ing)?|critical|degraded|error|errors|down|offline|corrupt(?:ed)?|abnormal|unreachable|not responding|lost)\b/i;

const LEADING_TAG = /^\s*\[([^\]]{2,60})\]\s*/;

/** "[NAS-01] Drive 12 on …" → "Drive 12 on …". */
export function stripDeviceTag(subject) {
  return String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(LEADING_TAG, '').trim();
}

/** The device's name: the subject's leading [TAG], else the sender's display name, else the address's local part. */
export function deviceLabel({ subject, fromName, fromEmail } = {}) {
  const tag = LEADING_TAG.exec(String(subject || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, ''));
  if (tag) return tag[1].trim();
  if (fromName && String(fromName).trim()) return String(fromName).trim();
  const local = String(fromEmail || '').split('@')[0];
  return local || 'Unknown sender';
}

/** The alert kind as a key: device tag gone, numbers masked (rules.coarseTemplate). */
export function alertKindKey(subject) {
  return coarseTemplate(stripDeviceTag(subject));
}

/** Does this subject read like something broke? */
export function isAttentionKind(subject) {
  return ATTENTION.test(String(subject || ''));
}

/**
 * A readable label for a set of subjects of one kind: the words they share,
 * with the parts that differ shown as "#". Subjects of different lengths
 * fall back to the newest one.
 */
export function kindLabel(subjects = []) {
  const list = subjects.map(stripDeviceTag).filter(Boolean);
  if (!list.length) return '(no subject)';
  const split = list.map((s) => s.split(/\s+/));
  const len = split[0].length;
  if (!split.every((w) => w.length === len)) return list[0];
  return split[0].map((word, i) => (split.every((w) => w[i] === word) ? word : '#')).join(' ');
}

/** Same sender, same kind, newest first. Null when a broken-sounding kind would land on a closed ticket. */
export function kindTicketFor({ kindKey, attention = false, tickets = [] }) {
  const same = tickets
    .filter((t) => alertKindKey(t.subject) === kindKey)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  const ticket = same[0] || null;
  if (!ticket) return null;
  // A crash added to a ticket somebody (or a noise rule) already closed would
  // be out of everyone's sight; it stays in front of a person instead.
  if (attention && TERMINAL.includes(ticket.status)) return null;
  return ticket;
}

const ts = (d) => (d ? new Date(d).getTime() : 0);
const ticketSummary = (t) => (t ? { id: t.id, displayRef: t.displayRef, subject: t.subject, status: t.status } : null);

/**
 * rows: presented held rows (mailboxHoldService.list). tickets: recent tickets
 * from the same senders, each with `requesterEmail` and `displayRef`.
 * Returns { groups, singles }: groups for senders with GROUP_MIN_ROWS or more
 * held rows, everything else untouched in `singles` (newest first, as given).
 */
export function groupHeldRows(rows = [], { tickets = [], minRows = GROUP_MIN_ROWS } = {}) {
  const bySender = new Map();
  for (const row of rows) {
    const key = String(row.fromEmail || '').toLowerCase();
    if (!key) continue;
    if (!bySender.has(key)) bySender.set(key, []);
    bySender.get(key).push(row);
  }
  const groups = [];
  const grouped = new Set();
  for (const [sender, list] of bySender) {
    if (list.length < minRows) continue;
    list.forEach((r) => grouped.add(r.id));
    const senderTickets = tickets.filter((t) => String(t.requesterEmail || '').toLowerCase() === sender);
    const kinds = new Map();
    for (const row of list) {
      const key = alertKindKey(row.subject);
      if (!kinds.has(key)) kinds.set(key, []);
      kinds.get(key).push(row);
    }
    const kindList = [...kinds.entries()].map(([key, items]) => {
      const sorted = [...items].sort((a, b) => ts(b.receivedAt) - ts(a.receivedAt));
      const attention = isAttentionKind(sorted[0].subject);
      const anyTicket = senderTickets.filter((t) => alertKindKey(t.subject) === key)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0] || null;
      return {
        key,
        label: kindLabel(sorted.map((r) => r.subject)),
        count: items.length,
        attention,
        firstAt: sorted[sorted.length - 1].receivedAt || null,
        newestAt: sorted[0].receivedAt || null,
        ids: sorted.map((r) => r.id),
        ticket: ticketSummary(anyTicket),
        newKind: !anyTicket,
        shadowFolds: items.filter((r) => r.decision?.details?.fold?.mode === 'shadow').length,
      };
    }).sort((a, b) => (Number(b.attention) - Number(a.attention))
      || (Number(b.newKind) - Number(a.newKind))
      || (b.count - a.count)
      || (ts(b.newestAt) - ts(a.newestAt)));

    const newest = [...list].sort((a, b) => ts(b.receivedAt) - ts(a.receivedAt));
    // The ticket "attach all" offers: the newest open ticket from this device,
    // else its newest ticket, else the guess the ingest recorded most often.
    const recent = [...senderTickets].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    let suggested = recent.find((t) => !TERMINAL.includes(t.status)) || recent[0] || null;
    if (!suggested) {
      const tally = new Map();
      for (const r of list) if (r.bestGuessTicket) tally.set(r.bestGuessTicket.id, { t: r.bestGuessTicket, n: (tally.get(r.bestGuessTicket.id)?.n || 0) + 1 });
      suggested = [...tally.values()].sort((a, b) => b.n - a.n)[0]?.t || null;
    }
    groups.push({
      sender,
      device: deviceLabel(newest[0]),
      fromName: newest[0].fromName || null,
      count: list.length,
      firstAt: newest[newest.length - 1].receivedAt || null,
      lastAt: newest[0].receivedAt || null,
      reasons: [...new Set(list.map((r) => r.reason))],
      ids: newest.map((r) => r.id),
      kinds: kindList,
      attention: kindList.some((k) => k.attention),
      newKinds: kindList.filter((k) => k.newKind).length,
      suggestedTicket: ticketSummary(suggested),
    });
  }
  groups.sort((a, b) => (Number(b.attention) - Number(a.attention)) || (ts(b.lastAt) - ts(a.lastAt)));
  const singles = rows.filter((r) => !grouped.has(r.id));
  return { groups, singles };
}
