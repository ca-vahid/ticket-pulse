import { createContext, useContext, useState, useCallback, useRef, useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { dashboardAPI, getWorkspaceId } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { dataCache, cacheKeys, policyForDate, TECH_POLICY, CSAT_POLICY, TTL } from '../services/dataCache';
import { formatDateLocal } from '../utils/dateHelpers';

const DashboardContext = createContext(null);

const TZ = 'America/Los_Angeles';

// Try to restore dashboard state from cache on mount (avoids loading flash on back-nav / F5)
function peekCachedDashboard(type) {
  const wsId = getWorkspaceId();
  const wsTag = wsId ? `ws${wsId}:` : '';
  const prefixes = {
    daily: `${wsTag}dashboard:daily:`,
    weekly: `${wsTag}dashboard:weekly:`,
    monthly: `${wsTag}dashboard:monthly:`,
    weekStats: `${wsTag}dashboard:weekStats:`,
  };
  const prefix = prefixes[type];
  if (!prefix) return null;

  let best = null;
  let bestFetched = 0;
  for (let i = 0; i < sessionStorage.length; i++) {
    const rawKey = sessionStorage.key(i);
    if (!rawKey || !rawKey.startsWith('tp_cache:' + prefix)) continue;
    try {
      const payload = JSON.parse(sessionStorage.getItem(rawKey));
      if (payload?.data && Date.now() <= payload.expiresAt && payload.fetchedAt > bestFetched) {
        best = payload.data;
        bestFetched = payload.fetchedAt;
      }
    } catch (_) { /* ignore */ }
  }
  return best;
}

export function DashboardProvider({ children }) {
  const location = useLocation();
  // --- Shared state for all view modes ---
  // Initialize from sessionStorage cache to prevent loading flash on back-nav / F5
  const [dashboardData, setDashboardData] = useState(() => {
    const cached = peekCachedDashboard('daily');
    return cached?.data || cached || null;
  });
  const [weeklyData, setWeeklyData] = useState(() => {
    const cached = peekCachedDashboard('weekly');
    return cached?.data || cached || null;
  });
  const [weeklyStats, setWeeklyStats] = useState(() => {
    const cached = peekCachedDashboard('weekStats');
    const payload = cached?.data || cached;
    return payload?.dailyCounts ?? payload ?? null;
  });
  const [monthlyData, setMonthlyData] = useState(() => {
    const cached = peekCachedDashboard('monthly');
    return cached?.data || cached || null;
  });

  const [isColdLoading, setIsColdLoading] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [error, setError] = useState(null);
  const [lastFreshAt, setLastFreshAt] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Request version refs for race-safety
  const dailySeqRef = useRef(0);
  const weeklySeqRef = useRef(0);
  const weeklyStatsSeqRef = useRef(0);
  const monthlySeqRef = useRef(0);

  // Track current view so SSE knows what to invalidate/refresh
  const currentViewRef = useRef({ viewMode: 'daily', date: null, weekStart: null, monthStart: null });

  const setCurrentView = useCallback((viewMode, date, weekStart, monthStart) => {
    currentViewRef.current = { viewMode, date, weekStart, monthStart };
  }, []);

  // ------------------------------------------------------------------
  // Speculative prefetch: warm cache while auth is still checking.
  // Uses _speculative flag to suppress 401 → auth:unauthorized dispatch.
  // Prefetches weekly (default view), daily, and weekly stats.
  // ------------------------------------------------------------------
  useEffect(() => {
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek);
    monday.setHours(0, 0, 0, 0);
    const weekStr = formatDateLocal(monday);

    const weeklyKey = cacheKeys.weeklyDashboard(TZ, weekStr);
    dataCache.prefetch(
      weeklyKey,
      () => dashboardAPI.getWeeklyDashboard(weekStr, TZ),
      { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
    );

    const todayKey = cacheKeys.dailyDashboard(TZ, null);
    const todayPolicy = policyForDate(null);
    dataCache.prefetch(
      todayKey,
      () => dashboardAPI.getDashboard(TZ, null),
      todayPolicy,
    );

    const weekStatsKey = cacheKeys.weeklyStats(TZ, null);
    dataCache.prefetch(
      weekStatsKey,
      () => dashboardAPI.getWeeklyStats(TZ, null),
      { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT },
    );
  }, []);

  // ------------------------------------------------------------------
  // Daily dashboard (cache-aware)
  // ------------------------------------------------------------------
  const fetchDashboard = useCallback(async (timezone = TZ, date = null) => {
    const mySeq = ++dailySeqRef.current;
    const dateStr = date ? (typeof date === 'string' ? date : formatDateLocal(date)) : null;
    const key = cacheKeys.dailyDashboard(timezone, dateStr);
    const policy = policyForDate(dateStr);

    // Show any cached data (even expired) to avoid the loading overlay
    const cached = dataCache.peek(key) || dataCache.peekStale(key);
    if (cached) {
      const payload = cached.data || cached;
      setDashboardData(payload);
      if (payload.timestamp) setLastFreshAt(new Date(payload.timestamp));
      setIsRefreshing(true);
      setIsColdLoading(false);
    } else {
      setIsColdLoading(true);
    }
    setError(null);

    try {
      const result = await dataCache.getOrFetch(
        key,
        () => dashboardAPI.getDashboard(timezone, dateStr),
        policy,
      );
      if (mySeq !== dailySeqRef.current) return;
      const payload = result.data?.data || result.data;
      setDashboardData(payload);
      if (payload?.timestamp) setLastFreshAt(new Date(payload.timestamp));
    } catch (err) {
      if (mySeq !== dailySeqRef.current) return;
      console.warn('Dashboard fetch error:', err.message);
      setError(err.message);
    } finally {
      if (mySeq === dailySeqRef.current) {
        setIsColdLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // ------------------------------------------------------------------
  // Weekly stats (calendar day counts)
  // ------------------------------------------------------------------
  const fetchWeeklyStats = useCallback(async (timezone = TZ, dateStr = null) => {
    const mySeq = ++weeklyStatsSeqRef.current;
    const key = cacheKeys.weeklyStats(timezone, dateStr);
    const policy = { ttl: TTL.HIST, softTtl: TTL.HIST_SOFT };

    try {
      const result = await dataCache.getOrFetch(
        key,
        () => dashboardAPI.getWeeklyStats(timezone, dateStr),
        policy,
      );
      if (mySeq !== weeklyStatsSeqRef.current) return;
      const payload = result.data?.data || result.data;
      setWeeklyStats(payload?.dailyCounts ?? payload);
    } catch (err) {
      if (mySeq !== weeklyStatsSeqRef.current) return;
      console.warn('Weekly stats fetch error:', err.message);
      setWeeklyStats(null);
    }
  }, []);

  // ------------------------------------------------------------------
  // Weekly dashboard
  // ------------------------------------------------------------------
  const fetchWeeklyDashboard = useCallback(async (weekStartStr, timezone = TZ) => {
    const mySeq = ++weeklySeqRef.current;
    const key = cacheKeys.weeklyDashboard(timezone, weekStartStr);
    const policy = policyForDate(weekStartStr);

    const cached = dataCache.peek(key) || dataCache.peekStale(key);
    if (cached) {
      const payload = cached?.data || cached;
      setWeeklyData(payload);
      setIsRefreshing(true);
      setIsColdLoading(false);
    } else {
      setIsColdLoading(true);
    }
    setError(null);

    try {
      const result = await dataCache.getOrFetch(
        key,
        () => dashboardAPI.getWeeklyDashboard(weekStartStr, timezone),
        policy,
      );
      if (mySeq !== weeklySeqRef.current) return;
      const payload = result.data?.data || result.data;
      setWeeklyData(payload);
    } catch (err) {
      if (mySeq !== weeklySeqRef.current) return;
      console.warn('Weekly dashboard fetch error:', err.message);
      setWeeklyData(null);
    } finally {
      if (mySeq === weeklySeqRef.current) {
        setIsColdLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // ------------------------------------------------------------------
  // Monthly dashboard
  // ------------------------------------------------------------------
  const fetchMonthlyDashboard = useCallback(async (monthStartStr, timezone = TZ) => {
    const mySeq = ++monthlySeqRef.current;
    const key = cacheKeys.monthlyDashboard(timezone, monthStartStr);
    const policy = policyForDate(monthStartStr);

    const cached = dataCache.peek(key) || dataCache.peekStale(key);
    if (cached) {
      const payload = cached?.data || cached;
      setMonthlyData(payload);
      setIsRefreshing(true);
      setIsColdLoading(false);
    } else {
      setIsColdLoading(true);
    }
    setError(null);

    try {
      const result = await dataCache.getOrFetch(
        key,
        () => dashboardAPI.getMonthlyDashboard(monthStartStr, timezone),
        policy,
      );
      if (mySeq !== monthlySeqRef.current) return;
      const payload = result.data?.data || result.data;
      setMonthlyData(payload);
    } catch (err) {
      if (mySeq !== monthlySeqRef.current) return;
      console.warn('Monthly dashboard fetch error:', err.message);
      setMonthlyData(null);
    } finally {
      if (mySeq === monthlySeqRef.current) {
        setIsColdLoading(false);
        setIsRefreshing(false);
      }
    }
  }, []);

  // ------------------------------------------------------------------
  // Technician detail (daily) — cache-aware
  // ------------------------------------------------------------------
  const getTechnician = useCallback(async (id, timezone = TZ, date = null) => {
    const dateStr = date ? (typeof date === 'string' ? date : formatDateLocal(date)) : null;
    const key = cacheKeys.techDaily(id, timezone, dateStr);
    const policy = policyForDate(dateStr);

    try {
      const result = await dataCache.getOrFetch(
        key,
        async () => {
          const response = await dashboardAPI.getTechnician(id, timezone, dateStr);
          if (response.success && response.data) return response.data;
          throw new Error('Failed to fetch technician data');
        },
        policy,
      );
      return result.data;
    } catch (err) {
      console.warn('Technician fetch error:', err.message);
      throw err;
    }
  }, []);

  // ------------------------------------------------------------------
  // Technician detail (weekly) — cache-aware
  // ------------------------------------------------------------------
  const getTechnicianWeekly = useCallback(async (id, weekStart = null, timezone = TZ) => {
    const weekStr = weekStart ? (typeof weekStart === 'string' ? weekStart : formatDateLocal(weekStart)) : null;
    const key = cacheKeys.techWeekly(id, timezone, weekStr);

    try {
      const result = await dataCache.getOrFetch(
        key,
        async () => {
          const response = await dashboardAPI.getTechnicianWeekly(id, weekStr, timezone);
          if (response.success && response.data) return response.data;
          throw new Error('Failed to fetch technician weekly data');
        },
        TECH_POLICY,
      );
      return result.data;
    } catch (err) {
      console.warn('Technician weekly fetch error:', err.message);
      throw err;
    }
  }, []);

  // ------------------------------------------------------------------
  // Technician CSAT — cache-aware
  // ------------------------------------------------------------------
  const getTechnicianCSAT = useCallback(async (id) => {
    const key = cacheKeys.techCSAT(id);

    try {
      const result = await dataCache.getOrFetch(
        key,
        () => dashboardAPI.getTechnicianCSAT(id),
        CSAT_POLICY,
      );
      return result.data;
    } catch (err) {
      console.warn('Technician CSAT fetch error:', err.message);
      throw err;
    }
  }, []);

  // ------------------------------------------------------------------
  // Invalidation helpers
  // ------------------------------------------------------------------
  const invalidateToday = useCallback(() => {
    const todayStr = formatDateLocal(new Date());
    dataCache.invalidateByPredicate(key =>
      key.includes('date=today')
      || key.includes(`date=${todayStr}`),
    );
  }, []);

  const invalidateCurrentWeek = useCallback(() => {
    const now = new Date();
    const dayOfWeek = (now.getDay() + 6) % 7;
    const monday = new Date(now);
    monday.setDate(now.getDate() - dayOfWeek);
    const weekStr = formatDateLocal(monday);
    dataCache.invalidateByPredicate(key =>
      key.includes(`weekStart=${weekStr}`),
    );
  }, []);

  const invalidateCurrentMonth = useCallback(() => {
    const now = new Date();
    const monthStr = formatDateLocal(new Date(now.getFullYear(), now.getMonth(), 1));
    dataCache.invalidateByPredicate(key =>
      key.includes(`monthStart=${monthStr}`),
    );
  }, []);

  /**
   * Invalidate cache entries that overlap a date range (for sync-week backfills).
   */
  const invalidateDateRange = useCallback((startDate, endDate) => {
    dataCache.invalidateByPredicate(key => {
      // Invalidate daily keys within the range
      const dailyMatch = key.match(/date=(\d{4}-\d{2}-\d{2})/);
      if (dailyMatch) {
        const d = dailyMatch[1];
        if (d >= startDate && d <= endDate) return true;
      }
      // Invalidate weekly keys whose week overlaps the range
      const weekMatch = key.match(/weekStart=(\d{4}-\d{2}-\d{2})/);
      if (weekMatch) {
        const ws = weekMatch[1];
        const wEnd = new Date(ws + 'T00:00:00');
        wEnd.setDate(wEnd.getDate() + 6);
        const weStr = formatDateLocal(wEnd);
        if (ws <= endDate && weStr >= startDate) return true;
      }
      // Invalidate monthly keys whose month overlaps the range
      const monthMatch = key.match(/monthStart=(\d{4}-\d{2}-\d{2})/);
      if (monthMatch) {
        const ms = monthMatch[1];
        const mEnd = new Date(ms + 'T00:00:00');
        mEnd.setMonth(mEnd.getMonth() + 1);
        mEnd.setDate(mEnd.getDate() - 1);
        const meStr = formatDateLocal(mEnd);
        if (ms <= endDate && meStr >= startDate) return true;
      }
      return false;
    });
  }, []);

  const invalidateAllForTimezoneChange = useCallback(() => {
    dataCache.invalidateByPredicate(key => key.includes('tz='));
  }, []);

  const clearCacheOnLogout = useCallback(() => {
    dataCache.clear();
  }, []);

  /**
   * Manual refresh: invalidate current view keys, then re-fetch.
   */
  const invalidateCurrentView = useCallback(() => {
    const { viewMode, date, weekStart, monthStart } = currentViewRef.current;
    if (viewMode === 'daily') {
      const key = cacheKeys.dailyDashboard(TZ, date);
      dataCache.invalidateByKeys([key]);
    } else if (viewMode === 'weekly') {
      const key = cacheKeys.weeklyDashboard(TZ, weekStart);
      const statsKey = cacheKeys.weeklyStats(TZ, weekStart);
      dataCache.invalidateByKeys([key, statsKey]);
    } else if (viewMode === 'monthly') {
      const key = cacheKeys.monthlyDashboard(TZ, monthStart);
      dataCache.invalidateByKeys([key]);
    }
  }, []);

  const forceRefreshNoCache = useCallback(async () => {
    dataCache.clear();
    const { viewMode, date, weekStart, monthStart } = currentViewRef.current;
    setError(null);
    setIsRefreshing(true);
    try {
      if (viewMode === 'weekly') {
        const res = await dashboardAPI.getWeeklyDashboard(weekStart, TZ);
        const payload = res?.data || res;
        setWeeklyData(payload);
        const statsRes = await dashboardAPI.getWeeklyStats(TZ, weekStart);
        const statsPayload = statsRes?.data || statsRes;
        setWeeklyStats(statsPayload?.dailyCounts ?? statsPayload);
      } else if (viewMode === 'monthly') {
        const res = await dashboardAPI.getMonthlyDashboard(monthStart, TZ);
        const payload = res?.data || res;
        setMonthlyData(payload);
      } else {
        const res = await dashboardAPI.getDashboard(TZ, date);
        const payload = res?.data || res;
        setDashboardData(payload);
        const statsRes = await dashboardAPI.getWeeklyStats(TZ, date);
        const statsPayload = statsRes?.data || statsRes;
        setWeeklyStats(statsPayload?.dailyCounts ?? statsPayload);
      }
    } catch (err) {
      console.error('Force refresh error:', err);
      setError(err.message || 'Failed to refresh dashboard data');
      throw err;
    } finally {
      setIsColdLoading(false);
      setIsRefreshing(false);
    }
  }, []);

  // ------------------------------------------------------------------
  // SSE sync-completed handler with targeted invalidation
  // ------------------------------------------------------------------
  const handleSyncCompleted = useCallback((_data) => {
    // Invalidate cache and refresh after sync completion

    // Invalidate today + current week + current month
    invalidateToday();
    invalidateCurrentWeek();
    invalidateCurrentMonth();

    // Re-fetch whatever view the user is currently looking at
    const { viewMode, date, weekStart, monthStart } = currentViewRef.current;
    if (viewMode === 'daily') {
      fetchDashboard(TZ, date);
    } else if (viewMode === 'weekly') {
      fetchWeeklyDashboard(weekStart, TZ);
    } else if (viewMode === 'monthly') {
      fetchMonthlyDashboard(monthStart, TZ);
    }
  }, [invalidateToday, invalidateCurrentWeek, invalidateCurrentMonth, fetchDashboard, fetchWeeklyDashboard, fetchMonthlyDashboard]);

  const handleConnected = useCallback(() => {
    // SSE connection established
  }, []);

  const handleError = useCallback(() => {
    // SSE errors are handled by useSSE (reconnect with backoff).
    // No additional logging needed here.
  }, []);

  const dashboardSseEnabled = autoRefresh && [
    '/dashboard',
    '/technician',
    '/timeline',
    '/analytics',
    '/visuals',
  ].some((path) => location.pathname === path || location.pathname.startsWith(`${path}/`));

  const { isConnected: sseConnected, connectionStatus: sseConnectionStatus } = useSSE({
    enabled: dashboardSseEnabled,
    onSyncCompleted: handleSyncCompleted,
    onConnected: handleConnected,
    onError: handleError,
    reconnectKey: getWorkspaceId(),
  });

  const primaryDataReady = !!(dashboardData || weeklyData || monthlyData);

  const value = {
    // Data
    dashboardData,
    weeklyData,
    weeklyStats,
    monthlyData,
    primaryDataReady,

    // Loading states
    isColdLoading,
    isRefreshing,
    isLoading: isColdLoading, // backward compat
    error,
    lastFreshAt,
    lastUpdated: lastFreshAt, // backward compat

    // SSE
    autoRefresh,
    sseConnected,
    sseConnectionStatus,
    setAutoRefresh,

    // Fetch methods (cache-aware)
    fetchDashboard,
    fetchWeeklyStats,
    fetchWeeklyDashboard,
    fetchMonthlyDashboard,
    getTechnician,
    getTechnicianWeekly,
    getTechnicianCSAT,

    // View tracking (for SSE refresh targeting)
    setCurrentView,

    // Invalidation
    invalidateToday,
    invalidateCurrentWeek,
    invalidateCurrentMonth,
    invalidateDateRange,
    invalidateCurrentView,
    invalidateAllForTimezoneChange,
    clearCacheOnLogout,
    forceRefreshNoCache,
  };

  return (
    <DashboardContext.Provider value={value}>
      {children}
    </DashboardContext.Provider>
  );
}

export function useDashboard() {
  const context = useContext(DashboardContext);
  if (!context) {
    throw new Error('useDashboard must be used within a DashboardProvider');
  }
  return context;
}
