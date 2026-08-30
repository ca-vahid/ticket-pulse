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
  all: { label: 'All tickets', Icon: Ticket, tile: 'bg-blue-50 dark:bg-blue-500/15 text-blue-600 dark:text-blue-300', num: 'text-blue-600 dark:text-blue-300', countKey: 'all' },
  open: { label: 'Open', Icon: Inbox, tile: 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-600 dark:text-emerald-300', num: 'text-emerald-600 dark:text-emerald-300', countKey: 'open' },
  awaiting: { label: 'Awaiting reply', Icon: MessageSquare, tile: 'bg-sky-50 dark:bg-sky-500/15 text-sky-600 dark:text-sky-300', num: 'text-foreground', countKey: 'awaiting' },
  due_today: { label: 'Due today', Icon: CalendarDays, tile: 'bg-amber-50 dark:bg-amber-500/15 text-amber-600 dark:text-amber-300', num: 'text-foreground', countKey: 'dueToday' },
  overdue: { label: 'Overdue', Icon: AlertCircle, tile: 'bg-red-50 dark:bg-red-500/15 text-red-600 dark:text-red-300', num: 'text-red-600 dark:text-red-300', countKey: 'overdue' },
  resolved: { label: 'Resolved', Icon: CheckCircle2, tile: 'bg-violet-50 dark:bg-violet-500/15 text-violet-600 dark:text-violet-300', num: 'text-foreground', countKey: 'resolved' },
  // Created-period cards (calendar boundaries on the WORKSPACE clock,
  // Monday-start weeks — backend zonedBoundaries).
  created_week: { label: 'Tickets this week', Icon: CalendarRange, tile: 'bg-cyan-50 dark:bg-cyan-500/15 text-cyan-600 dark:text-cyan-300', num: 'text-foreground', countKey: 'createdThisWeek' },
  created_month: { label: 'Tickets this month', Icon: Calendar, tile: 'bg-teal-50 dark:bg-teal-500/15 text-teal-600 dark:text-teal-300', num: 'text-foreground', countKey: 'createdThisMonth' },
  created_year: { label: 'Tickets this year', Icon: CalendarClock, tile: 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-600 dark:text-indigo-300', num: 'text-foreground', countKey: 'createdThisYear' },
  // Opt-in cards (counts always existed; the rail's Views cover these too).
  unassigned: { label: 'Unassigned', Icon: UserRound, tile: 'bg-orange-50 dark:bg-orange-500/15 text-orange-600 dark:text-orange-300', num: 'text-foreground', countKey: 'unassigned' },
  deleted: { label: 'Deleted & spam', Icon: Trash2, tile: 'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300', num: 'text-foreground', countKey: 'deleted' },
  noise: { label: 'Noise', Icon: VolumeX, tile: 'bg-muted text-muted-foreground', num: 'text-foreground', countKey: 'noise' },
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
