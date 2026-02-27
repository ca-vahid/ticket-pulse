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
  { bg: 'bg-blue-500',   badge: 'bg-blue-100 text-blue-800 border border-blue-300',   marker: 'bg-blue-400'   },
  { bg: 'bg-violet-500', badge: 'bg-violet-100 text-violet-800 border border-violet-300', marker: 'bg-violet-400' },
  { bg: 'bg-amber-500',  badge: 'bg-amber-100 text-amber-800 border border-amber-300',  marker: 'bg-amber-400'  },
  { bg: 'bg-teal-500',   badge: 'bg-teal-100 text-teal-800 border border-teal-300',   marker: 'bg-teal-400'   },
  { bg: 'bg-rose-500',   badge: 'bg-rose-100 text-rose-800 border border-rose-300',   marker: 'bg-rose-400'   },
  { bg: 'bg-indigo-500', badge: 'bg-indigo-100 text-indigo-800 border border-indigo-300', marker: 'bg-indigo-400' },
  { bg: 'bg-orange-500', badge: 'bg-orange-100 text-orange-800 border border-orange-300', marker: 'bg-orange-400' },
  { bg: 'bg-cyan-500',   badge: 'bg-cyan-100 text-cyan-800 border border-cyan-300',   marker: 'bg-cyan-400'   },
];
