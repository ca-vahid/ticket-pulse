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
export const STATUS_COLORS = {
  'Open':     'bg-red-50 text-red-700 border border-red-200',
  'Pending':  'bg-amber-50 text-amber-800 border border-amber-200',
  'Resolved': 'bg-emerald-50 text-emerald-700 border border-emerald-200',
  'Closed':   'bg-slate-100 text-slate-600 border border-slate-200',
};

export const FRESHSERVICE_DOMAIN =
  import.meta.env?.VITE_FRESHSERVICE_DOMAIN || 'efusion.freshservice.com';
