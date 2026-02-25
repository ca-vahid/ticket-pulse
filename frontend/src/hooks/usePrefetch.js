import { useEffect, useRef } from 'react';
import { dataCache, cacheKeys, policyForDate, TTL } from '../services/dataCache';
import { dashboardAPI } from '../services/api';
import { formatDateLocal } from '../utils/dateHelpers';

const MAX_INFLIGHT = 3;
const COOLDOWN_MS = 30_000;
const DEBOUNCE_MS = 400;

let _inflight = 0;
const _cooldowns = new Map(); // key → timestamp of last prefetch

function shouldSkip() {
  if (typeof document !== 'undefined' && document.hidden) return true;
  if (typeof navigator !== 'undefined' && navigator.connection) {
    if (navigator.connection.saveData) return true;
    if (navigator.connection.effectiveType === '2g') return true;
  }
  return false;
}

function tryPrefetch(key, fetchFn, policy) {
  if (_inflight >= MAX_INFLIGHT) return;
  if (shouldSkip()) return;

  const lastPrefetch = _cooldowns.get(key) || 0;
  if (Date.now() - lastPrefetch < COOLDOWN_MS) return;

  if (dataCache.peek(key)) return;

  _cooldowns.set(key, Date.now());
  _inflight++;
  dataCache.prefetch(key, fetchFn, policy);
  // Release inflight slot after fetch settles (prefetch is fire-and-forget)
  Promise.resolve().then(() => {
    setTimeout(() => { _inflight = Math.max(0, _inflight - 1); }, 200);
  });
}

function scheduleIdle(fn) {
  if (typeof requestIdleCallback !== 'undefined') {
    return requestIdleCallback(fn, { timeout: 3000 });
  }
  return setTimeout(fn, 200);
}

function cancelIdle(id) {
  if (typeof cancelIdleCallback !== 'undefined') {
    cancelIdleCallback(id);
  } else {
    clearTimeout(id);
  }
}

const TZ = 'America/Los_Angeles';

/**
 * Prefetch adjacent time periods for the current view.
 * Runs after render in idle time with debounce, concurrency limits, and network guards.
 */
export function usePrefetch({ viewMode, selectedDate, selectedWeek, selectedMonth }) {
  const timerRef = useRef(null);
  const idleRef = useRef(null);

  useEffect(() => {
    // Debounce: wait for navigation to settle
    if (timerRef.current) clearTimeout(timerRef.current);
    if (idleRef.current) cancelIdle(idleRef.current);

    timerRef.current = setTimeout(() => {
      idleRef.current = scheduleIdle(() => {
        if (viewMode === 'daily' && selectedDate) {
          const prev = new Date(selectedDate);
          prev.setDate(prev.getDate() - 1);
          const next = new Date(selectedDate);
          next.setDate(next.getDate() + 1);

          const prevStr = formatDateLocal(prev);
          const nextStr = formatDateLocal(next);

          const prevPolicy = policyForDate(prevStr);
          const nextPolicy = policyForDate(nextStr);

          tryPrefetch(
            cacheKeys.dailyDashboard(TZ, prevStr),
            () => dashboardAPI.getDashboard(TZ, prevStr).then(r => r),
            prevPolicy,
          );
          tryPrefetch(
            cacheKeys.dailyDashboard(TZ, nextStr),
            () => dashboardAPI.getDashboard(TZ, nextStr).then(r => r),
            nextPolicy,
          );
          // Prefetch weekly stats for the same week
          tryPrefetch(
            cacheKeys.weeklyStats(TZ, formatDateLocal(selectedDate)),
            () => dashboardAPI.getWeeklyStats(TZ, formatDateLocal(selectedDate)).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );
          // Prefetch current week's weekly dashboard for quick view switching
          const dayOfWeek = (selectedDate.getDay() + 6) % 7;
          const monday = new Date(selectedDate);
          monday.setDate(selectedDate.getDate() - dayOfWeek);
          const weekStr = formatDateLocal(monday);
          tryPrefetch(
            cacheKeys.weeklyDashboard(TZ, weekStr),
            () => dashboardAPI.getWeeklyDashboard(weekStr, TZ).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );

        } else if (viewMode === 'weekly' && selectedWeek) {
          const prevWeek = new Date(selectedWeek);
          prevWeek.setDate(prevWeek.getDate() - 7);
          const nextWeek = new Date(selectedWeek);
          nextWeek.setDate(nextWeek.getDate() + 7);

          const prevStr = formatDateLocal(prevWeek);
          const nextStr = formatDateLocal(nextWeek);

          tryPrefetch(
            cacheKeys.weeklyDashboard(TZ, prevStr),
            () => dashboardAPI.getWeeklyDashboard(prevStr, TZ).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );
          tryPrefetch(
            cacheKeys.weeklyDashboard(TZ, nextStr),
            () => dashboardAPI.getWeeklyDashboard(nextStr, TZ).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );
          // Prefetch today's daily dashboard for quick view switching
          tryPrefetch(
            cacheKeys.dailyDashboard(TZ, null),
            () => dashboardAPI.getDashboard(TZ, null).then(r => r),
            policyForDate(null),
          );

        } else if (viewMode === 'monthly' && selectedMonth) {
          const prevMonth = new Date(selectedMonth);
          prevMonth.setMonth(prevMonth.getMonth() - 1);
          const nextMonth = new Date(selectedMonth);
          nextMonth.setMonth(nextMonth.getMonth() + 1);

          const prevStr = formatDateLocal(prevMonth);
          const nextStr = formatDateLocal(nextMonth);

          tryPrefetch(
            cacheKeys.monthlyDashboard(TZ, prevStr),
            () => dashboardAPI.getMonthlyDashboard(prevStr, TZ).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );
          tryPrefetch(
            cacheKeys.monthlyDashboard(TZ, nextStr),
            () => dashboardAPI.getMonthlyDashboard(nextStr, TZ).then(r => r),
            { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
          );
        }
      });
    }, DEBOUNCE_MS);

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
      if (idleRef.current) cancelIdle(idleRef.current);
    };
  }, [viewMode, selectedDate, selectedWeek, selectedMonth]);
}

/**
 * Prefetch a single technician detail endpoint (call on hover/focus).
 */
export function prefetchTechDetail(techId, viewMode, selectedDate, selectedWeek) {
  if (shouldSkip()) return;

  if (viewMode === 'weekly' && selectedWeek) {
    const weekStr = typeof selectedWeek === 'string' ? selectedWeek : formatDateLocal(selectedWeek);
    const key = cacheKeys.techWeekly(techId, TZ, weekStr);
    tryPrefetch(key, () => dashboardAPI.getTechnicianWeekly(techId, weekStr, TZ).then(r => r), {
      ttl: TTL.TECH,
      softTtl: TTL.TECH_SOFT,
    });
  } else {
    const dateStr = selectedDate ? (typeof selectedDate === 'string' ? selectedDate : formatDateLocal(selectedDate)) : null;
    const key = cacheKeys.techDaily(techId, TZ, dateStr);
    tryPrefetch(key, () => dashboardAPI.getTechnician(techId, TZ, dateStr).then(r => r), {
      ttl: TTL.TECH,
      softTtl: TTL.TECH_SOFT,
    });
  }
}
