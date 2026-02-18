/**
 * Holiday utilities for Canadian and US holidays
 * Supports years 2025-2027 with helper functions
 */

// Canadian Statutory Holidays by year
// Note: Some holidays like Family Day vary by province, using Ontario dates
const CANADIAN_HOLIDAYS = {
  2025: {
    '2025-01-01': "New Year's Day",
    '2025-02-17': 'Family Day',
    '2025-04-18': 'Good Friday',
    '2025-05-19': 'Victoria Day',
    '2025-07-01': 'Canada Day',
    '2025-08-04': 'Civic Holiday',
    '2025-09-01': 'Labour Day',
    '2025-09-30': 'National Day for Truth and Reconciliation',
    '2025-10-13': 'Thanksgiving',
    '2025-11-11': 'Remembrance Day',
    '2025-12-25': 'Christmas Day',
    '2025-12-26': 'Boxing Day',
  },
  2026: {
    '2026-01-01': "New Year's Day",
    '2026-02-16': 'Family Day',
    '2026-04-03': 'Good Friday',
    '2026-05-18': 'Victoria Day',
    '2026-07-01': 'Canada Day',
    '2026-08-03': 'Civic Holiday',
    '2026-09-07': 'Labour Day',
    '2026-09-30': 'National Day for Truth and Reconciliation',
    '2026-10-12': 'Thanksgiving',
    '2026-11-11': 'Remembrance Day',
    '2026-12-25': 'Christmas Day',
    '2026-12-26': 'Boxing Day',
  },
  2027: {
    '2027-01-01': "New Year's Day",
    '2027-02-15': 'Family Day',
    '2027-03-26': 'Good Friday',
    '2027-05-24': 'Victoria Day',
    '2027-07-01': 'Canada Day',
    '2027-08-02': 'Civic Holiday',
    '2027-09-06': 'Labour Day',
    '2027-09-30': 'National Day for Truth and Reconciliation',
    '2027-10-11': 'Thanksgiving',
    '2027-11-11': 'Remembrance Day',
    '2027-12-25': 'Christmas Day',
    '2027-12-26': 'Boxing Day',
  },
};

// US Federal Holidays by year
const US_HOLIDAYS = {
  2025: {
    '2025-01-01': "New Year's Day",
    '2025-01-20': 'Martin Luther King Jr. Day',
    '2025-02-17': "Presidents' Day",
    '2025-05-26': 'Memorial Day',
    '2025-06-19': 'Juneteenth',
    '2025-07-04': 'Independence Day',
    '2025-09-01': 'Labor Day',
    '2025-10-13': 'Columbus Day',
    '2025-11-11': 'Veterans Day',
    '2025-11-27': 'Thanksgiving',
    '2025-12-25': 'Christmas Day',
  },
  2026: {
    '2026-01-01': "New Year's Day",
    '2026-01-19': 'Martin Luther King Jr. Day',
    '2026-02-16': "Presidents' Day",
    '2026-05-25': 'Memorial Day',
    '2026-06-19': 'Juneteenth',
    '2026-07-04': 'Independence Day',
    '2026-09-07': 'Labor Day',
    '2026-10-12': 'Columbus Day',
    '2026-11-11': 'Veterans Day',
    '2026-11-26': 'Thanksgiving',
    '2026-12-25': 'Christmas Day',
  },
  2027: {
    '2027-01-01': "New Year's Day",
    '2027-01-18': 'Martin Luther King Jr. Day',
    '2027-02-15': "Presidents' Day",
    '2027-05-31': 'Memorial Day',
    '2027-06-19': 'Juneteenth',
    '2027-07-04': 'Independence Day',
    '2027-09-06': 'Labor Day',
    '2027-10-11': 'Columbus Day',
    '2027-11-11': 'Veterans Day',
    '2027-11-25': 'Thanksgiving',
    '2027-12-25': 'Christmas Day',
  },
};

/**
 * Format a Date object to YYYY-MM-DD string
 * @param {Date|string} date - Date object or date string
 * @returns {string} Date in YYYY-MM-DD format
 */
const formatDateToKey = (date) => {
  if (typeof date === 'string') {
    // If already a string like "2025-01-01", return as is (take first 10 chars)
    return date.substring(0, 10);
  }
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
};

/**
 * Check if a date is a weekend (Saturday or Sunday)
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {boolean} True if Saturday or Sunday
 */
export const isWeekend = (date) => {
  const d = typeof date === 'string' ? new Date(date + 'T12:00:00') : date;
  const dayOfWeek = d.getDay();
  return dayOfWeek === 0 || dayOfWeek === 6; // 0 = Sunday, 6 = Saturday
};

/**
 * Get Canadian holiday name for a given date
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {string|null} Holiday name or null if not a holiday
 */
export const getCanadianHoliday = (date) => {
  const dateKey = formatDateToKey(date);
  const year = parseInt(dateKey.substring(0, 4), 10);
  const yearHolidays = CANADIAN_HOLIDAYS[year];
  if (!yearHolidays) return null;
  return yearHolidays[dateKey] || null;
};

/**
 * Get US holiday name for a given date
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {string|null} Holiday name or null if not a holiday
 */
export const getUSHoliday = (date) => {
  const dateKey = formatDateToKey(date);
  const year = parseInt(dateKey.substring(0, 4), 10);
  const yearHolidays = US_HOLIDAYS[year];
  if (!yearHolidays) return null;
  return yearHolidays[dateKey] || null;
};

/**
 * Get comprehensive holiday information for a date
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {Object} Holiday info object
 */
export const getHolidayInfo = (date) => {
  const canadianName = getCanadianHoliday(date);
  const usName = getUSHoliday(date);
  
  return {
    isCanadian: !!canadianName,
    isUS: !!usName,
    canadianName,
    usName,
    isHoliday: !!canadianName || !!usName,
  };
};

/**
 * Get display text for holiday tooltip
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {string|null} Tooltip text or null if no holiday
 */
export const getHolidayTooltip = (date) => {
  const info = getHolidayInfo(date);
  if (!info.isHoliday) return null;
  
  const parts = [];
  if (info.canadianName) {
    parts.push(`🍁 ${info.canadianName} (CA)`);
  }
  if (info.usName) {
    // Don't duplicate if same name
    if (info.usName !== info.canadianName) {
      parts.push(`🇺🇸 ${info.usName} (US)`);
    } else if (!info.canadianName) {
      parts.push(`🇺🇸 ${info.usName} (US)`);
    }
  }
  
  return parts.join(' • ');
};

/**
 * Get CSS classes for holiday/weekend styling
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @param {Object} options - Styling options
 * @param {string} options.variant - 'cell' | 'box' | 'button' - different component contexts
 * @returns {Object} Object with bgClass, borderClass, and indicatorClass
 */
export const getDateStyling = (date, options = {}) => {
  const { variant = 'cell' } = options;
  const info = getHolidayInfo(date);
  const weekend = isWeekend(date);
  
  // Priority: Canadian holiday > US holiday > Weekend > Normal
  if (info.isCanadian) {
    switch (variant) {
    case 'cell':
      return {
        bgClass: 'bg-rose-50/60',
        borderClass: 'border-rose-200',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    case 'box':
      return {
        bgClass: 'bg-rose-50/40',
        borderClass: 'border-rose-300',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    case 'button':
      return {
        bgClass: 'bg-rose-100/50',
        borderClass: 'border-rose-300',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    default:
      return {
        bgClass: 'bg-rose-50/60',
        borderClass: 'border-rose-200',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    }
  }
  
  if (info.isUS) {
    switch (variant) {
    case 'cell':
      return {
        bgClass: 'bg-indigo-50/40',
        borderClass: 'border-indigo-200',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    case 'box':
      return {
        bgClass: 'bg-indigo-50/30',
        borderClass: 'border-indigo-200',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    case 'button':
      return {
        bgClass: 'bg-indigo-50/40',
        borderClass: 'border-indigo-200',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    default:
      return {
        bgClass: 'bg-indigo-50/40',
        borderClass: 'border-indigo-200',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    }
  }
  
  if (weekend) {
    switch (variant) {
    case 'cell':
      return {
        bgClass: 'bg-slate-50/50',
        borderClass: 'border-slate-200',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    case 'box':
      return {
        bgClass: 'bg-slate-50/40',
        borderClass: 'border-slate-300',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    case 'button':
      return {
        bgClass: 'bg-slate-100/30',
        borderClass: 'border-slate-300',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    default:
      return {
        bgClass: 'bg-slate-50/50',
        borderClass: 'border-slate-200',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    }
  }
  
  // Normal day
  return {
    bgClass: '',
    borderClass: '',
    indicatorClass: '',
    isHoliday: false,
    isCanadian: false,
    isUS: false,
    isWeekend: false,
  };
};

// Export raw data for potential future use
export { CANADIAN_HOLIDAYS, US_HOLIDAYS };
