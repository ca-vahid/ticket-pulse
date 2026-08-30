const CATEGORY_STYLES = {
  OFF: {
    label: 'OFF',
    bgClass: 'bg-amber-50/70 dark:bg-amber-500/10',
    borderClass: 'border-amber-300 dark:border-amber-500/40',
    dotClass: 'bg-amber-400',
    textClass: 'text-amber-700 dark:text-amber-200',
    badgeBg: 'bg-amber-100 dark:bg-amber-500/20',
    badgeBorder: 'border-amber-300 dark:border-amber-500/40',
    badgeText: 'text-amber-800 dark:text-amber-200',
    // Soft vertical gradients used by half-day cells. Fades from the leave
    // colour at the relevant edge (top for AM, bottom for PM) through the
    // midline into transparent, so the split has no hard line.
    // NOTE: Tailwind needs literal classnames at build time — keep these
    // strings unparameterised even though it's repetitive.
    splitGradientAM: 'bg-gradient-to-b from-amber-300/80 via-amber-200/40 to-transparent dark:from-amber-400/50 dark:via-amber-400/20',
    splitGradientPM: 'bg-gradient-to-t from-amber-300/80 via-amber-200/40 to-transparent dark:from-amber-400/50 dark:via-amber-400/20',
  },
  WFH: {
    label: 'WFH',
    bgClass: 'bg-teal-50/70 dark:bg-teal-500/10',
    borderClass: 'border-teal-300 dark:border-teal-500/40',
    dotClass: 'bg-teal-400',
    textClass: 'text-teal-700 dark:text-teal-200',
    badgeBg: 'bg-teal-100 dark:bg-teal-500/20',
    badgeBorder: 'border-teal-300 dark:border-teal-500/40',
    badgeText: 'text-teal-800 dark:text-teal-200',
    splitGradientAM: 'bg-gradient-to-b from-teal-300/80 via-teal-200/40 to-transparent dark:from-teal-400/50 dark:via-teal-400/20',
    splitGradientPM: 'bg-gradient-to-t from-teal-300/80 via-teal-200/40 to-transparent dark:from-teal-400/50 dark:via-teal-400/20',
  },
  OTHER: {
    label: 'OTH',
    bgClass: 'bg-purple-50/70 dark:bg-purple-500/10',
    borderClass: 'border-purple-300 dark:border-purple-500/40',
    dotClass: 'bg-purple-400',
    textClass: 'text-purple-700 dark:text-purple-200',
    badgeBg: 'bg-purple-100 dark:bg-purple-500/20',
    badgeBorder: 'border-purple-300 dark:border-purple-500/40',
    badgeText: 'text-purple-800 dark:text-purple-200',
    splitGradientAM: 'bg-gradient-to-b from-purple-300/80 via-purple-200/40 to-transparent dark:from-purple-400/50 dark:via-purple-400/20',
    splitGradientPM: 'bg-gradient-to-t from-purple-300/80 via-purple-200/40 to-transparent dark:from-purple-400/50 dark:via-purple-400/20',
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
 * Returns the overlay-gradient class for a half-day leave.
 *
 * Output shape:
 *   { isSplit: true,  overlayClass: 'bg-gradient-to-b from-...' }  // half-day
 *   { isSplit: false, overlayClass: null }                         // full-day or none
 *
 * The overlay is rendered as a SINGLE absolute inset-0 div on top of the
 * normal day-cell colour. The gradient fades the leave colour from the
 * relevant edge (top for AM, bottom for PM) into transparent toward the
 * opposite edge, so there is no hard 50/50 line.
 */
export function getLeaveSplit(leave) {
  if (!leave || !isHalfDayLeave(leave)) {
    return { isSplit: false, overlayClass: null };
  }
  const style = getLeaveStyle(leave.category);
  const overlayClass = leave.halfDayPart === 'AM'
    ? style.splitGradientAM
    : style.splitGradientPM;
  return { isSplit: true, overlayClass };
}
