// Shared CSS Grid templates so the compact technician table header
// (TechCompactHeader.jsx) and each row (TechCardCompact.jsx) line up
// pixel-perfectly. Update both views together when adding/removing columns.
//
// Column order:
//   weekly:  [expand] [name+badges] [week heatmap]    [Total] [Self] [App] [Asgn] [Done] [Rej] [CSAT] [Assigners]
//   daily:   [expand] [name+badges] [Open]            [Total] [Self] [App] [Asgn] [Done] [Rej] [CSAT] [Assigners]

// Weekly: name column stays a flexible minmax so long names can use extra
// space; week heatmap column is also flexible so it stretches across the
// middle of the row.
//
// The actual track sizes live in CSS custom properties (index.css) so a
// media query can compress the fixed columns on laptop widths — with the
// former hardcoded ~1220px minimum, the trailing Asgn/CSAT/assigner cells
// spilled past the row card on 1366–1536px screens (QA 07-16 #1).
export const COMPACT_GRID_WEEKLY = 'var(--tp-compact-grid-weekly)';

// Daily: no week heatmap, so we lock the name column to a fixed width
// (otherwise it grows and pushes all the metrics far to the right).
export const COMPACT_GRID_DAILY = 'var(--tp-compact-grid-daily)';

// `simple` (QA 07-30 #8) switches to the plain-number style: wider metric
// tracks so the full-word two-line headers fit.
export function getCompactGridTemplate(viewMode, simple = false) {
  if (simple) {
    return viewMode === 'weekly'
      ? 'var(--tp-compact-grid-weekly-simple)'
      : 'var(--tp-compact-grid-daily-simple)';
  }
  return viewMode === 'weekly' ? COMPACT_GRID_WEEKLY : COMPACT_GRID_DAILY;
}

// Sortable column descriptors. `field` is the technician property used for
// sorting (resolved per viewMode in the Dashboard sort comparator). `label`
// is what appears in the sticky header. `align` controls the cell alignment.
//
// The first two columns (expand chevron, name) intentionally aren't sortable
// from the header — name sorting can be added later if useful.
// Assigners column removed (QA 07-30 #4) — that detail lives in the expanded
// row now. Name column gained a real header title (QA 07-30 #7).
export const COMPACT_COLUMNS_WEEKLY = [
  { key: 'expand', label: '', sortable: false, align: 'left' },
  { key: 'name', label: 'Agent Name', sortable: true, align: 'left' },
  { key: 'week', label: 'This Week (Mon–Sun)', sortable: false, align: 'center' },
  { key: 'total', label: 'Total', sortable: true, align: 'center' },
  { key: 'self', label: 'Self', sortable: true, align: 'center' },
  { key: 'app', label: 'App', sortable: true, align: 'center' },
  { key: 'asgn', label: 'Asgn', sortable: true, align: 'center' },
  { key: 'done', label: 'Done', sortable: true, align: 'center' },
  { key: 'rej', label: 'Rej', sortable: true, align: 'center' },
  { key: 'csat', label: 'CSAT', sortable: true, align: 'center' },
];

export const COMPACT_COLUMNS_DAILY = [
  { key: 'expand', label: '', sortable: false, align: 'left' },
  { key: 'name', label: 'Agent Name', sortable: true, align: 'left' },
  { key: 'open', label: 'Open', sortable: true, align: 'center' },
  { key: 'total', label: 'Today', sortable: true, align: 'center' },
  { key: 'self', label: 'Self', sortable: true, align: 'center' },
  { key: 'app', label: 'App', sortable: true, align: 'center' },
  { key: 'asgn', label: 'Asgn', sortable: true, align: 'center' },
  { key: 'done', label: 'Done', sortable: true, align: 'center' },
  { key: 'rej', label: 'Rej', sortable: true, align: 'center' },
  { key: 'csat', label: 'CSAT', sortable: true, align: 'center' },
];

// Simple style (QA 07-30 #8): the same columns wearing plain-English names —
// the user's mockup labels, verbatim. Cryptic Self/App/Asgn become full words.
const SIMPLE_LABELS = {
  name: 'Agent Name',
  week: 'Tickets each day',
  open: 'Open now',
  total: 'Total',
  self: 'Picked up themselves',
  app: 'Sent by the app',
  asgn: 'Sent by a coordinator',
  done: 'Resolved',
  rej: 'Rejected',
  csat: 'CSAT score',
};

export function getCompactColumns(viewMode, simple = false) {
  const cols = viewMode === 'weekly' ? COMPACT_COLUMNS_WEEKLY : COMPACT_COLUMNS_DAILY;
  if (!simple) return cols;
  return cols.map((c) => (SIMPLE_LABELS[c.key] ? { ...c, label: SIMPLE_LABELS[c.key] } : c));
}

// Minimum content width (px) for the compact table in the tablet band
// (640–1100px — where index.css's ≤1536px track values apply): the sum of the
// fixed grid tracks + 9 column gaps (gap-3 = 12px × 9) + the row's horizontal
// padding (px-3). The Dashboard wraps header + rows in ONE horizontally
// scrolling container (QA 08-04 #3: iPad portrait pushed the trailing columns
// past the right edge with no way to reach them) and pins this as the inner
// min-width so header and rows scroll together, perfectly aligned.
// Monthly shares the daily template (see getCompactGridTemplate).
export function getCompactMinWidth(viewMode, simple = false) {
  if (viewMode === 'weekly') return simple ? 1060 : 920;
  return simple ? 900 : 760;
}

// Resolve the actual numeric value to sort by for a given column + viewMode.
// Returning null/undefined => treated as -Infinity in sort comparator.
export function getSortValue(tech, sortKey, viewMode) {
  if (!tech) return null;
  const isWeekly = viewMode === 'weekly';
  const isMonthly = viewMode === 'monthly';

  switch (sortKey) {
  case 'name':
    return (tech.name || '').toLowerCase();
  case 'open':
    return tech.openOnlyCount || 0;
  case 'total':
    return isMonthly
      ? (tech.monthlyTotalCreated || 0)
      : isWeekly
        ? (tech.weeklyTotalCreated || 0)
        : (tech.totalTicketsToday || 0);
  case 'self':
    return isMonthly
      ? (tech.monthlySelfPicked || 0)
      : isWeekly
        ? (tech.weeklySelfPicked || 0)
        : (tech.selfPickedToday || 0);
  case 'app':
    return isMonthly
      ? (tech.monthlyAppAssigned || 0)
      : isWeekly
        ? (tech.weeklyAppAssigned || 0)
        : (tech.appAssignedToday || 0);
  case 'asgn':
    return isMonthly
      ? (tech.monthlyAssigned || 0)
      : isWeekly
        ? (tech.weeklyAssigned || 0)
        : (tech.assignedToday || 0);
  case 'done':
    return isMonthly
      ? (tech.monthlyClosed || 0)
      : isWeekly
        ? (tech.weeklyClosed || 0)
        : (tech.closedToday || 0);
  case 'rej':
    return tech.rejectedThisPeriod !== undefined && tech.rejectedThisPeriod !== null
      ? tech.rejectedThisPeriod
      : isMonthly
        ? (tech.rejected30d || 0)
        : (tech.rejected7d || 0);
  case 'csat': {
    // Sort by the average (what the cell now shows, QA 07-30 #5); response
    // count breaks ties so 4.0-with-5-responses outranks 4.0-with-1.
    const avg = isMonthly
      ? tech.monthlyCSATAverage
      : isWeekly
        ? tech.weeklyCSATAverage
        : tech.csatAverage;
    const count = isMonthly
      ? (tech.monthlyCSATCount || 0)
      : isWeekly
        ? (tech.weeklyCSATCount || 0)
        : (tech.csatCount || 0);
    return (avg || 0) * 1000 + count;
  }
  default:
    return 0;
  }
}
