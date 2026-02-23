import { createContext, useContext, useState, useCallback, useRef } from 'react';
import { dashboardAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';
import { dataCache, cacheKeys, policyForDate, TECH_POLICY, CSAT_POLICY, TTL } from '../services/dataCache';
import { formatDateLocal } from '../utils/dateHelpers';

const DashboardContext = createContext(null);

const TZ = 'America/Los_Angeles';

export function DashboardProvider({ children }) {
  // --- Shared state for all view modes ---
  const [dashboardData, setDashboardData] = useState(null);
  const [weeklyData, setWeeklyData] = useState(null);
  const [weeklyStats, setWeeklyStats] = useState(null);
  const [monthlyData, setMonthlyData] = useState(null);

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
  // Daily dashboard (cache-aware)
  // ------------------------------------------------------------------
  const fetchDashboard = useCallback(async (timezone = TZ, date = null) => {
    const mySeq = ++dailySeqRef.current;
    const dateStr = date ? (typeof date === 'string' ? date : formatDateLocal(date)) : null;
    const key = cacheKeys.dailyDashboard(timezone, dateStr);
    const policy = policyForDate(dateStr);

    const cached = dataCache.peek(key);
    if (cached) {
      setDashboardData(cached.data || cached);
      if ((cached.data || cached).timestamp) setLastFreshAt(new Date((cached.data || cached).timestamp));
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
      console.error('Dashboard fetch error:', err);
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
      console.error('Weekly stats fetch error:', err);
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

    const cached = dataCache.peek(key);
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
      console.error('Weekly dashboard fetch error:', err);
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

    const cached = dataCache.peek(key);
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
      console.error('Monthly dashboard fetch error:', err);
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
      console.error('Technician fetch error:', err);
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
      console.error('Technician weekly fetch error:', err);
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
      console.error('Technician CSAT fetch error:', err);
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

  // ------------------------------------------------------------------
  // SSE sync-completed handler with targeted invalidation
  // ------------------------------------------------------------------
  const handleSyncCompleted = useCallback((data) => {
    console.log('Sync completed, invalidating cache and refreshing:', data);

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
    console.log('SSE connected');
  }, []);

  const handleError = useCallback((error) => {
    console.error('SSE error:', error);
  }, []);

  const { isConnected: sseConnected, connectionStatus: sseConnectionStatus } = useSSE({
    enabled: autoRefresh,
    onSyncCompleted: handleSyncCompleted,
    onConnected: handleConnected,
    onError: handleError,
  });

  const value = {
    // Data
    dashboardData,
    weeklyData,
    weeklyStats,
    monthlyData,

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
