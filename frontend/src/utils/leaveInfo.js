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

export function getLeaveTooltip(leave) {
  if (!leave) return null;
  const style = getLeaveStyle(leave.category);
  const prefix = leave.category === 'WFH' ? '🏠' : leave.category === 'OFF' ? '🏖️' : '📋';
  return `${prefix} ${leave.typeName || style.label}`;
}

export function getLeaveDotClass(leave) {
  if (!leave) return null;
  return getLeaveStyle(leave.category).dotClass;
}

export function getLeaveBadge(leave) {
  if (!leave) return null;
  const style = getLeaveStyle(leave.category);
  return {
    text: leave.category === 'OFF' ? (leave.typeName || 'OFF') : style.label,
    shortText: style.label,
    ...style,
  };
}
