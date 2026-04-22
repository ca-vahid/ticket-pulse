const CATEGORY_STYLES = {
  OFF: {
    label: 'OFF',
    bgClass: 'bg-amber-50/70',
    borderClass: 'border-amber-300',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-700',
    badgeBg: 'bg-amber-100',
    badgeBorder: 'border-amber-300',
    badgeText: 'text-amber-800',
    // Solid fills used by half-day split cells where bg-*/70 looks washed out.
    splitFill: 'bg-amber-200',
  },
  WFH: {
    label: 'WFH',
    bgClass: 'bg-teal-50/70',
    borderClass: 'border-teal-300',
    dotClass: 'bg-teal-400',
    textClass: 'text-teal-700',
    badgeBg: 'bg-teal-100',
    badgeBorder: 'border-teal-300',
    badgeText: 'text-teal-800',
    splitFill: 'bg-teal-200',
  },
  OTHER: {
    label: 'OTH',
    bgClass: 'bg-purple-50/70',
    borderClass: 'border-purple-300',
    dotClass: 'bg-purple-400',
    textClass: 'text-purple-700',
    badgeBg: 'bg-purple-100',
    badgeBorder: 'border-purple-300',
    badgeText: 'text-purple-800',
    splitFill: 'bg-purple-200',
  },
};

export function getLeaveForDate(leaveInfo, dateStr) {
  if (!leaveInfo || !dateStr) return null;
  const key = dateStr.substring(0, 10);
  return leaveInfo[key] || null;
}

export function getLeaveStyle(category) {
  return CATEGORY_STYLES[category] || CATEGORY_STYLES.OTHER;
}

/** True if this leave only covers part of the day. */
export function isHalfDayLeave(leave) {
  return !!leave && leave.isFullDay === false && (leave.halfDayPart === 'AM' || leave.halfDayPart === 'PM');
}

/**
 * Format the leave's window as "HH:MM–HH:MM" or null if not a half-day.
 * Times are workspace-local (whatever the backend sent as minutes-from-midnight).
 */
export function formatLeaveWindow(leave) {
  if (!isHalfDayLeave(leave)) return null;
  const fmt = (m) => {
    if (m == null) return '??:??';
    const h = Math.floor(m / 60);
    const min = m % 60;
    return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  };
  return `${fmt(leave.startMinute)}–${fmt(leave.endMinute)}`;
}

export function getLeaveTooltip(leave) {
  if (!leave) return null;
  const style = getLeaveStyle(leave.category);
  const prefix = leave.category === 'WFH' ? '🏠' : leave.category === 'OFF' ? '🏖️' : '📋';
  const baseLabel = leave.typeName || style.label;
  if (isHalfDayLeave(leave)) {
    const window = formatLeaveWindow(leave);
    return `${prefix} ${baseLabel} — ${leave.halfDayPart} only (${window})`;
  }
  return `${prefix} ${baseLabel}`;
}

export function getLeaveDotClass(leave) {
  if (!leave) return null;
  return getLeaveStyle(leave.category).dotClass;
}

export function getLeaveBadge(leave) {
  if (!leave) return null;
  const style = getLeaveStyle(leave.category);
  const baseText = leave.category === 'OFF' ? (leave.typeName || 'OFF') : style.label;
  if (isHalfDayLeave(leave)) {
    return {
      text: `${baseText} · ${leave.halfDayPart}`,
      shortText: `${style.label} · ${leave.halfDayPart}`,
      ...style,
    };
  }
  return {
    text: baseText,
    shortText: style.label,
    ...style,
  };
}

/**
 * Returns 1 (full day), 0.5 (half day), or 0 (no leave). Used by aggregate
 * day-level UI (e.g. monthly calendar overview) so the count reflects actual
 * leave-time rather than "at least one row exists".
 */
export function getLeaveCount(leave) {
  if (!leave) return 0;
  return isHalfDayLeave(leave) ? 0.5 : 1;
}

/**
 * Decompose a half-day leave into top/bottom fills for split-cell rendering.
 * Returns { topFill, bottomFill, isSplit } — non-null fill means "render the
 * leave colour on this half"; null means "render the normal day-cell colour".
 *
 * For full-day leaves both halves use the leave style; the renderer can opt
 * to ignore the split and use the existing single-colour path instead.
 */
export function getLeaveSplit(leave) {
  if (!leave) return { topFill: null, bottomFill: null, isSplit: false };
  const style = getLeaveStyle(leave.category);
  if (!isHalfDayLeave(leave)) {
    return { topFill: style, bottomFill: style, isSplit: false };
  }
  if (leave.halfDayPart === 'AM') {
    return { topFill: style, bottomFill: null, isSplit: true };
  }
  return { topFill: null, bottomFill: style, isSplit: true };
}
