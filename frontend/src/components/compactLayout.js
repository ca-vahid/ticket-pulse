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
export const COMPACT_GRID_WEEKLY =
  '28px minmax(240px, 1.6fr) minmax(290px, 1.4fr) 64px 56px 56px 56px 56px 56px 64px 110px';

// Daily: no week heatmap, so we lock the name column to a fixed width
// (otherwise it grows and pushes all the metrics far to the right). The
// last column (assigners) takes whatever space is left.
export const COMPACT_GRID_DAILY =
  '28px 260px 72px 72px 56px 56px 56px 56px 56px 64px 1fr';

export function getCompactGridTemplate(viewMode) {
  return viewMode === 'weekly' ? COMPACT_GRID_WEEKLY : COMPACT_GRID_DAILY;
}

// Sortable column descriptors. `field` is the technician property used for
// sorting (resolved per viewMode in the Dashboard sort comparator). `label`
// is what appears in the sticky header. `align` controls the cell alignment.
//
// The first two columns (expand chevron, name) intentionally aren't sortable
// from the header — name sorting can be added later if useful.
export const COMPACT_COLUMNS_WEEKLY = [
  { key: 'expand', label: '', sortable: false, align: 'left' },
  { key: 'name', label: '', sortable: true, align: 'left' },
  { key: 'week', label: 'This Week (Mon–Sun)', sortable: false, align: 'center' },
  { key: 'total', label: 'Total', sortable: true, align: 'center' },
  { key: 'self', label: 'Self', sortable: true, align: 'center' },
  { key: 'app', label: 'App', sortable: true, align: 'center' },
  { key: 'asgn', label: 'Asgn', sortable: true, align: 'center' },
  { key: 'done', label: 'Done', sortable: true, align: 'center' },
  { key: 'rej', label: 'Rej', sortable: true, align: 'center' },
  { key: 'csat', label: 'CSAT', sortable: true, align: 'center' },
  { key: 'assigners', label: '', sortable: false, align: 'left' },
];

export const COMPACT_COLUMNS_DAILY = [
  { key: 'expand', label: '', sortable: false, align: 'left' },
  { key: 'name', label: '', sortable: true, align: 'left' },
  { key: 'open', label: 'Open', sortable: true, align: 'center' },
  { key: 'total', label: 'Today', sortable: true, align: 'center' },
  { key: 'self', label: 'Self', sortable: true, align: 'center' },
  { key: 'app', label: 'App', sortable: true, align: 'center' },
  { key: 'asgn', label: 'Asgn', sortable: true, align: 'center' },
  { key: 'done', label: 'Done', sortable: true, align: 'center' },
  { key: 'rej', label: 'Rej', sortable: true, align: 'center' },
  { key: 'csat', label: 'CSAT', sortable: true, align: 'center' },
  { key: 'assigners', label: '', sortable: false, align: 'left' },
];

export function getCompactColumns(viewMode) {
  return viewMode === 'weekly' ? COMPACT_COLUMNS_WEEKLY : COMPACT_COLUMNS_DAILY;
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
    const count = isMonthly
      ? (tech.monthlyCSATCount || 0)
      : isWeekly
        ? (tech.weeklyCSATCount || 0)
        : (tech.csatCount || 0);
    return count;
  }
  default:
    return 0;
  }
}
