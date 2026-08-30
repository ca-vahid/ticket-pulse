// Shared constants for the technician detail page components

export const PRIORITY_STRIP_COLORS = {
  1: 'bg-blue-400',    // Low
  2: 'bg-emerald-500', // Medium
  3: 'bg-amber-500',   // High
  4: 'bg-red-500',     // Urgent
};

export const PRIORITY_LABELS = {
  1: 'Low',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

// Semantic status pill styles: border-based, no heavy fills
// Softer, borderless status pills (mockup style — subtle bg + colored text).
// Deleted/Spam stay solid so "removed" reads unmistakably.
export const STATUS_COLORS = {
  'Open':     'bg-rose-50 dark:bg-rose-500/15 text-rose-600 dark:text-rose-300',
  'Pending':  'bg-amber-50 dark:bg-amber-500/15 text-amber-700 dark:text-amber-200',
  'Resolved': 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200',
  'Closed':   'bg-muted text-muted-foreground',
  'Deleted':  'bg-red-600 text-white',
  'Spam':     'bg-orange-500 text-white',
};

export const FRESHSERVICE_DOMAIN =
  import.meta.env?.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';
