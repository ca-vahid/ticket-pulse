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

// ---------------------------------------------------------------------------
// Dynamic holiday registry — populated at runtime from the backend API
// (the `holidays` table — the SAME calendar the auto-responder and the SLA
// clocks use). Since Phase HD (QA 08-25 #3) the DB feed WINS: for any
// country+year the feed covers, the hardcoded tables above are ignored, so
// a holiday deleted/renamed in Settings is deleted/renamed on the dashboard
// too. The hardcoded tables remain an offline fallback for years the feed
// does not cover (feed unavailable, or e.g. 2027 not loaded yet).
//   _dynamicByDate   'YYYY-MM-DD' → { name, country }   (exact-date rows)
//   _dynamicByMonthDay 'MM-DD'    → { name, country }   (recurring rows)
//   _dynamicCoverage  'CA'|'US'   → Set<year>            (feed covers this year)
// ---------------------------------------------------------------------------
const _dynamicByDate = {};
const _dynamicByMonthDay = {};
const _dynamicCoverage = { CA: new Set(), US: new Set() };

const clearObject = (obj) => {
  for (const key of Object.keys(obj)) delete obj[key];
};

/**
 * Normalize an API/DB date value to its calendar key 'YYYY-MM-DD'. The
 * column is a DATE serialized as UTC midnight ("2026-09-07T00:00:00.000Z"),
 * so the calendar date is the ISO prefix — NEVER local getters, which roll
 * back a day west of UTC (the "Labour Day 8/31" bug).
 * @param {Date|string} value
 * @returns {string} 'YYYY-MM-DD' or '' when unparseable
 */
export const toCalendarDateKey = (value) => {
  if (typeof value === 'string') {
    const key = value.substring(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(key) ? key : '';
  }
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().substring(0, 10);
  }
  return '';
};

/**
 * Human-readable calendar date for a holiday row, UTC-safe. Parses the
 * calendar key at LOCAL noon so no timezone can shift the day.
 * @param {Date|string} value
 * @param {string|string[]} [locale]
 * @param {Intl.DateTimeFormatOptions} [options]
 * @returns {string}
 */
export const formatHolidayDate = (value, locale = undefined, options = undefined) => {
  const key = toCalendarDateKey(value);
  if (!key) return value ? String(value) : '';
  return new Date(`${key}T12:00:00`).toLocaleDateString(locale, options);
};

/**
 * Register holidays fetched from the backend (holidays DB table).
 * Call once after fetching GET /api/autoresponse/holidays.
 * @param {Array<{name: string, date: string, country?: string|null, isRecurring?: boolean, isEnabled?: boolean}>} holidays - from API
 */
export const registerDynamicHolidays = (holidays) => {
  clearObject(_dynamicByDate);
  clearObject(_dynamicByMonthDay);
  _dynamicCoverage.CA.clear();
  _dynamicCoverage.US.clear();
  if (!Array.isArray(holidays)) return;
  for (const h of holidays) {
    if (!h || !h.date || !h.name) continue;
    if (h.isEnabled === false) continue;
    const dateKey = toCalendarDateKey(h.date);
    if (!dateKey) continue;
    const country = typeof h.country === 'string' && h.country.trim() ? h.country.trim().toUpperCase() : null;
    const entry = { name: h.name, country };
    if (h.isRecurring) {
      _dynamicByMonthDay[dateKey.substring(5)] = entry;
    } else {
      _dynamicByDate[dateKey] = entry;
      // Only exact-date rows prove a year is covered (recurring rows carry
      // the year they were first loaded, not the years they apply to).
      if (country && _dynamicCoverage[country]) {
        _dynamicCoverage[country].add(parseInt(dateKey.substring(0, 4), 10));
      }
    }
  }
};

/**
 * Get the dynamic (DB-sourced) holiday for a date — exact date first, then
 * a recurring month-day match.
 * @returns {{name: string, country: string|null}|null}
 */
const getDynamicHoliday = (date) => {
  const dateKey = formatDateToKey(date);
  return _dynamicByDate[dateKey] || _dynamicByMonthDay[dateKey.substring(5)] || null;
};

/** True when the DB feed has exact-date rows for this country+year. */
const hasDynamicCoverage = (country, year) => _dynamicCoverage[country]?.has(year) === true;

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
  // DB feed wins (Phase HD5): a CA row names the day; a covered year with
  // no row means "not a holiday" even if the hardcoded table says so.
  const dynamic = getDynamicHoliday(date);
  if (dynamic?.country === 'CA') return dynamic.name;
  if (hasDynamicCoverage('CA', year)) return null;
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
  const dynamic = getDynamicHoliday(date);
  if (dynamic?.country === 'US') return dynamic.name;
  if (hasDynamicCoverage('US', year)) return null;
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
  // Rows without a country (custom "Add Holiday" entries) stay the generic
  // violet "📅" kind; CA/US rows already surfaced through the two getters.
  const dynamic = getDynamicHoliday(date);
  const dynamicName = dynamic?.name || null;

  return {
    isCanadian: !!canadianName,
    isUS: !!usName,
    isDynamic: !!dynamicName && !canadianName && !usName,
    canadianName,
    usName,
    dynamicName,
    isHoliday: !!canadianName || !!usName || !!dynamicName,
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
  if (info.usName && info.usName !== info.canadianName) {
    parts.push(`🇺🇸 ${info.usName} (US)`);
  }
  if (info.isDynamic) {
    parts.push(`📅 ${info.dynamicName}`);
  }
  
  return parts.join(' • ');
};

/**
 * True when the given date is today's LOCAL calendar date.
 * Mirrors formatDateLocal (utils/dateHelpers) semantics: local Y-M-D, never UTC.
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @returns {boolean}
 */
export const isDateToday = (date) => formatDateToKey(date) === formatDateToKey(new Date());

/**
 * Get CSS classes for holiday/weekend styling
 * @param {Date|string} date - Date object or date string (YYYY-MM-DD)
 * @param {Object} options - Styling options
 * @param {string} options.variant - 'cell' | 'box' | 'button' - different component contexts
 * @returns {Object} Object with bgClass, borderClass, indicatorClass + isHoliday/isWeekend/isToday flags
 */
export const getDateStyling = (date, options = {}) => ({
  ...computeDateStyling(date, options),
  isToday: isDateToday(date),
});

const computeDateStyling = (date, options = {}) => {
  const { variant = 'cell' } = options;
  const info = getHolidayInfo(date);
  const weekend = isWeekend(date);
  
  // Priority: Canadian holiday > US holiday > Weekend > Normal
  if (info.isCanadian) {
    switch (variant) {
    case 'cell':
      return {
        bgClass: 'bg-rose-50/60 dark:bg-rose-500/10',
        borderClass: 'border-rose-200 dark:border-rose-500/30',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    case 'box':
      return {
        bgClass: 'bg-rose-50/40 dark:bg-rose-500/10',
        borderClass: 'border-rose-300 dark:border-rose-500/40',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    case 'button':
      return {
        bgClass: 'bg-rose-100/50 dark:bg-rose-500/15',
        borderClass: 'border-rose-300 dark:border-rose-500/40',
        indicatorClass: 'bg-rose-500',
        isHoliday: true,
        isCanadian: true,
        isUS: info.isUS,
        isWeekend: weekend,
      };
    default:
      return {
        bgClass: 'bg-rose-50/60 dark:bg-rose-500/10',
        borderClass: 'border-rose-200 dark:border-rose-500/30',
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
        bgClass: 'bg-indigo-50/40 dark:bg-indigo-500/10',
        borderClass: 'border-indigo-200 dark:border-indigo-500/30',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    case 'box':
      return {
        bgClass: 'bg-indigo-50/30 dark:bg-indigo-500/10',
        borderClass: 'border-indigo-200 dark:border-indigo-500/30',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    case 'button':
      return {
        bgClass: 'bg-indigo-50/40 dark:bg-indigo-500/10',
        borderClass: 'border-indigo-200 dark:border-indigo-500/30',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    default:
      return {
        bgClass: 'bg-indigo-50/40 dark:bg-indigo-500/10',
        borderClass: 'border-indigo-200 dark:border-indigo-500/30',
        indicatorClass: 'bg-indigo-400',
        isHoliday: true,
        isCanadian: false,
        isUS: true,
        isWeekend: weekend,
      };
    }
  }
  
  if (info.isDynamic) {
    const base = {
      isHoliday: true,
      isCanadian: false,
      isUS: false,
      isDynamic: true,
      isWeekend: weekend,
    };
    switch (variant) {
    case 'cell':
      return { ...base, bgClass: 'bg-violet-50/60 dark:bg-violet-500/10', borderClass: 'border-violet-200 dark:border-violet-500/30', indicatorClass: 'bg-violet-500' };
    case 'box':
      return { ...base, bgClass: 'bg-violet-50/40 dark:bg-violet-500/10', borderClass: 'border-violet-300 dark:border-violet-500/40', indicatorClass: 'bg-violet-500' };
    default:
      return { ...base, bgClass: 'bg-violet-50/50 dark:bg-violet-500/10', borderClass: 'border-violet-200 dark:border-violet-500/30', indicatorClass: 'bg-violet-500' };
    }
  }

  if (weekend) {
    switch (variant) {
    case 'cell':
      return {
        bgClass: 'bg-muted/25',
        borderClass: 'border-border',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    case 'box':
      return {
        bgClass: 'bg-muted/20',
        borderClass: 'border-input',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    case 'button':
      return {
        bgClass: 'bg-muted/30',
        borderClass: 'border-input',
        indicatorClass: '',
        isHoliday: false,
        isCanadian: false,
        isUS: false,
        isWeekend: true,
      };
    default:
      return {
        bgClass: 'bg-muted/25',
        borderClass: 'border-border',
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
