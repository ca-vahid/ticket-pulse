/**
 * Shared timeline constants.
 * Re-exports the tech-detail constants and adds multi-tech accent colors.
 * Import from this file in all timeline components so changes propagate everywhere.
 */

export {
  PRIORITY_STRIP_COLORS,
  PRIORITY_LABELS,
  STATUS_COLORS,
  FRESHSERVICE_DOMAIN,
} from '../tech-detail/constants';

/**
 * Distinct accent color palettes for multi-technician timeline views.
 * Each entry describes the full set of classes needed to colour a tech's tickets.
 *   bg     — Tailwind bg class for the picked strip
 *   badge  — Tailwind classes for the "✓ Name" badge
 *   marker — Tailwind bg class for agent online/offline markers
 */
export const TECH_ACCENT_COLORS = [
  { bg: 'bg-blue-500',   badge: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200 border border-blue-300 dark:border-blue-500/40',   marker: 'bg-blue-400'   },
  { bg: 'bg-violet-500', badge: 'bg-violet-100 dark:bg-violet-500/20 text-violet-800 dark:text-violet-200 border border-violet-300 dark:border-violet-500/40', marker: 'bg-violet-400' },
  { bg: 'bg-amber-500',  badge: 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200 border border-amber-300 dark:border-amber-500/40',  marker: 'bg-amber-400'  },
  { bg: 'bg-teal-500',   badge: 'bg-teal-100 dark:bg-teal-500/20 text-teal-800 dark:text-teal-200 border border-teal-300 dark:border-teal-500/40',   marker: 'bg-teal-400'   },
  { bg: 'bg-rose-500',   badge: 'bg-rose-100 dark:bg-rose-500/20 text-rose-800 dark:text-rose-200 border border-rose-300 dark:border-rose-500/40',   marker: 'bg-rose-400'   },
  { bg: 'bg-indigo-500', badge: 'bg-indigo-100 dark:bg-indigo-500/20 text-indigo-800 dark:text-indigo-200 border border-indigo-300 dark:border-indigo-500/40', marker: 'bg-indigo-400' },
  { bg: 'bg-orange-500', badge: 'bg-orange-100 dark:bg-orange-500/20 text-orange-800 dark:text-orange-200 border border-orange-300 dark:border-orange-500/40', marker: 'bg-orange-400' },
  { bg: 'bg-cyan-500',   badge: 'bg-cyan-100 dark:bg-cyan-500/20 text-cyan-800 dark:text-cyan-200 border border-cyan-300 dark:border-cyan-500/40',   marker: 'bg-cyan-400'   },
];
