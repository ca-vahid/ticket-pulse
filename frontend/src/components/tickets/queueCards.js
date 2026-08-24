import {
  AlertCircle, Calendar, CalendarClock, CalendarDays, CalendarRange, CheckCircle2,
  Inbox, MessageSquare, Ticket, Trash2, UserRound, VolumeX,
} from 'lucide-react';

/**
 * Quick-filter card registry (Mega 08-23 Phase FC).
 *
 * The /tickets stat-card row shows exactly QUEUE_CARD_COUNT single-select
 * `?segment=` cards; which ones is an admin choice per workspace (Settings →
 * Ticket Ops → Quick filter cards), delivered as `meta.queueCards`. This
 * registry owns each card's label / icon / tile tokens / stats count key —
 * the backend mirror (services/queueCardConfigService.js) is the validation
 * authority for the key list; keep the two in sync.
 *
 * Every key maps 1:1 to a buildListWhere segment branch AND a getQueueStats
 * count, so a card's number always equals what clicking it shows.
 */
export const QUEUE_CARD_REGISTRY = {
  all: { label: 'All tickets', Icon: Ticket, tile: 'bg-blue-50 text-blue-600', num: 'text-blue-600', countKey: 'all' },
  open: { label: 'Open', Icon: Inbox, tile: 'bg-emerald-50 text-emerald-600', num: 'text-emerald-600', countKey: 'open' },
  awaiting: { label: 'Awaiting reply', Icon: MessageSquare, tile: 'bg-sky-50 text-sky-600', num: 'text-slate-800', countKey: 'awaiting' },
  due_today: { label: 'Due today', Icon: CalendarDays, tile: 'bg-amber-50 text-amber-600', num: 'text-slate-800', countKey: 'dueToday' },
  overdue: { label: 'Overdue', Icon: AlertCircle, tile: 'bg-red-50 text-red-600', num: 'text-red-600', countKey: 'overdue' },
  resolved: { label: 'Resolved', Icon: CheckCircle2, tile: 'bg-violet-50 text-violet-600', num: 'text-slate-800', countKey: 'resolved' },
  // Created-period cards (calendar boundaries on the WORKSPACE clock,
  // Monday-start weeks — backend zonedBoundaries).
  created_week: { label: 'Tickets this week', Icon: CalendarRange, tile: 'bg-cyan-50 text-cyan-600', num: 'text-slate-800', countKey: 'createdThisWeek' },
  created_month: { label: 'Tickets this month', Icon: Calendar, tile: 'bg-teal-50 text-teal-600', num: 'text-slate-800', countKey: 'createdThisMonth' },
  created_year: { label: 'Tickets this year', Icon: CalendarClock, tile: 'bg-indigo-50 text-indigo-600', num: 'text-slate-800', countKey: 'createdThisYear' },
  // Opt-in cards (counts always existed; the rail's Views cover these too).
  unassigned: { label: 'Unassigned', Icon: UserRound, tile: 'bg-orange-50 text-orange-600', num: 'text-slate-800', countKey: 'unassigned' },
  deleted: { label: 'Deleted & spam', Icon: Trash2, tile: 'bg-rose-50 text-rose-600', num: 'text-slate-800', countKey: 'deleted' },
  noise: { label: 'Noise', Icon: VolumeX, tile: 'bg-slate-100 text-slate-500', num: 'text-slate-800', countKey: 'noise' },
};

/** Registry order — drives the admin slot dropdowns. */
export const QUEUE_CARD_KEYS = Object.keys(QUEUE_CARD_REGISTRY);

/** Today's exact 6 — an absent/invalid config renders these (zero change). */
export const DEFAULT_QUEUE_CARDS = ['all', 'open', 'awaiting', 'due_today', 'overdue', 'resolved'];

export const QUEUE_CARD_COUNT = 6;

/**
 * Read-side normalize for meta.queueCards: exactly 6 known unique keys or the
 * defaults (a stale/garbled config must never blank the card row).
 */
export function normalizeQueueCards(value) {
  if (!Array.isArray(value) || value.length !== QUEUE_CARD_COUNT) return DEFAULT_QUEUE_CARDS;
  const clean = value.map(String);
  if (clean.some((k) => !QUEUE_CARD_REGISTRY[k])) return DEFAULT_QUEUE_CARDS;
  if (new Set(clean).size !== clean.length) return DEFAULT_QUEUE_CARDS;
  return clean;
}
