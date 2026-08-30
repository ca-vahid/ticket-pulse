import { useEffect, useState, useCallback } from 'react';
import { useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { analyticsAPI, syncAPI, getGlobalExcludeNoise, setGlobalExcludeNoise } from '../services/api';
import AppShell, { APP_BACKGROUND_CLASS, APP_BACKGROUND_STYLE } from '../components/AppShell';
import DashboardLoadingProgress from '../components/DashboardLoadingProgress';
import DemoModeToggle from '../components/DemoModeToggle';
import TechCard from '../components/TechCard';
import TechCardCompact from '../components/TechCardCompact';
import TechCompactHeader from '../components/TechCompactHeader';
import { getSortValue, getCompactMinWidth } from '../components/compactLayout';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import CanonicalCategoryFilter from '../components/CanonicalCategoryFilter';
import LegendPopover from '../components/LegendPopover';
import MonthlyCalendar from '../components/MonthlyCalendar';
import { filterTickets, getTicketCategoryLabel, hasCategoryFilters } from '../utils/ticketFilter';
import { getHolidayTooltip, getHolidayInfo, registerDynamicHolidays } from '../utils/holidays';
import api from '../services/api';
import { usePrefetch } from '../hooks/usePrefetch';
import {
  CheckCircle,
  XCircle,
  Activity,
  RefreshCw,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Calendar,
  Eye,
  EyeOff,
  LayoutGrid,
  List,
  VolumeX,
  Volume2,
} from 'lucide-react';

export default function Dashboard() {
  const {
    dashboardData,
    weeklyData,
    weeklyStats,
    monthlyData,
    primaryDataReady,
    isColdLoading,
    isLoading,
    error,
    fetchDashboard,
    fetchWeeklyStats,
    fetchWeeklyDashboard,
    fetchMonthlyDashboard,
    setCurrentView,
    invalidateCurrentView,
    invalidateDateRange,
    clearCacheOnLogout,
    forceRefreshNoCache,
  } = useDashboard();
  const { currentWorkspace } = useWorkspace();
  const location = useLocation();
  const showSummitWorkshop = Number(currentWorkspace?.id) === 1 || currentWorkspace?.slug === 'it';
  const [categoryMetadata, setCategoryMetadata] = useState(null);

  const [refreshing, setRefreshing] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null); // null, 'syncing', 'success', 'error'
  const [syncMessage, setSyncMessage] = useState('');
  const [syncLogs, setSyncLogs] = useState([]); // Array of log messages
  const [showSyncDetails, setShowSyncDetails] = useState(false);
  const [backgroundSyncRunning, setBackgroundSyncRunning] = useState(false);
  const [backgroundSyncStep, setBackgroundSyncStep] = useState(null);
  const [killingSync, setKillingSync] = useState(false);

  // Initialize selectedDate from localStorage, navigation state, or default to today
  const [selectedDate, setSelectedDate] = useState(() => {
    // Priority 1: Navigation state (when returning from detail page)
    const returnDate = location.state?.returnDate;
    if (returnDate) {
      return typeof returnDate === 'string' ? new Date(returnDate + 'T12:00:00') : new Date(returnDate);
    }

    // Priority 2: localStorage (persists across browser refreshes)
    const stored = localStorage.getItem('dashboardSelectedDate');
    if (stored) {
      return new Date(stored);
    }

    // Priority 3: Default to today
    return new Date();
  });
  const [hiddenTechIds, setHiddenTechIds] = useState(() => {
    // Load hidden tech IDs from localStorage on mount
    const stored = localStorage.getItem('hiddenTechnicians');
    return stored ? JSON.parse(stored) : [];
  });
  const [showHidden, setShowHidden] = useState(false);
  // Mobile stats bottom sheet (the summary strip's tap-to-expand detail view)
  const [statsSheetOpen, setStatsSheetOpen] = useState(false);
  useEffect(() => {
    if (!statsSheetOpen) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') setStatsSheetOpen(false); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [statsSheetOpen]);

  // Search state - persisted in sessionStorage
  const [searchTerm, setSearchTerm] = useState(() => {
    // Priority: navigation state > sessionStorage > default
    const returnSearch = location.state?.searchTerm;
    if (returnSearch !== undefined) return returnSearch;

    const stored = sessionStorage.getItem('dashboard_search');
    return stored || '';
  });

  // Category filter state - persisted in sessionStorage
  const [selectedCategories, setSelectedCategories] = useState(() => {
    // Priority: navigation state > sessionStorage > default
    const returnCategories = location.state?.selectedCategories;
    if (returnCategories !== undefined) return returnCategories;

    const stored = sessionStorage.getItem('dashboard_categories');
    return stored ? JSON.parse(stored) : [];
  });
  const [selectedCanonicalCategories, setSelectedCanonicalCategories] = useState(() => {
    const nav = location.state?.canonicalCategoryFilter;
    if (nav) return nav;
    const stored = sessionStorage.getItem('dashboard_canonical_categories');
    return stored ? JSON.parse(stored) : { categoryIds: [], subcategoryIds: [] };
  });

  // Noise filter
  const [excludeNoise, setExcludeNoise] = useState(() => getGlobalExcludeNoise());

  // Compact view state - persisted in localStorage
  const [isCompactView, setIsCompactView] = useState(() => {
    const stored = localStorage.getItem('compactView');
    return stored !== null ? JSON.parse(stored) : true;
  });

  // Card style — 'detailed' (rich colors + icons) vs 'simple' (plain numbers,
  // full-word labels, QA 07-30 #8/#9). Persisted in localStorage.
  const [dashStyle, setDashStyle] = useState(() => localStorage.getItem('tp_dash_style') || 'detailed');
  const simpleStyle = dashStyle === 'simple';
  const handleDashStyle = (style) => {
    setDashStyle(style);
    try {
      localStorage.setItem('tp_dash_style', style);
    } catch {
      // localStorage may be unavailable (private mode); silently ignore
    }
  };

  // Expand-all override for compact view: null = individual control, true/false = forced
  const [expandAllOverride, setExpandAllOverride] = useState(null);

  // Compact-table sort state — persisted in localStorage. `field === null`
  // means "use the default sort (total load for the current view, desc)".
  const [compactSort, setCompactSort] = useState(() => {
    try {
      const stored = localStorage.getItem('compactSort');
      if (stored) {
        const parsed = JSON.parse(stored);
        if (parsed && typeof parsed === 'object') return parsed;
      }
    } catch {
      // ignore JSON parse errors and fall through to default
    }
    return { field: null, direction: 'desc' };
  });

  const handleCompactSort = (field, direction) => {
    const next = { field, direction };
    setCompactSort(next);
    try {
      localStorage.setItem('compactSort', JSON.stringify(next));
    } catch {
      // localStorage may be unavailable (private mode); silently ignore
    }
  };

  // Collapsible sections state - persisted in localStorage
  const [collapsedSections, setCollapsedSections] = useState(() => {
    const stored = localStorage.getItem('collapsedSections');
    return stored ? JSON.parse(stored) : { light: true }; // Light load collapsed by default
  });

  // Daily/Weekly/Monthly view toggle state - restore from localStorage or navigation state
  const [viewMode, setViewMode] = useState(() => {
    // Priority 1: Navigation state
    if (location.state?.viewMode) {
      return location.state.viewMode;
    }

    // Priority 2: localStorage (persists across browser refreshes)
    const stored = localStorage.getItem('dashboardViewMode');
    if (stored) {
      return stored;
    }

    // Priority 3: Default to weekly (best overview for first-time users)
    return 'weekly';
  });

  // Selected week (Monday) for weekly view - restore from localStorage or navigation state
  const [selectedWeek, setSelectedWeek] = useState(() => {
    // Priority 1: Navigation state
    const returnWeek = location.state?.returnWeek;
    if (returnWeek) {
      return new Date(returnWeek + 'T12:00:00');
    }

    // Priority 2: localStorage (persists across browser refreshes)
    const stored = localStorage.getItem('dashboardSelectedWeek');
    if (stored) {
      return new Date(stored);
    }

    // Priority 3: Calculate current week's Monday
    const now = new Date();
    const currentDay = (now.getDay() + 6) % 7; // Convert to Monday=0
    const monday = new Date(now);
    monday.setDate(now.getDate() - currentDay);
    monday.setHours(0, 0, 0, 0);
    return monday;
  });

  // Selected month (first day) for monthly view - restore from localStorage or navigation state
  const [selectedMonth, setSelectedMonth] = useState(() => {
    // Priority 1: Navigation state
    const returnMonth = location.state?.returnMonth;
    if (returnMonth) {
      return new Date(returnMonth + 'T12:00:00');
    }

    // Priority 2: localStorage (persists across browser refreshes)
    const stored = localStorage.getItem('dashboardSelectedMonth');
    if (stored) {
      return new Date(stored);
    }

    // Priority 3: Calculate current month's first day
    const now = new Date();
    return new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0);
  });

  // Persist selectedDate to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardSelectedDate', selectedDate.toISOString());
  }, [selectedDate]);

  // Persist selectedWeek to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardSelectedWeek', selectedWeek.toISOString());
  }, [selectedWeek]);

  // Persist selectedMonth to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardSelectedMonth', selectedMonth.toISOString());
  }, [selectedMonth]);

  // Persist viewMode to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardViewMode', viewMode);
  }, [viewMode]);

  // Fetch workspace holidays from DB and register them for calendar display.
  // The registry is module state, so bump a counter after registering — the
  // calendar cells compute their holiday styling during render, and since
  // Phase HD the feed WINS over the hardcoded tables, a frame rendered before
  // the feed arrives would otherwise keep the fallback names until the next
  // unrelated re-render.
  const [, setHolidayFeedVersion] = useState(0);
  useEffect(() => {
    api.get('/autoresponse/holidays').then(res => {
      registerDynamicHolidays(res?.data || []);
      setHolidayFeedVersion((v) => v + 1);
    }).catch(() => {});
  }, [currentWorkspace?.id]);

  // Persist search term to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('dashboard_search', searchTerm);
  }, [searchTerm]);

  // Persist selected categories to sessionStorage whenever they change
  useEffect(() => {
    sessionStorage.setItem('dashboard_categories', JSON.stringify(selectedCategories));
  }, [selectedCategories]);
  useEffect(() => {
    sessionStorage.setItem('dashboard_canonical_categories', JSON.stringify(selectedCanonicalCategories));
  }, [selectedCanonicalCategories]);

  useEffect(() => {
    let cancelled = false;
    analyticsAPI.getCategories()
      .then((res) => {
        if (!cancelled) setCategoryMetadata(res?.data || res || null);
      })
      .catch(() => {
        if (!cancelled) setCategoryMetadata(null);
      });
    return () => { cancelled = true; };
  }, [currentWorkspace?.id]);

  // Helper function to format date as YYYY-MM-DD in local timezone
  const formatDateLocal = useCallback((date) => {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }, []);

  // Track current view for SSE-driven targeted invalidation
  useEffect(() => {
    const dateStr = formatDateLocal(selectedDate);
    const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
    setCurrentView(
      viewMode,
      isCurrentDay ? null : dateStr,
      formatDateLocal(selectedWeek),
      formatDateLocal(selectedMonth),
    );
  }, [viewMode, selectedDate, selectedWeek, selectedMonth, setCurrentView, formatDateLocal]);

  // Prefetch adjacent time periods (gated on primary data having arrived)
  usePrefetch({ viewMode, selectedDate, selectedWeek, selectedMonth, primaryDataReady });

  // Smart handler for switching to daily view
  const handleSwitchToDaily = useCallback(() => {
    // Calculate which day of week today is
    const today = new Date();
    const todayDayOfWeek = (today.getDay() + 6) % 7; // Convert to Monday=0

    // Calculate the same day of week from the selected week
    const targetDate = new Date(selectedWeek);
    targetDate.setDate(selectedWeek.getDate() + todayDayOfWeek);

    setSelectedDate(targetDate);
    setViewMode('daily');
  }, [selectedWeek]);

  // Smart handler for switching to weekly view
  const handleSwitchToWeekly = useCallback(() => {
    // Calculate Monday of the selected date's week
    const currentDay = (selectedDate.getDay() + 6) % 7; // Convert to Monday=0
    const monday = new Date(selectedDate);
    monday.setDate(selectedDate.getDate() - currentDay);
    monday.setHours(0, 0, 0, 0);

    setSelectedWeek(monday);
    setViewMode('weekly');
  }, [selectedDate]);

  // Smart handler for switching to monthly view
  const handleSwitchToMonthly = useCallback(() => {
    // Calculate first day of the selected date's month
    const firstDay = new Date(selectedDate.getFullYear(), selectedDate.getMonth(), 1, 0, 0, 0);
    
    setSelectedMonth(firstDay);
    setViewMode('monthly');
  }, [selectedDate]);

  // Fetch dashboard data on mount and when date changes
  useEffect(() => {
    const dateStr = formatDateLocal(selectedDate);
    const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
    fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
  }, [selectedDate, fetchDashboard, formatDateLocal]);

  // Fetch weekly stats when selected date or week changes
  useEffect(() => {
    const dateToUse = viewMode === 'weekly' ? selectedWeek : selectedDate;
    const dateStr = formatDateLocal(dateToUse);
    fetchWeeklyStats('America/Los_Angeles', dateStr);
  }, [selectedDate, selectedWeek, viewMode, formatDateLocal, fetchWeeklyStats]);

  // Fetch weekly dashboard data when in weekly mode or selectedWeek changes
  useEffect(() => {
    if (viewMode !== 'weekly') return;
    const weekStartStr = formatDateLocal(selectedWeek);
    fetchWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
  }, [viewMode, selectedWeek, formatDateLocal, fetchWeeklyDashboard]);

  // Fetch monthly dashboard data when in monthly mode or selectedMonth changes
  useEffect(() => {
    if (viewMode !== 'monthly') return;
    const monthStartStr = formatDateLocal(selectedMonth);
    fetchMonthlyDashboard(monthStartStr, 'America/Los_Angeles');
  }, [viewMode, selectedMonth, formatDateLocal, fetchMonthlyDashboard]);

  // Poll for background sync status every 5 seconds (deferred until primary data arrives)
  useEffect(() => {
    if (!primaryDataReady) return;

    const checkBackgroundSync = async () => {
      try {
        const status = await syncAPI.getStatus();
        const isRunning = status.data?.sync?.isRunning || false;
        setBackgroundSyncRunning(isRunning);
        setBackgroundSyncStep(status.data?.sync?.progress?.currentStep || null);
      } catch (err) {
        // Ignore errors, sync status is not critical
      }
    };

    checkBackgroundSync();

    const interval = setInterval(checkBackgroundSync, 5000);

    return () => clearInterval(interval);
  }, [primaryDataReady]);

  const addSyncLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();

    // Check if this is a progress update (contains percentage)
    const isProgressUpdate = message.includes('(') && message.includes('%)');

    setSyncLogs(prev => {
      // If it's a progress update, replace the last message if it was also a progress update
      if (isProgressUpdate && prev.length > 0) {
        const lastLog = prev[prev.length - 1];
        const lastIsProgress = lastLog.message.includes('(') && lastLog.message.includes('%)');

        if (lastIsProgress) {
          // Replace the last progress message
          return [...prev.slice(0, -1), { timestamp, message, type }];
        }
      }

      // Otherwise, append normally
      return [...prev, { timestamp, message, type }];
    });
  };

  // Shared helper: invalidate cache + refresh whatever view is active
  const refreshCurrentView = useCallback(async () => {
    invalidateCurrentView();
    await new Promise(resolve => setTimeout(resolve, 500));
    if (viewMode === 'weekly') {
      const weekStartStr = formatDateLocal(selectedWeek);
      await fetchWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
    } else if (viewMode === 'monthly') {
      const monthStartStr = formatDateLocal(selectedMonth);
      await fetchMonthlyDashboard(monthStartStr, 'America/Los_Angeles');
    } else {
      const dateStr = formatDateLocal(selectedDate);
      const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
      await fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
    }
    const dateToUse = viewMode === 'weekly' ? selectedWeek : selectedDate;
    await fetchWeeklyStats('America/Los_Angeles', formatDateLocal(dateToUse));
  }, [viewMode, selectedDate, selectedWeek, selectedMonth, invalidateCurrentView, fetchDashboard, fetchWeeklyDashboard, fetchMonthlyDashboard, fetchWeeklyStats, formatDateLocal]);

  const handleToggleNoise = useCallback(async () => {
    const newValue = !excludeNoise;
    setExcludeNoise(newValue);
    setGlobalExcludeNoise(newValue);
    try {
      await forceRefreshNoCache();
    } catch (err) {
      // Roll back toggle if refresh fails, so UI state matches server data.
      setExcludeNoise(!newValue);
      setGlobalExcludeNoise(!newValue);
    }
  }, [excludeNoise, forceRefreshNoCache]);

  const handleRetryLoad = useCallback(async () => {
    await refreshCurrentView();
  }, [refreshCurrentView]);

  const handleRefresh = useCallback(async () => {
    setSyncLogs([]); // Clear previous logs
    setShowSyncDetails(true); // Auto-show details panel
    addSyncLog('Starting sync process...', 'info');

    try {
      setRefreshing(true);
      setSyncStatus('syncing');
      setSyncMessage('Triggering sync from FreshService...');
      addSyncLog('Triggering sync from FreshService...', 'info');

      // Check initial status
      const initialStatus = await syncAPI.getStatus();
      addSyncLog(`Initial status: ${initialStatus.data?.sync?.isRunning ? 'Sync already running' : 'Ready to sync'}`, 'info');

      // Trigger the sync (this waits for completion)
      addSyncLog('Calling sync API endpoint...', 'info');
      addSyncLog('⏱ This may take several minutes due to FreshService API rate limits (1 request/second)', 'warn');
      addSyncLog('The backend will process each ticket sequentially to avoid hitting rate limits', 'info');

      const startTime = Date.now();
      const triggerResult = await syncAPI.trigger();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      // Check if sync was skipped because one is already running
      if (triggerResult.data?.status === 'skipped') {
        addSyncLog('⚠ Sync already in progress, waiting for it to complete...', 'warn');

        // Poll until the sync completes
        let attempts = 0;
        const maxAttempts = 60; // 2 minutes max (60 * 2 seconds)

        while (attempts < maxAttempts) {
          await new Promise(resolve => setTimeout(resolve, 2000)); // Wait 2 seconds

          const statusCheck = await syncAPI.getStatus();
          const progress = statusCheck.data?.sync?.progress;

          if (progress) {
            // Display progress information
            const progressMsg = `${progress.currentStep} (${progress.percentage}%)`;
            addSyncLog(progressMsg, 'info');
            setSyncMessage(progressMsg);
          } else {
            addSyncLog(`Checking sync status... (${attempts * 2}s elapsed)`, 'info');
          }

          if (!statusCheck.data?.sync?.isRunning) {
            addSyncLog('Background sync completed!', 'success');

            // Get the latest sync result
            const finalResult = await syncAPI.getStatus();
            const latestSync = finalResult.data?.latestSync;

            if (latestSync?.status === 'completed') {
              addSyncLog('✓ Synced technicians and tickets', 'success');
              addSyncLog(`✓ Total records: ${latestSync.recordsProcessed || 0}`, 'success');

              setSyncStatus('success');
              setSyncMessage('Background sync completed successfully!');

              addSyncLog('Refreshing dashboard data...', 'info');
              await refreshCurrentView();
              addSyncLog('Dashboard data refreshed', 'success');

              setTimeout(() => {
                setSyncStatus(null);
                setRefreshing(false);
              }, 5000);
              return;
            }
            break;
          }

          attempts++;
        }

        if (attempts >= maxAttempts) {
          addSyncLog('✗ Timeout waiting for background sync', 'error');
          setSyncStatus('error');
          setSyncMessage('Sync is taking too long. Please try again later.');
          setTimeout(() => {
            setSyncStatus(null);
            setRefreshing(false);
          }, 5000);
          return;
        }
      }

      addSyncLog(`Sync completed in ${duration}s`, 'success');

      // After trigger returns, sync should be complete
      // Get the final status
      const finalStatus = await syncAPI.getStatus();
      const latestSync = finalStatus.data?.latestSync;

      if (latestSync?.status === 'completed') {
        const techCount = triggerResult.data?.techniciansSynced || 0;
        const ticketCount = triggerResult.data?.ticketsSynced || 0;

        addSyncLog(`✓ Synced ${techCount} technicians`, 'success');
        addSyncLog(`✓ Synced ${ticketCount} tickets`, 'success');
        addSyncLog(`✓ Total records processed: ${latestSync.recordsProcessed || (techCount + ticketCount)}`, 'success');

        setSyncStatus('success');
        setSyncMessage(`Sync completed! Synced ${techCount} technicians and ${ticketCount} tickets.`);

        addSyncLog('Refreshing dashboard data...', 'info');
        await refreshCurrentView();
        addSyncLog('Dashboard data refreshed successfully', 'success');

        // Hide success message after 5 seconds
        setTimeout(() => {
          setSyncStatus(null);
          setRefreshing(false);
        }, 5000);
      } else if (latestSync?.status === 'failed') {
        console.error('[SYNC] Sync failed:', latestSync.errorMessage);
        addSyncLog(`✗ Sync failed: ${latestSync.errorMessage}`, 'error');
        setSyncStatus('error');
        setSyncMessage(latestSync.errorMessage || 'Sync failed. Please try again.');
        setTimeout(() => {
          setSyncStatus(null);
          setRefreshing(false);
        }, 5000);
      } else {
        console.warn('[SYNC] Unexpected sync status:', latestSync?.status);
        addSyncLog(`Warning: Unexpected sync status: ${latestSync?.status || 'unknown'}`, 'warn');
        setSyncStatus('success');
        setSyncMessage('Sync completed.');

        await refreshCurrentView();

        setTimeout(() => {
          setSyncStatus(null);
          setRefreshing(false);
        }, 5000);
      }

    } catch (err) {
      console.error('[SYNC] Error during sync:', err);
      addSyncLog(`✗ Error: ${err.message}`, 'error');

      // Add more detailed error info
      if (err.message.includes('timeout')) {
        addSyncLog('⚠ Sync is taking longer than expected', 'warn');
        addSyncLog('Large syncs can take 5-15 minutes. The sync continues in background.', 'info');
        addSyncLog('Try refreshing the page in a few minutes to see results.', 'info');
      } else if (err.message.includes('Network error')) {
        addSyncLog('Cannot connect to the backend server', 'error');
        addSyncLog('Please check if the backend is running on port 3000', 'warn');
      }

      setSyncStatus('error');
      setSyncMessage('Failed to sync: ' + err.message);
      setTimeout(() => {
        setSyncStatus(null);
        setRefreshing(false);
      }, 5000);
    }
  }, [selectedDate, selectedWeek, viewMode, fetchDashboard, formatDateLocal, refreshCurrentView]);

  const handleSyncWeek = useCallback(async () => {
    setSyncLogs([]); // Clear previous logs
    setShowSyncDetails(true); // Auto-show details panel
    addSyncLog('Starting week sync process...', 'info');

    try {
      setRefreshing(true);
      setSyncStatus('syncing');

      // Calculate Monday of the selected week
      // Use selectedWeek for weekly mode, selectedDate for daily mode
      const sourceDate = viewMode === 'weekly' ? selectedWeek : selectedDate;
      const currentDay = (sourceDate.getDay() + 6) % 7; // Convert to Monday=0, ..., Sunday=6
      const monday = new Date(sourceDate);
      monday.setDate(sourceDate.getDate() - currentDay);
      monday.setHours(0, 0, 0, 0);

      // Calculate Sunday of the selected week
      const sunday = new Date(monday);
      sunday.setDate(monday.getDate() + 6);
      sunday.setHours(23, 59, 59, 999);

      const weekRange = `${formatDateLocal(monday)} to ${formatDateLocal(sunday)}`;
      setSyncMessage(`Syncing week: ${weekRange}...`);
      addSyncLog(`Target week: ${weekRange}`, 'info');
      addSyncLog('This will sync tickets, activities, and pickup times for the entire week', 'info');

      // Call the sync week API endpoint
      addSyncLog('Calling sync week API endpoint...', 'info');
      const startTime = Date.now();

      // Start polling for progress updates
      let syncCompleted = false; // Flag to prevent race condition
      const progressPollingInterval = setInterval(async () => {
        try {
          const statusCheck = await syncAPI.getStatus();
          const progress = statusCheck.data?.sync?.progress;

          // Only update message if sync hasn't completed yet
          if (progress && !syncCompleted) {
            const progressMsg = `${progress.currentStep} (${progress.percentage}%)`;
            addSyncLog(progressMsg, 'info');
            setSyncMessage(progressMsg);
          }
        } catch (err) {
          console.error('[SYNC WEEK] Error polling progress:', err);
        }
      }, 2000); // Poll every 2 seconds

      try {
        const response = await syncAPI.syncWeek({
          startDate: formatDateLocal(monday),
          endDate: formatDateLocal(sunday),
        });

        // Stop polling - set flag first to prevent race condition
        syncCompleted = true;
        clearInterval(progressPollingInterval);
        // Small delay to ensure any in-flight polls see the flag
        await new Promise(resolve => setTimeout(resolve, 100));

        const duration = ((Date.now() - startTime) / 1000).toFixed(1);

        if (response.success) {
          addSyncLog(`✓ Week sync completed in ${duration}s`, 'success');
          addSyncLog(`✓ Tickets synced: ${response.data.ticketsSynced || 0}`, 'success');
          addSyncLog(`✓ Activities analyzed: ${response.data.activitiesAnalyzed || 0}`, 'success');
          addSyncLog(`✓ Pickup times backfilled: ${response.data.pickupTimesBackfilled || 0}`, 'success');

          setSyncStatus('success');
          setSyncMessage(`Week sync completed! ${response.data.ticketsSynced || 0} tickets synced.`);

          addSyncLog('Refreshing dashboard data...', 'info');
          invalidateDateRange(formatDateLocal(monday), formatDateLocal(sunday));
          await refreshCurrentView();
          addSyncLog('Dashboard data refreshed', 'success');

          setTimeout(() => {
            setSyncStatus(null);
            setRefreshing(false);
          }, 5000);
        } else {
          throw new Error(response.message || 'Week sync failed');
        }
      } catch (err) {
        // Stop polling on error
        clearInterval(progressPollingInterval);
        throw err;
      }

    } catch (err) {
      console.error('[SYNC WEEK] Error during week sync:', err);
      addSyncLog(`✗ Error: ${err.message}`, 'error');

      // Add more detailed error info
      if (err.message.includes('timeout')) {
        addSyncLog('⚠ Week sync is taking longer than expected', 'warn');
        addSyncLog('Historical week syncs can take 8-15 minutes. The sync continues in background.', 'info');
        addSyncLog('Try refreshing the page in a few minutes to see results.', 'info');
      } else if (err.message.includes('Network error')) {
        addSyncLog('Cannot connect to the backend server', 'error');
        addSyncLog('Please check if the backend is running on port 3000', 'warn');
      }

      setSyncStatus('error');
      setSyncMessage('Failed to sync week: ' + err.message);
      setTimeout(() => {
        setSyncStatus(null);
        setRefreshing(false);
      }, 5000);
    }
  }, [selectedDate, selectedWeek, viewMode, fetchDashboard, formatDateLocal, refreshCurrentView, invalidateDateRange]);

  const handleKillSync = async () => {
    if (!window.confirm('Force-stop the current sync? This will clear the stuck state so you can start a new sync. The sync in progress will be abandoned.')) return;
    setKillingSync(true);
    try {
      await syncAPI.resetSync();
      setBackgroundSyncRunning(false);
      setBackgroundSyncStep(null);
      setRefreshing(false);
      setSyncStatus(null);
    } catch (err) {
      console.error('[KILL SYNC] Failed:', err);
    } finally {
      setKillingSync(false);
    }
  };

  if (isLoading && !dashboardData) {
    return (
      <div
        className={`min-h-screen flex items-center justify-center ${APP_BACKGROUND_CLASS}`}
        style={APP_BACKGROUND_STYLE}
      >
        <DashboardLoadingProgress workspaceName={currentWorkspace?.name} />
      </div>
    );
  }

  if (error) {
    return (
      <div
        className={`min-h-screen flex items-center justify-center ${APP_BACKGROUND_CLASS}`}
        style={APP_BACKGROUND_STYLE}
      >
        <div className="bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg p-6 max-w-md shadow-sm">
          <XCircle className="w-12 h-12 text-red-600 dark:text-red-300 mx-auto mb-4" />
          <p className="text-red-800 dark:text-red-200 text-center">{error}</p>
          <button
            onClick={handleRetryLoad}
            className="mt-4 w-full bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Use appropriate data based on view mode
  const stats = viewMode === 'monthly'
    ? {
      ...(monthlyData?.statistics || {}),
      // Map backend field names to frontend expected names
      monthTotalCreated: monthlyData?.statistics?.monthTotal || 0,
    }
    : viewMode === 'weekly'
      ? (weeklyData?.statistics || {})
      : (dashboardData?.statistics || {});
  const technicians = viewMode === 'weekly'
    ? (weeklyData?.technicians || [])
    : viewMode === 'monthly'
      ? (monthlyData?.technicians || dashboardData?.technicians || [])
      : (dashboardData?.technicians || []);
  const responseCategoryMode = viewMode === 'weekly'
    ? weeklyData?.categoryMode
    : viewMode === 'monthly'
      ? monthlyData?.categoryMode
      : dashboardData?.categoryMode;
  const categoryMode = responseCategoryMode || categoryMetadata?.categoryMode || (showSummitWorkshop ? 'canonical' : 'legacy');
  const isCanonicalCategoryMode = categoryMode === 'canonical';
  const activeCategoryFilter = isCanonicalCategoryMode
    ? {
      mode: 'canonical',
      categoryIds: selectedCanonicalCategories.categoryIds || [],
      subcategoryIds: selectedCanonicalCategories.subcategoryIds || [],
      legacyCategories: [],
    }
    : {
      mode: 'legacy',
      categoryIds: [],
      subcategoryIds: [],
      legacyCategories: selectedCategories,
    };
  const hasActiveCategoryFilter = hasCategoryFilters(activeCategoryFilter);

  // Service account names for identifying app-made assignments (from API response)
  const serviceAccountNames = (
    viewMode === 'weekly' ? weeklyData?.serviceAccountNames
      : viewMode === 'monthly' ? monthlyData?.serviceAccountNames
        : dashboardData?.serviceAccountNames
  ) || [];

  // Filter technicians based on hidden state
  const visibleTechnicians = technicians.filter(tech => !hiddenTechIds.includes(tech.id));
  const hiddenTechnicians = technicians.filter(tech => hiddenTechIds.includes(tech.id));

  // Helper function to get tickets array from tech (handles daily, weekly, and monthly views)
  // CRITICAL: Use viewMode to determine which field to use, NOT whether fields exist
  // This prevents cross-contamination between daily and weekly data
  const getTechTickets = (tech) => {
    if (viewMode === 'weekly') {
      return tech.weeklyTickets || [];
    } else if (viewMode === 'monthly') {
      // For monthly view, we need to filter tickets by the selected month
      // Use all tickets from the technician and filter by month range
      const allTickets = tech.tickets || [];
      if (!selectedMonth) return allTickets;
      
      const monthStart = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth(), 1);
      const monthEnd = new Date(selectedMonth.getFullYear(), selectedMonth.getMonth() + 1, 0, 23, 59, 59, 999);
      
      return allTickets.filter(ticket => {
        const assignDate = ticket.firstAssignedAt 
          ? new Date(ticket.firstAssignedAt)
          : new Date(ticket.createdAt);
        return assignDate >= monthStart && assignDate <= monthEnd;
      });
    } else {
      // Daily view
      return tech.tickets || [];
    }
  };

  // Note: Filtering logic now centralized in ticketFilter.js utility
  // This ensures consistency across all views (daily, weekly, technician detail)

  // Helper function to recalculate technician stats based on filtered tickets
  const recalculateTechStats = (tech, filteredTickets) => {
    // Recalculate stats based on the filtered tickets
    const openTickets = filteredTickets.filter(t => ['Open', 'Pending'].includes(t.status));
    const openOnlyCount = filteredTickets.filter(t => t.status === 'Open').length;
    const pendingCount = filteredTickets.filter(t => t.status === 'Pending').length;
    const selfPicked = filteredTickets.filter(t => t.isSelfPicked || t.assignedBy === tech.name);

    // Helper to check if assigned by the app (service account)
    const isAppAssignment = (t) =>
      serviceAccountNames.length > 0 &&
      t.assignedBy &&
      serviceAccountNames.some(name => name.toLowerCase() === t.assignedBy.toLowerCase());

    const appAssignedTickets = filteredTickets.filter(t =>
      !t.isSelfPicked && t.assignedBy !== tech.name && isAppAssignment(t));
    const assigned = filteredTickets.filter(t =>
      !t.isSelfPicked && t.assignedBy !== tech.name && !isAppAssignment(t));
    const closed = filteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status));

    // Calculate assigners (who assigned tickets to this tech), excluding service accounts
    const assignerCounts = {};
    assigned.forEach(ticket => {
      if (ticket.assignedBy && ticket.assignedBy !== tech.name) {
        assignerCounts[ticket.assignedBy] = (assignerCounts[ticket.assignedBy] || 0) + 1;
      }
    });
    const assigners = Object.entries(assignerCounts)
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);

    // Recalculate daily breakdown for weekly view (Mon-Sun grid)
    let dailyBreakdown = tech.dailyBreakdown; // Keep original if not in weekly mode
    if (viewMode === 'weekly' && tech.dailyBreakdown) {
      // Create a new daily breakdown based on filtered tickets
      dailyBreakdown = tech.dailyBreakdown.map(day => {
        // Parse the date for this day
        const dayDate = new Date(day.date + 'T00:00:00');
        const dayEnd = new Date(day.date + 'T23:59:59');

        // Filter tickets for this specific day
        const dayTickets = filteredTickets.filter(ticket => {
          const ticketDate = new Date(ticket.firstAssignedAt || ticket.createdAt);
          return ticketDate >= dayDate && ticketDate <= dayEnd;
        });

        // Calculate counts for this day
        const daySelf = dayTickets.filter(t => t.isSelfPicked || t.assignedBy === tech.name).length;
        const dayAppAssigned = dayTickets.filter(t => !t.isSelfPicked && t.assignedBy !== tech.name && isAppAssignment(t)).length;
        const dayAssigned = dayTickets.filter(t => !t.isSelfPicked && t.assignedBy !== tech.name && !isAppAssignment(t)).length;
        const dayClosed = filteredTickets.filter(ticket => {
          const closeDate = ticket.closedAt || ticket.resolvedAt;
          if (!closeDate) return false;
          const closeDateObj = new Date(closeDate);
          return closeDateObj >= dayDate && closeDateObj <= dayEnd;
        }).length;

        return {
          date: day.date,
          total: dayTickets.length,
          self: daySelf,
          appAssigned: dayAppAssigned,
          assigned: dayAssigned,
          closed: dayClosed,
        };
      });
    }

    return {
      // Counts
      openTicketCount: openTickets.length,
      openOnlyCount,
      pendingCount,
      totalTicketsToday: filteredTickets.length,
      selfPickedToday: selfPicked.length,
      appAssignedToday: appAssignedTickets.length,
      assignedToday: assigned.length,
      closedToday: closed.length,

      // Weekly stats (if in weekly mode)
      weeklyTotalCreated: filteredTickets.length,
      weeklySelfPicked: selfPicked.length,
      weeklyAppAssigned: appAssignedTickets.length,
      weeklyAssigned: assigned.length,
      weeklyClosed: closed.length,
      assigners, // List of who assigned tickets (for weekly view)
      dailyBreakdown, // Daily grid (Mon-Sun) for weekly view
    };
  };

  // Extract unique categories from all visible technicians' tickets
  const categorySet = new Set();
  visibleTechnicians.forEach(tech => {
    getTechTickets(tech).forEach(ticket => {
      const categoryLabel = getTicketCategoryLabel(ticket, categoryMode);
      if (categoryLabel) {
        categorySet.add(categoryLabel);
      }
    });
  });
  const allCategories = Array.from(categorySet).sort();

  // Apply search and category filters using centralized filtering utility
  const filteredTechnicians = (searchTerm || hasActiveCategoryFilter)
    ? visibleTechnicians.map(tech => {
      // Filter tickets using centralized filterTickets function
      const techTickets = getTechTickets(tech);
      const matchingTickets = filterTickets(techTickets, searchTerm, activeCategoryFilter, { categoryMode });

      // Recalculate stats based on filtered tickets
      const recalculatedStats = recalculateTechStats(tech, matchingTickets);

      // Update the appropriate field based on CURRENT VIEW MODE
      // CRITICAL: Don't check what fields exist - use viewMode to decide
      // This prevents cross-contamination between daily and weekly filtering
      const updatedTech = {
        ...tech,
        ...recalculatedStats, // Overwrite stats with recalculated values
        originalTicketCount: techTickets.length || 0,
        matchingTicketCount: matchingTickets.length,
      };

      // Set the correct field based on current view mode (not what exists in the object)
      if (viewMode === 'weekly') {
        updatedTech.weeklyTickets = matchingTickets;
        // Don't clear tickets - they might be from another context
      } else if (viewMode === 'monthly') {
        updatedTech.tickets = matchingTickets;
        // For monthly, we still use tickets field but filtered by month range
      } else {
        updatedTech.tickets = matchingTickets;
        // Don't clear weeklyTickets - they might be from another context
      }

      return updatedTech;
    }).filter(tech => tech.matchingTicketCount > 0)
    : visibleTechnicians;

  // Calculate results count
  const searchResultsCount = searchTerm || hasActiveCategoryFilter
    ? filteredTechnicians.reduce((sum, tech) => sum + (tech.matchingTicketCount || getTechTickets(tech).length || 0), 0)
    : 0;

  // Recalculate stats based on filtered tickets (if filters are active)
  const displayStats = (searchTerm || hasActiveCategoryFilter) ? (() => {
    // Collect all filtered tickets
    const allFilteredTickets = filteredTechnicians.flatMap(tech => getTechTickets(tech));

    // Helper to check if assigned by the app (service account)
    const isAppAsgn = (t) =>
      serviceAccountNames.length > 0 &&
      t.assignedBy &&
      serviceAccountNames.some(name => name.toLowerCase() === t.assignedBy.toLowerCase());

    // Calculate filtered stats based on view mode
    const filteredStats = {
      totalTechnicians: filteredTechnicians.length,

      // Daily view stats
      totalTicketsToday: allFilteredTickets.length,
      openOnlyCount: allFilteredTickets.filter(t => t.status === 'Open').length,
      pendingCount: allFilteredTickets.filter(t => t.status === 'Pending').length,
      closedTicketsToday: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      selfPickedToday: allFilteredTickets.filter(t => t.isSelfPicked).length,
      appAssignedToday: allFilteredTickets.filter(t => !t.isSelfPicked && isAppAsgn(t)).length,

      // Weekly view stats
      weeklyTotalCreated: allFilteredTickets.length,
      weeklyClosed: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      weeklySelfPicked: allFilteredTickets.filter(t => t.isSelfPicked).length,
      weeklyAppAssigned: allFilteredTickets.filter(t => !t.isSelfPicked && isAppAsgn(t)).length,
      weeklyAssigned: allFilteredTickets.filter(t => !t.isSelfPicked && !isAppAsgn(t)).length,

      // Monthly view stats
      monthTotalCreated: allFilteredTickets.length,
      monthClosed: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      monthSelfPicked: allFilteredTickets.filter(t => t.isSelfPicked).length,
      monthAppAssigned: allFilteredTickets.filter(t => !t.isSelfPicked && isAppAsgn(t)).length,
      monthAssigned: allFilteredTickets.filter(t => !t.isSelfPicked && !isAppAsgn(t)).length,

      // Load level counts (only meaningful in daily view with current open tickets)
      lightLoad: filteredTechnicians.filter(t => t.loadLevel === 'light').length,
      mediumLoad: filteredTechnicians.filter(t => t.loadLevel === 'medium').length,
      heavyLoad: filteredTechnicians.filter(t => t.loadLevel === 'heavy').length,
    };

    return filteredStats;
  })() : stats;

  // Format selected date in a friendly format
  const dateOptions = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
  const _formattedDate = selectedDate.toLocaleDateString('en-US', dateOptions);

  // Check if selected date is today
  const today = new Date();
  const isToday = selectedDate.toDateString() === today.toDateString();

  // Navigation functions
  const goToPreviousDay = () => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() - 1);
    setSelectedDate(newDate);
  };

  const goToNextDay = () => {
    const newDate = new Date(selectedDate);
    newDate.setDate(newDate.getDate() + 1);
    setSelectedDate(newDate);
  };

  const goToToday = () => {
    setSelectedDate(new Date());
  };

  // Week navigation handlers (for weekly view)
  const goToPreviousWeek = () => {
    const newWeek = new Date(selectedWeek);
    newWeek.setDate(newWeek.getDate() - 7);
    setSelectedWeek(newWeek);
  };

  const goToNextWeek = () => {
    const newWeek = new Date(selectedWeek);
    newWeek.setDate(newWeek.getDate() + 7);
    setSelectedWeek(newWeek);
  };

  const goToCurrentWeek = () => {
    const now = new Date();
    const currentDay = (now.getDay() + 6) % 7; // Convert to Monday=0
    const monday = new Date(now);
    monday.setDate(now.getDate() - currentDay);
    monday.setHours(0, 0, 0, 0);
    setSelectedWeek(monday);
  };

  // Month navigation handlers (for monthly view)
  const goToPreviousMonth = () => {
    const newMonth = new Date(selectedMonth);
    newMonth.setMonth(newMonth.getMonth() - 1);
    setSelectedMonth(newMonth);
  };

  const goToNextMonth = () => {
    const newMonth = new Date(selectedMonth);
    newMonth.setMonth(newMonth.getMonth() + 1);
    setSelectedMonth(newMonth);
  };

  const goToCurrentMonth = () => {
    const now = new Date();
    setSelectedMonth(new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0));
  };

  // Handle hiding a technician
  const handleHideTechnician = (techId) => {
    const newHiddenIds = [...hiddenTechIds, techId];
    setHiddenTechIds(newHiddenIds);
    localStorage.setItem('hiddenTechnicians', JSON.stringify(newHiddenIds));
  };

  // Handle restoring a technician
  const handleRestoreTechnician = (techId) => {
    const newHiddenIds = hiddenTechIds.filter(id => id !== techId);
    setHiddenTechIds(newHiddenIds);
    localStorage.setItem('hiddenTechnicians', JSON.stringify(newHiddenIds));
  };

  // Clear all hidden technicians
  const handleClearAllHidden = () => {
    setHiddenTechIds([]);
    localStorage.setItem('hiddenTechnicians', JSON.stringify([]));
  };

  // Toggle compact view
  const toggleCompactView = () => {
    const newValue = !isCompactView;
    setIsCompactView(newValue);
    localStorage.setItem('compactView', JSON.stringify(newValue));
  };

  // Toggle section collapse
  const _toggleSection = (section) => {
    const newCollapsedSections = {
      ...collapsedSections,
      [section]: !collapsedSections[section],
    };
    setCollapsedSections(newCollapsedSections);
    localStorage.setItem('collapsedSections', JSON.stringify(newCollapsedSections));
  };

  // Trophy ranks (top-3 badge) stay based on self-picked, but the LIST order
  // is total load for the current view, heaviest first (QA 07-30 #6).
  const techsWithRanks = (() => {
    const rankById = new Map(
      [...filteredTechnicians]
        .sort((a, b) => b.selfPickedToday - a.selfPickedToday)
        .map((tech, index) => [tech.id, tech.selfPickedToday > 0 ? index + 1 : null]),
    );
    return filteredTechnicians
      .map((tech) => ({ ...tech, rank: rankById.get(tech.id) }))
      .sort((a, b) => {
        const diff = (getSortValue(b, 'total', viewMode) || 0) - (getSortValue(a, 'total', viewMode) || 0);
        if (diff !== 0) return diff;
        return (a.name || '').localeCompare(b.name || '');
      });
  })();

  // Heaviest-load callout for the simple card style: the tech with the highest
  // total for the current view (list is already total-desc, so index 0; null
  // when nobody has tickets).
  const topLoadTechId = techsWithRanks.length > 0 && (getSortValue(techsWithRanks[0], 'total', viewMode) || 0) > 0
    ? techsWithRanks[0].id
    : null;

  // Group technicians by load level (only when viewing today)
  const _techsByLoadLevel = {
    heavy: techsWithRanks.filter(t => t.loadLevel === 'heavy'),
    medium: techsWithRanks.filter(t => t.loadLevel === 'medium'),
    light: techsWithRanks.filter(t => t.loadLevel === 'light'),
  };

  // Calculate team self-pick percentage (works for all view modes with filtered data)
  const totalTicketsToday = viewMode === 'monthly'
    ? (displayStats.monthTotalCreated || 0)
    : viewMode === 'weekly'
      ? (displayStats.weeklyTotalCreated || 0)
      : (displayStats.totalTicketsToday || 0);
  const selfPickedToday = viewMode === 'monthly'
    ? (displayStats.monthSelfPicked || 0)
    : viewMode === 'weekly'
      ? (displayStats.weeklySelfPicked || 0)
      : (displayStats.selfPickedToday || 0);
  const appAssignedTotal = viewMode === 'monthly'
    ? (displayStats.monthAppAssigned || 0)
    : viewMode === 'weekly'
      ? (displayStats.weeklyAppAssigned || 0)
      : (displayStats.appAssignedToday || 0);
  const selfPickPercentage = totalTicketsToday > 0
    ? Math.round((selfPickedToday / totalTicketsToday) * 100)
    : 0;
  // ---- Stats band (flat typographic redesign) ----------------------------
  // One list drives the desktop stat row, the mobile sheet grid, and their
  // ordering. `dot` is the identity tick used on the light sheet cells.
  const bandStats = [
    {
      key: 'total',
      label: viewMode === 'daily' ? 'Today' : 'Total',
      value: totalTicketsToday,
      dot: 'bg-blue-500',
    },
    ...(viewMode === 'daily' || viewMode === 'weekly' ? [
      {
        key: 'open',
        label: 'Open',
        value: viewMode === 'weekly' ? (displayStats.weeklyOpenOnly || 0) : (displayStats.openOnlyCount || 0),
        dot: 'bg-yellow-500',
      },
      {
        key: 'pending',
        label: 'Pending',
        value: viewMode === 'weekly' ? (displayStats.weeklyPending || 0) : (displayStats.pendingCount || 0),
        dot: 'bg-orange-500',
      },
    ] : []),
    {
      key: 'closed',
      label: 'Closed',
      value: viewMode === 'monthly' ? (displayStats.monthClosed || 0) : viewMode === 'weekly' ? (displayStats.weeklyClosed || 0) : (displayStats.closedTicketsToday || 0),
      dot: 'bg-green-500',
    },
    {
      key: 'self',
      label: 'Self',
      value: selfPickedToday,
      dot: 'bg-purple-500',
    },
    ...(appAssignedTotal > 0 ? [{
      key: 'app',
      label: 'App',
      value: appAssignedTotal,
      dot: 'bg-sky-500',
    }] : []),
  ];
  const maxDayCount = Math.max(1, ...(weeklyStats || []).map((d) => d?.count || 0));
  const selfPickBarClass = selfPickPercentage >= 70 ? 'bg-green-400' : selfPickPercentage >= 50 ? 'bg-yellow-400' : 'bg-red-400';
  const selfPickSheetBarClass = selfPickPercentage >= 70 ? 'bg-green-500' : selfPickPercentage >= 50 ? 'bg-yellow-500' : 'bg-red-500';
  const selfPickRingStroke = selfPickPercentage >= 70 ? '#4ade80' : selfPickPercentage >= 50 ? '#facc15' : '#fca5a5';
  const loadMixTitle = isToday
    ? `Techs by load — light: ${displayStats.lightLoad || 0} · medium: ${displayStats.mediumLoad || 0} · heavy: ${displayStats.heavyLoad || 0}`
    : 'Team self-pick rate for this period';
  const bandRangeLabel = viewMode === 'daily'
    ? selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
    : viewMode === 'weekly'
      ? (() => {
        const weekEnd = new Date(selectedWeek);
        weekEnd.setDate(selectedWeek.getDate() + 6);
        return `${selectedWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
      })()
      : selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });

  // Per-day cells shared by the desktop micro bar-chart, the mobile strip
  // bars, and the sheet's tappable day grid. The bar silhouette replaces the
  // old per-day trend arrows.
  const bandDays = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
    const currentDay = (selectedDate.getDay() + 6) % 7;
    const count = weeklyStats?.[index]?.count ?? null;
    let dayDate;
    if (viewMode === 'weekly' && selectedWeek) {
      dayDate = new Date(selectedWeek);
      dayDate.setDate(selectedWeek.getDate() + index);
    } else {
      dayDate = new Date(selectedDate);
      dayDate.setDate(dayDate.getDate() + (index - currentDay));
    }
    const dayDateStr = formatDateLocal(dayDate);
    const todayStr = formatDateLocal(new Date());
    const isSelectedDay = viewMode === 'daily' ? index === currentDay : dayDateStr === todayStr;
    const holidayInfo = getHolidayInfo(dayDateStr);
    const holidayTooltip = getHolidayTooltip(dayDateStr);
    let tooltip = `${day} ${dayDate.getDate()}`;
    if (count !== null) tooltip += ` — ${count} tickets`;
    if (holidayTooltip) tooltip += `\n${holidayTooltip}`;
    return {
      day,
      index,
      count,
      dayDate,
      isSelectedDay,
      isWeekend: index === 5 || index === 6,
      holidayInfo,
      tooltip,
      select: () => {
        setSelectedDate(new Date(dayDate));
        if (viewMode === 'weekly') setViewMode('daily');
      },
    };
  });
  const dayBarHeight = (count, maxPx) => {
    if (!count) return 2;
    return Math.max(4, Math.round((count / maxDayCount) * maxPx));
  };

  return (
    <AppShell
      activePage="dashboard"
      contentClassName=""
      headerProps={{
        backgroundSyncRunning,
        backgroundSyncStep,
        killingSync,
        onKillSync: handleKillSync,
        clearCacheOnLogout,
        isColdLoading,
        dashboardActions: {
          onRefresh: handleRefresh,
          onSyncWeek: handleSyncWeek,
          refreshing,
        },
      }}
    >
      {/* Fancy Loading Overlay */}
      {(isColdLoading && (dashboardData || weeklyData || monthlyData)) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          {/* Faded background overlay */}
          <div className="absolute inset-0 bg-gray-900/20 backdrop-blur-[1px]" />
          
          {/* Animated spinner container */}
          <div className="relative">
            {/* Outer ring - slow spin */}
            <div 
              className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-t-blue-500 border-r-blue-300 dark:border-r-blue-500/40 opacity-80"
              style={{ animation: 'spin 1.5s linear infinite' }}
            />
            
            {/* Middle ring - medium spin, opposite direction */}
            <div 
              className="absolute inset-2 w-16 h-16 rounded-full border-4 border-transparent border-b-purple-500 border-l-purple-300 dark:border-l-purple-500/40 opacity-70"
              style={{ animation: 'spin 1s linear infinite reverse', marginLeft: '0.5rem', marginTop: '0.5rem' }}
            />
            
            {/* Inner ring - fast spin */}
            <div 
              className="absolute inset-4 w-12 h-12 rounded-full border-4 border-transparent border-t-indigo-500 border-r-indigo-300 dark:border-r-indigo-500/40 opacity-90"
              style={{ animation: 'spin 0.7s linear infinite', marginLeft: '1rem', marginTop: '1rem' }}
            />
            
            {/* Center pulse dot */}
            <div 
              className="absolute w-20 h-20 flex items-center justify-center"
            >
              <div className="w-4 h-4 rounded-full bg-gradient-to-br from-blue-400 to-purple-600 animate-pulse shadow-lg" />
            </div>
          </div>
        </div>
      )}

      {/* Sync Status Notification */}
      {syncStatus && (
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <div className={`
            rounded-lg p-4 flex items-center justify-between shadow-lg
            ${syncStatus === 'syncing' ? 'bg-blue-50 dark:bg-blue-500/15 border border-blue-200 dark:border-blue-500/30' : ''}
            ${syncStatus === 'success' ? 'bg-green-50 dark:bg-green-500/15 border border-green-200 dark:border-green-500/30' : ''}
            ${syncStatus === 'error' ? 'bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30' : ''}
          `}>
            <div className="flex items-center gap-3">
              {syncStatus === 'syncing' && (
                <RefreshCw className="w-5 h-5 text-blue-600 dark:text-blue-300 animate-spin" />
              )}
              {syncStatus === 'success' && (
                <CheckCircle className="w-5 h-5 text-green-600 dark:text-green-300" />
              )}
              {syncStatus === 'error' && (
                <XCircle className="w-5 h-5 text-red-600 dark:text-red-300" />
              )}
              <div>
                <p className={`font-semibold ${
                  syncStatus === 'syncing' ? 'text-blue-900 dark:text-blue-200' :
                    syncStatus === 'success' ? 'text-green-900 dark:text-green-200' :
                      'text-red-900 dark:text-red-200'
                }`}>
                  {syncStatus === 'syncing' ? 'Syncing...' :
                    syncStatus === 'success' ? 'Sync Successful' :
                      'Sync Failed'}
                </p>
                <p className={`text-sm ${
                  syncStatus === 'syncing' ? 'text-blue-700 dark:text-blue-200' :
                    syncStatus === 'success' ? 'text-green-700 dark:text-green-200' :
                      'text-red-700 dark:text-red-200'
                }`}>
                  {syncMessage}
                </p>
              </div>
            </div>
            {syncStatus !== 'syncing' && (
              <button
                onClick={() => setSyncStatus(null)}
                className="text-muted-foreground/75 hover:text-muted-foreground"
              >
                <XCircle className="w-5 h-5" />
              </button>
            )}
          </div>
        </div>
      )}

      {/* Sync Details Log Viewer */}
      {syncLogs.length > 0 && (
        <div className="max-w-7xl mx-auto px-4 pt-2">
          <div className="bg-card rounded-lg border border-input shadow-md overflow-hidden">
            {/* Header */}
            <div
              className="bg-muted px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-muted/80 transition-colors"
              onClick={() => setShowSyncDetails(!showSyncDetails)}
            >
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-blue-600 dark:text-blue-300" />
                <h3 className="font-semibold text-foreground">Sync Details</h3>
                <span className="text-sm text-muted-foreground">({syncLogs.length} events)</span>
              </div>
              <button className="text-muted-foreground hover:text-foreground/85">
                {showSyncDetails ? (
                  <ChevronUp className="w-5 h-5" />
                ) : (
                  <ChevronDown className="w-5 h-5" />
                )}
              </button>
            </div>

            {/* Log Content */}
            {showSyncDetails && (
              <div className="p-4 bg-muted/50 max-h-96 overflow-y-auto">
                <div className="space-y-1 font-mono text-sm">
                  {syncLogs.map((log, index) => (
                    <div
                      key={index}
                      className={`flex items-start gap-3 py-1 px-2 rounded ${
                        log.type === 'error' ? 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200' :
                          log.type === 'warn' ? 'bg-yellow-50 dark:bg-yellow-500/15 text-yellow-800 dark:text-yellow-200' :
                            log.type === 'success' ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' :
                              'text-foreground/85'
                      }`}
                    >
                      <span className="text-muted-foreground text-xs whitespace-nowrap">{log.timestamp}</span>
                      <span className={`font-semibold ${
                        log.type === 'error' ? 'text-red-600 dark:text-red-300' :
                          log.type === 'warn' ? 'text-yellow-600 dark:text-yellow-300' :
                            log.type === 'success' ? 'text-green-600 dark:text-green-300' :
                              'text-blue-600 dark:text-blue-300'
                      }`}>
                        {log.type === 'error' ? '[ERROR]' :
                          log.type === 'warn' ? '[WARN]' :
                            log.type === 'success' ? '[SUCCESS]' :
                              '[INFO]'}
                      </span>
                      <span className="flex-1">{log.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-2 sm:px-4 py-3">
        {/* Stats Band — one flat line on desktop; a tap-to-expand summary strip on
            phones (full breakdown lives in a bottom sheet). The day bars carry the
            week's shape, replacing the old per-day trend arrows. */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg shadow-lg mb-3 sm:mb-4 text-white">

          {/* ---- Desktop: date · day bars · stats · self-pick · view toggle ----
              flex-wrap + flex-none segments: on narrow windows the trailing
              pieces break onto a clean second line instead of the stat numbers
              shrinking into each other (QA 07-08). */}
          <div className="hidden md:flex min-h-[60px] flex-wrap items-center gap-x-2.5 gap-y-1.5 px-4 py-2 2xl:gap-x-3">
            <button
              onClick={viewMode === 'daily' ? goToPreviousDay : viewMode === 'weekly' ? goToPreviousWeek : goToPreviousMonth}
              title={viewMode === 'daily' ? 'Previous day' : viewMode === 'weekly' ? 'Previous week' : 'Previous month'}
              className="flex-none rounded-lg p-1.5 transition-colors hover:bg-white/20 tp-focus-ring"
            >
              <ChevronLeft className="h-4 w-4" />
            </button>
            <div className="flex flex-none items-center gap-1.5">
              <Calendar className="h-3.5 w-3.5 flex-none opacity-80" />
              {viewMode === 'daily' ? (
                <input
                  type="date"
                  value={formatDateLocal(selectedDate)}
                  onChange={(e) => setSelectedDate(new Date(e.target.value + 'T12:00:00'))}
                  className="w-[8.5rem] rounded-md border border-white/30 bg-white/20 px-2 py-0.5 text-xs font-semibold text-white focus:outline-none focus:ring-1 focus:ring-white"
                />
              ) : (
                <span className="whitespace-nowrap text-[13px] font-bold">
                  {bandRangeLabel}{viewMode === 'weekly' ? `, ${new Date(selectedWeek.getTime() + 6 * 86400000).getFullYear()}` : ''}
                </span>
              )}
            </div>
            <button
              onClick={viewMode === 'daily' ? goToNextDay : viewMode === 'weekly' ? goToNextWeek : goToNextMonth}
              disabled={viewMode === 'daily' && isToday}
              title={viewMode === 'daily' ? 'Next day' : viewMode === 'weekly' ? 'Next week' : 'Next month'}
              className={`flex-none rounded-lg p-1.5 transition-colors tp-focus-ring ${(viewMode === 'daily' && isToday) ? 'cursor-not-allowed opacity-50' : 'hover:bg-white/20'}`}
            >
              <ChevronRight className="h-4 w-4" />
            </button>
            {!isToday && viewMode === 'daily' && (
              <button onClick={goToToday} className="flex-none whitespace-nowrap rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold transition-colors hover:bg-white/30">
                Today
              </button>
            )}
            {viewMode === 'weekly' && (
              <button onClick={goToCurrentWeek} className="flex-none whitespace-nowrap rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold transition-colors hover:bg-white/30">
                This Week
              </button>
            )}
            {viewMode === 'monthly' && (
              <button onClick={goToCurrentMonth} className="flex-none whitespace-nowrap rounded-full bg-white/20 px-2.5 py-0.5 text-xs font-semibold transition-colors hover:bg-white/30">
                This Month
              </button>
            )}

            <div className="my-1 w-px flex-none self-stretch bg-white/25" />

            <div className="flex flex-none items-end gap-0.5 2xl:gap-1" role="group" aria-label="Tickets created per day">
              {bandDays.map((d) => (
                <button
                  key={d.day}
                  type="button"
                  onClick={d.select}
                  title={d.tooltip}
                  className="group relative flex w-5 flex-col items-center justify-end rounded pt-3.5 tp-focus-ring 2xl:w-6"
                >
                  {d.holidayInfo.isHoliday && (
                    <span className={`absolute right-0.5 top-1.5 h-1.5 w-1.5 rounded-full ${d.holidayInfo.isCanadian ? 'bg-rose-300' : d.holidayInfo.isDynamic ? 'bg-violet-300' : 'bg-indigo-300'}`} />
                  )}
                  <span className={`text-[9px] font-bold leading-none tabular-nums transition-opacity ${d.isSelectedDay ? 'opacity-100' : 'opacity-0 group-hover:opacity-100'}`}>
                    {d.count ?? ''}
                  </span>
                  <span
                    className={`mt-0.5 w-3 rounded-t-[3px] transition-colors ${d.isSelectedDay ? 'bg-white' : d.isWeekend ? 'bg-white/20 group-hover:bg-white/35' : 'bg-white/45 group-hover:bg-white/70'}`}
                    style={{ height: `${dayBarHeight(d.count, 26)}px` }}
                  />
                  <span className={`mt-1 text-[8px] font-bold leading-none ${d.isSelectedDay ? 'opacity-100' : 'opacity-60'}`}>{d.day[0]}</span>
                </button>
              ))}
            </div>

            <div className="my-1 w-px flex-none self-stretch bg-white/25" />

            <div className="flex flex-1 items-center justify-evenly gap-x-2.5 2xl:gap-x-3">
              {bandStats.map((s) => (
                <div key={s.key} className="flex flex-none flex-col items-start gap-1">
                  <span className="text-base font-extrabold leading-none tabular-nums 2xl:text-lg">{s.value}</span>
                  <span className="text-[8.5px] font-bold uppercase leading-none tracking-wider text-blue-100">{s.label}</span>
                </div>
              ))}
            </div>

            <div className="my-1 w-px flex-none self-stretch bg-white/25" />

            <div className="w-28 flex-none cursor-default 2xl:w-36" title={loadMixTitle}>
              <div className="mb-1 flex items-baseline justify-between text-[11px]">
                <span className="font-semibold">Self-Pick <span className="font-extrabold tabular-nums">{selfPickPercentage}%</span></span>
                <span className="hidden font-medium opacity-75 2xl:inline">goal 70</span>
              </div>
              <div className="relative h-1.5 rounded-full bg-white/20">
                <div
                  className={`absolute inset-y-0 left-0 rounded-full transition-all duration-500 ${selfPickBarClass}`}
                  style={{ width: `${Math.min(100, selfPickPercentage)}%` }}
                />
                <div className="absolute -bottom-[3px] -top-[3px] w-0.5 rounded-full bg-white/85" style={{ left: '70%' }} />
              </div>
            </div>

            <div className="my-1 w-px flex-none self-stretch bg-white/25" />

            <div className="inline-flex flex-none items-center gap-0.5 rounded-lg bg-white/20 p-0.5">
              <button
                onClick={handleSwitchToDaily}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors 2xl:px-3 ${viewMode === 'daily' ? 'bg-white text-blue-600 shadow-sm' : 'text-white hover:bg-white/10'}`}
              >
                Daily
              </button>
              <button
                onClick={handleSwitchToWeekly}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors 2xl:px-3 ${viewMode === 'weekly' ? 'bg-white text-blue-600 shadow-sm' : 'text-white hover:bg-white/10'}`}
              >
                Weekly
              </button>
              <button
                onClick={handleSwitchToMonthly}
                className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors 2xl:px-3 ${viewMode === 'monthly' ? 'bg-white text-blue-600 shadow-sm' : 'text-white hover:bg-white/10'}`}
              >
                Monthly
              </button>
            </div>
          </div>

          {/* ---- Mobile: summary strip — tap anywhere (except arrows) for the sheet ---- */}
          <div className="px-3 py-2.5 md:hidden">
            <div className="flex items-center gap-1">
              <button
                onClick={viewMode === 'daily' ? goToPreviousDay : viewMode === 'weekly' ? goToPreviousWeek : goToPreviousMonth}
                aria-label={viewMode === 'daily' ? 'Previous day' : viewMode === 'weekly' ? 'Previous week' : 'Previous month'}
                className="flex-none rounded-lg p-2 transition-colors hover:bg-white/20 touch-manipulation tp-focus-ring"
              >
                <ChevronLeft className="h-4 w-4" />
              </button>
              <button
                type="button"
                onClick={() => setStatsSheetOpen(true)}
                className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg px-2 py-1 touch-manipulation tp-focus-ring"
              >
                <span className="truncate text-[13px] font-bold">{bandRangeLabel}</span>
                <span className="flex-none rounded-full bg-white/25 px-2 py-px text-[9px] font-extrabold uppercase tracking-wide">{viewMode}</span>
              </button>
              <button
                onClick={viewMode === 'daily' ? goToNextDay : viewMode === 'weekly' ? goToNextWeek : goToNextMonth}
                disabled={viewMode === 'daily' && isToday}
                aria-label={viewMode === 'daily' ? 'Next day' : viewMode === 'weekly' ? 'Next week' : 'Next month'}
                className={`flex-none rounded-lg p-2 transition-colors touch-manipulation tp-focus-ring ${(viewMode === 'daily' && isToday) ? 'cursor-not-allowed opacity-50' : 'hover:bg-white/20'}`}
              >
                <ChevronRight className="h-4 w-4" />
              </button>
            </div>

            <button
              type="button"
              onClick={() => setStatsSheetOpen(true)}
              aria-haspopup="dialog"
              aria-expanded={statsSheetOpen}
              className="mt-1 flex w-full items-center gap-3 rounded-lg px-1 py-1 text-left touch-manipulation tp-focus-ring"
            >
              <span className="flex-none">
                <span className="block text-[26px] font-extrabold leading-none tabular-nums">{totalTicketsToday}</span>
                <span className="mt-1 block text-[8.5px] font-bold uppercase leading-none tracking-wider text-blue-100">
                  {viewMode === 'daily' ? 'Today' : 'Tickets'}
                </span>
              </span>
              <span className="flex h-10 min-w-0 flex-1 items-end justify-between gap-1 px-1">
                {bandDays.map((d) => (
                  <span key={d.day} className="relative flex w-5 flex-col items-center justify-end gap-1">
                    {d.holidayInfo.isHoliday && (
                      <span className={`absolute -top-1 right-0.5 h-1 w-1 rounded-full ${d.holidayInfo.isCanadian ? 'bg-rose-300' : d.holidayInfo.isDynamic ? 'bg-violet-300' : 'bg-indigo-300'}`} />
                    )}
                    <span
                      className={`w-2.5 rounded-t-sm ${d.isSelectedDay ? 'bg-white' : d.isWeekend ? 'bg-white/20' : 'bg-white/45'}`}
                      style={{ height: `${dayBarHeight(d.count, 22)}px` }}
                    />
                    <span className={`text-[7.5px] font-bold leading-none ${d.isSelectedDay ? 'opacity-100' : 'opacity-60'}`}>{d.day[0]}</span>
                  </span>
                ))}
              </span>
              <span className="relative h-10 w-10 flex-none" aria-label={`Team self-pick ${selfPickPercentage}%`}>
                <svg viewBox="0 0 40 40" className="h-10 w-10 -rotate-90" aria-hidden="true">
                  <circle cx="20" cy="20" r="16" fill="none" stroke="rgba(255,255,255,0.25)" strokeWidth="5" />
                  <circle
                    cx="20" cy="20" r="16" fill="none"
                    stroke={selfPickRingStroke} strokeWidth="5" strokeLinecap="round"
                    strokeDasharray={`${(Math.min(100, selfPickPercentage) / 100) * 100.53} 100.53`}
                  />
                </svg>
                <span className="absolute inset-0 grid place-items-center text-[10px] font-extrabold tabular-nums">{selfPickPercentage}%</span>
              </span>
              <ChevronDown className="h-4 w-4 flex-none text-blue-100" aria-hidden="true" />
            </button>
          </div>
        </div>

        {/* Mobile stats sheet — the full breakdown behind the summary strip */}
        {statsSheetOpen && (
          <div className="fixed inset-0 z-50 md:hidden" role="dialog" aria-modal="true" aria-label="Period statistics">
            <button
              type="button"
              aria-label="Close statistics"
              onClick={() => setStatsSheetOpen(false)}
              className="absolute inset-0 bg-slate-900/40 animate-in fade-in-0 motion-reduce:animate-none"
            />
            <div className="absolute inset-x-0 bottom-0 rounded-t-2xl border-t border-border bg-card pb-[calc(1rem+env(safe-area-inset-bottom))] text-foreground shadow-soft animate-in slide-in-from-bottom-4 fade-in-0 duration-200 motion-reduce:animate-none">
              <div className="mx-auto mt-2 h-1 w-9 rounded-full bg-secondary" />
              <div className="flex items-center justify-between gap-2 px-4 pb-1 pt-2">
                <h3 className="min-w-0 truncate text-sm font-bold">{bandRangeLabel}</h3>
                <div className="flex flex-none items-center gap-2">
                  {viewMode === 'daily' && !isToday && (
                    <button onClick={goToToday} className="rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2.5 py-1 text-[11px] font-bold text-blue-700 dark:text-blue-200 touch-manipulation">Today</button>
                  )}
                  {viewMode === 'weekly' && (
                    <button onClick={goToCurrentWeek} className="rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2.5 py-1 text-[11px] font-bold text-blue-700 dark:text-blue-200 touch-manipulation">This Week</button>
                  )}
                  {viewMode === 'monthly' && (
                    <button onClick={goToCurrentMonth} className="rounded-full border border-blue-200 dark:border-blue-500/30 bg-blue-50 dark:bg-blue-500/15 px-2.5 py-1 text-[11px] font-bold text-blue-700 dark:text-blue-200 touch-manipulation">This Month</button>
                  )}
                  <button
                    type="button"
                    onClick={() => setStatsSheetOpen(false)}
                    aria-label="Close"
                    className="rounded-full p-1 text-muted-foreground/75 transition-colors hover:bg-muted hover:text-foreground/85"
                  >
                    <ChevronDown className="h-5 w-5" />
                  </button>
                </div>
              </div>

              {viewMode === 'daily' && (
                <div className="px-4 pb-1">
                  <input
                    type="date"
                    value={formatDateLocal(selectedDate)}
                    onChange={(e) => setSelectedDate(new Date(e.target.value + 'T12:00:00'))}
                    className="w-full rounded-lg border border-border bg-muted/50 px-3 py-1.5 text-sm font-semibold text-foreground/85"
                  />
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 px-4 py-2">
                {bandStats.map((s) => (
                  <div key={s.key} className="rounded-xl border border-border/60 px-2.5 py-2">
                    <span className="flex items-center gap-1.5 text-[8.5px] font-bold uppercase tracking-wider text-muted-foreground/75">
                      <span className={`h-1.5 w-1.5 flex-none rounded-full ${s.dot}`} />
                      {s.label}
                    </span>
                    <span className="mt-0.5 block text-lg font-extrabold leading-tight tabular-nums">{s.value}</span>
                  </div>
                ))}
              </div>

              {viewMode !== 'monthly' && (
                <div className="grid grid-cols-7 gap-1 px-4 pb-2">
                  {bandDays.map((d) => (
                    <button
                      key={d.day}
                      type="button"
                      onClick={() => { d.select(); setStatsSheetOpen(false); }}
                      title={d.tooltip}
                      className={`relative flex min-h-[46px] flex-col items-center justify-center rounded-lg border text-[10px] font-bold transition-colors touch-manipulation ${
                        d.isSelectedDay
                          ? 'border-blue-600 bg-blue-600 text-white'
                          : d.isWeekend
                            ? 'border-border/60 bg-muted/50 text-muted-foreground/75'
                            : 'border-border bg-card text-muted-foreground'
                      }`}
                    >
                      {d.holidayInfo.isHoliday && (
                        <span className={`absolute right-1 top-1 h-1.5 w-1.5 rounded-full ${d.holidayInfo.isCanadian ? 'bg-rose-400' : d.holidayInfo.isDynamic ? 'bg-violet-400' : 'bg-indigo-400'}`} />
                      )}
                      <span>{d.day[0]}</span>
                      <span className="text-[8px] opacity-70">{d.dayDate.getDate()}</span>
                      <span className="text-[11px] leading-tight tabular-nums">{d.count ?? 0}</span>
                    </button>
                  ))}
                </div>
              )}

              <div className="px-4 py-2">
                <div className="mb-1 flex items-baseline justify-between text-xs font-semibold text-foreground/85">
                  <span>Team Self-Pick <span className="font-extrabold tabular-nums">{selfPickPercentage}%</span></span>
                  <span className="font-medium text-muted-foreground/75">goal 70%</span>
                </div>
                <div className="relative h-2 rounded-full bg-muted">
                  <div
                    className={`absolute inset-y-0 left-0 rounded-full ${selfPickSheetBarClass}`}
                    style={{ width: `${Math.min(100, selfPickPercentage)}%` }}
                  />
                  <div className="absolute -bottom-[3px] -top-[3px] w-0.5 rounded-full bg-muted-foreground/60" style={{ left: '70%' }} />
                </div>
                {isToday && (
                  <div className="mt-1.5 flex items-center gap-3 text-[10px] font-semibold text-muted-foreground">
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-green-500" />{displayStats.lightLoad || 0} light</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-yellow-500" />{displayStats.mediumLoad || 0} medium</span>
                    <span className="flex items-center gap-1"><span className="h-2 w-2 rounded-full bg-red-500" />{displayStats.heavyLoad || 0} heavy</span>
                  </div>
                )}
              </div>

              <div className="px-4 pt-1">
                <div className="grid grid-cols-3 gap-0.5 rounded-lg bg-muted p-0.5">
                  <button onClick={handleSwitchToDaily} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors touch-manipulation ${viewMode === 'daily' ? 'bg-card text-blue-700 dark:text-blue-200 shadow-sm' : 'text-muted-foreground'}`}>Daily</button>
                  <button onClick={handleSwitchToWeekly} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors touch-manipulation ${viewMode === 'weekly' ? 'bg-card text-blue-700 dark:text-blue-200 shadow-sm' : 'text-muted-foreground'}`}>Weekly</button>
                  <button onClick={handleSwitchToMonthly} className={`rounded-md px-3 py-1.5 text-xs font-semibold transition-colors touch-manipulation ${viewMode === 'monthly' ? 'bg-card text-blue-700 dark:text-blue-200 shadow-sm' : 'text-muted-foreground'}`}>Monthly</button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Technicians List - Cascading */}
        <div>
          {/* Single merged controls row: Team identity + view controls (left)
              and Search + Category + Legend popover (right). Wraps on narrow
              screens via flex-wrap. */}
          <div className="mb-3 flex flex-col gap-2 sm:flex-row sm:items-center sm:flex-wrap lg:gap-3">
            {/* Team identity */}
            <div className="flex w-full items-center justify-between gap-2 sm:w-auto sm:justify-start sm:flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <img
                  src="/brand/icon-tech.png"
                  alt=""
                  aria-hidden="true"
                  className="w-6 h-6 flex-shrink-0"
                />
                <h2 className="text-base sm:text-lg font-semibold">Team</h2>
                <span className="text-xs text-muted-foreground">
                  ({searchTerm || hasActiveCategoryFilter ? `${techsWithRanks.length} of ${stats.totalTechnicians || 0}` : `${stats.totalTechnicians || 0} active`})
                </span>
              </div>
              <span className="rounded-full bg-card/80 px-2 py-1 text-[10px] font-semibold text-muted-foreground shadow-sm sm:hidden">
                {isCompactView ? 'Compact on desktop' : 'Cards'}
              </span>
            </div>

            {/* View toggle — Card / Compact */}
            <div className="hidden bg-muted rounded-lg p-0.5 text-xs font-medium flex-shrink-0 sm:flex">
              <button
                onClick={() => { if (isCompactView) toggleCompactView(); }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                  !isCompactView ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <LayoutGrid className="w-3.5 h-3.5" />
                Cards
              </button>
              <button
                onClick={() => { if (!isCompactView) toggleCompactView(); }}
                className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                  isCompactView ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                <List className="w-3.5 h-3.5" />
                Compact
              </button>
            </div>

            {/* Style toggle — Detailed / Simple (QA 07-30 #8) */}
            <div className="hidden bg-muted rounded-lg p-0.5 text-xs font-medium flex-shrink-0 sm:flex">
              <button
                onClick={() => handleDashStyle('detailed')}
                aria-pressed={!simpleStyle}
                title="Rich colors and icons"
                className={`px-2.5 py-1 rounded-md transition-all ${
                  !simpleStyle ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Detailed
              </button>
              <button
                onClick={() => handleDashStyle('simple')}
                aria-pressed={simpleStyle}
                title="Plain numbers, full-word headers, fewer colors"
                className={`px-2.5 py-1 rounded-md transition-all ${
                  simpleStyle ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground hover:text-foreground'
                }`}
              >
                Simple
              </button>
            </div>

            <button
              onClick={handleToggleNoise}
              className={`flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium transition-colors sm:flex-shrink-0 ${
                excludeNoise
                  ? 'bg-amber-100 dark:bg-amber-500/20 hover:bg-amber-200 dark:hover:bg-amber-500/30 text-amber-800 dark:text-amber-200 ring-1 ring-amber-300 dark:ring-amber-500/40'
                  : 'bg-muted hover:bg-secondary text-muted-foreground'
              }`}
              title={excludeNoise ? 'Noise tickets are hidden. Click to show all tickets.' : 'Click to hide automated/noise tickets (alerts, backups, monitoring, spam)'}
            >
              {excludeNoise ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
              <span>{excludeNoise ? 'Noise Hidden' : 'Hide Noise'}</span>
            </button>
            <DemoModeToggle onChange={() => { forceRefreshNoCache().catch(() => {}); }} />
            {hiddenTechnicians.length > 0 && (
              <button
                onClick={() => setShowHidden(!showHidden)}
                className="flex items-center gap-1.5 px-3 py-1 bg-muted hover:bg-secondary rounded-lg text-xs font-medium transition-colors flex-shrink-0"
              >
                {showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                <span>{hiddenTechnicians.length} Hidden</span>
              </button>
            )}
            {isCompactView && (
              <button
                onClick={() => setExpandAllOverride(prev => prev === true ? null : true)}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-xs font-medium transition-colors flex-shrink-0 ${
                  expandAllOverride === true
                    ? 'bg-blue-100 dark:bg-blue-500/20 hover:bg-blue-200 dark:hover:bg-blue-500/30 text-blue-700 dark:text-blue-200'
                    : 'bg-muted hover:bg-secondary text-foreground/85'
                }`}
                title={expandAllOverride === true ? 'Collapse all ticket details' : 'Expand all ticket details'}
              >
                {expandAllOverride === true ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                <span>{expandAllOverride === true ? 'Collapse All' : 'Expand All'}</span>
              </button>
            )}

            {/* Right cluster: search + category filter + clear + legend info.
                ml-auto on the SearchBox pushes the right cluster to the end. */}
            <SearchBox
              value={searchTerm}
              onChange={setSearchTerm}
              placeholder="Search tickets..."
              resultsCount={searchTerm || hasActiveCategoryFilter ? searchResultsCount : null}
              className="w-full sm:flex-1 sm:min-w-[200px] sm:max-w-md sm:ml-auto"
            />
            {isCanonicalCategoryMode ? (
              <CanonicalCategoryFilter
                categoryTree={categoryMetadata?.categoryTree || []}
                selectedCategoryIds={selectedCanonicalCategories.categoryIds || []}
                selectedSubcategoryIds={selectedCanonicalCategories.subcategoryIds || []}
                onChange={setSelectedCanonicalCategories}
                className="w-full sm:w-auto"
              />
            ) : (
              <CategoryFilter
                categories={allCategories}
                selected={selectedCategories}
                onChange={setSelectedCategories}
                placeholder="Category"
                className="w-full sm:w-auto"
              />
            )}
            {(searchTerm || hasActiveCategoryFilter || (viewMode === 'monthly' && monthlyData)) && (
              <button
                type="button"
                onClick={() => {
                  setSearchTerm('');
                  setSelectedCategories([]);
                  setSelectedCanonicalCategories({ categoryIds: [], subcategoryIds: [] });
                }}
                className="px-2.5 py-1 text-xs font-medium text-muted-foreground bg-card border border-input rounded-lg hover:bg-muted/50 transition-colors whitespace-nowrap flex-shrink-0"
                title="Clear all filters"
              >
                Clear
              </button>
            )}
            <LegendPopover showOpen={isToday} />
          </div>

          {/* Hidden Technicians Section */}
          {showHidden && hiddenTechnicians.length > 0 && (
            <div className="mb-6 bg-muted/50 border border-border rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-foreground/85">Hidden Technicians</h3>
                <button
                  onClick={handleClearAllHidden}
                  className="text-xs text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200 font-medium"
                >
                  Restore All
                </button>
              </div>
              <div className="space-y-2">
                {hiddenTechnicians.map((tech) => (
                  <div
                    key={tech.id}
                    className="flex items-center justify-between bg-card p-3 rounded border border-border"
                  >
                    <span className="text-sm text-foreground/85">{tech.name}</span>
                    <button
                      onClick={() => handleRestoreTechnician(tech.id)}
                      className="flex items-center gap-1 px-3 py-1 bg-blue-50 dark:bg-blue-500/15 hover:bg-blue-100 dark:hover:bg-blue-500/20 text-blue-600 dark:text-blue-300 rounded text-xs font-medium transition-colors"
                    >
                      <Eye className="w-3 h-3" />
                      Restore
                    </button>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Visible Technicians */}
          {viewMode === 'monthly' ? (
            /* Monthly calendar view */
            <div className="animate-fadeIn">
              <MonthlyCalendar
                monthlyData={monthlyData}
                selectedMonth={selectedMonth}
                onMonthChange={setSelectedMonth}
                technicians={visibleTechnicians}
                searchTerm={searchTerm}
                selectedCategories={activeCategoryFilter}
                onClearSelections={() => {
                  // This will be handled by the useEffect in MonthlyCalendar
                }}
              />
            </div>
          ) : techsWithRanks.length === 0 ? (
            /* No technicians found (daily/weekly only) */
            <div className="bg-card rounded-lg shadow-sm p-8 text-center border border-border overflow-hidden relative">
              <img
                src="/brand/hero-welcome.webp"
                alt=""
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover opacity-15 pointer-events-none"
              />
              <div className="relative">
                <img
                  src="/brand/icon-tech.png"
                  alt=""
                  className="w-16 h-16 mx-auto mb-3 opacity-70"
                />
                <p className="text-foreground/85 font-medium">
                  {searchTerm || hasActiveCategoryFilter ? 'No matching tickets found' : 'No technicians found'}
                </p>
                <p className="text-sm text-muted-foreground mt-2">
                  {searchTerm || hasActiveCategoryFilter
                    ? hasActiveCategoryFilter && !searchTerm
                      ? 'This can be normal for exact subcategories that do not have tickets in the selected date range.'
                      : 'Try adjusting your search or filters'
                    : technicians.length > 0
                      ? 'All technicians are hidden. Click "Show Hidden" to restore them.'
                      : 'Sync with FreshService to see technicians'}
                </p>
                {(searchTerm || hasActiveCategoryFilter) && (
                  <div className="flex gap-2 justify-center mt-4">
                    {searchTerm && (
                      <button
                        onClick={() => setSearchTerm('')}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        Clear Search
                      </button>
                    )}
                    {hasActiveCategoryFilter && (
                      <button
                        onClick={() => {
                          setSelectedCategories([]);
                          setSelectedCanonicalCategories({ categoryIds: [], subcategoryIds: [] });
                        }}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                      >
                        Clear Filters
                      </button>
                    )}
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Grid or List layout based on view mode (daily/weekly) */
            <>
              {(() => {
                // Calculate max open ticket count for relative color scaling
                const maxOpenCount = Math.max(...techsWithRanks.map(t => t.openOnlyCount || 0), 1);

                // Calculate max daily ticket count for color gradient (weekly view)
                let maxDailyCount = 1;
                if (viewMode === 'weekly') {
                  techsWithRanks.forEach(tech => {
                    if (tech.dailyBreakdown) {
                      tech.dailyBreakdown.forEach(day => {
                        if (day.total > maxDailyCount) {
                          maxDailyCount = day.total;
                        }
                      });
                    }
                  });
                }

                // When the user has picked an explicit compact-table sort,
                // resort `techsWithRanks` (a copy — keep the rank field as
                // computed from the default self-picked ranking).
                const compactRows = (() => {
                  if (!isCompactView || !compactSort.field) return techsWithRanks;
                  const dir = compactSort.direction === 'asc' ? 1 : -1;
                  return [...techsWithRanks].sort((a, b) => {
                    const av = getSortValue(a, compactSort.field, viewMode);
                    const bv = getSortValue(b, compactSort.field, viewMode);
                    if (typeof av === 'string' || typeof bv === 'string') {
                      return (
                        String(av ?? '').localeCompare(String(bv ?? '')) * dir
                      );
                    }
                    const an = av ?? -Infinity;
                    const bn = bv ?? -Infinity;
                    if (an === bn) return (a.name || '').localeCompare(b.name || '');
                    return (an - bn) * dir;
                  });
                })();

                return isCompactView ? (
                  /* Compact view - data table with sticky column header.
                     Header + rows share ONE horizontal scroll container with a
                     min-width matching the grid tracks, so in the 640–1100px
                     iPad band they scroll together instead of the trailing
                     columns spilling past the right edge (QA 08-04 #3). Above
                     1100px .tp-compact-scroll stops scrolling and the header's
                     sticky positioning works against the page again. */
                  <div className="animate-fadeIn">
                    <div className="hidden sm:block tp-compact-scroll settings-scrollbar">
                      <div style={{ minWidth: getCompactMinWidth(viewMode, simpleStyle) }}>
                        <TechCompactHeader
                          viewMode={viewMode}
                          sortField={compactSort.field}
                          sortDirection={compactSort.direction}
                          onSort={handleCompactSort}
                          simple={simpleStyle}
                        />
                        <div className="space-y-1.5">
                          {compactRows.map((tech, index) => (
                            <div
                              key={tech.id}
                              className="animate-slideInLeft"
                              style={{ animationDelay: `${index * 20}ms` }}
                            >
                              <TechCardCompact
                                technician={tech}
                                rank={tech.rank}
                                onHide={handleHideTechnician}
                                selectedDate={selectedDate}
                                selectedWeek={selectedWeek}
                                selectedMonth={selectedMonth}
                                maxOpenCount={maxOpenCount}
                                maxDailyCount={maxDailyCount}
                                viewMode={viewMode}
                                searchTerm={searchTerm}
                                selectedCategories={selectedCategories}
                                canonicalCategoryFilter={selectedCanonicalCategories}
                                forceExpand={expandAllOverride}
                                simple={simpleStyle}
                                topLoad={tech.id === topLoadTechId}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    </div>
                    <div className="grid grid-cols-1 gap-3 sm:hidden">
                      {compactRows.map((tech, index) => (
                        <div
                          key={tech.id}
                          className="animate-scaleIn"
                          style={{ animationDelay: `${index * 20}ms` }}
                        >
                          <TechCard
                            technician={tech}
                            rank={tech.rank}
                            onHide={handleHideTechnician}
                            selectedDate={selectedDate}
                            selectedWeek={selectedWeek}
                            selectedMonth={selectedMonth}
                            maxOpenCount={maxOpenCount}
                            maxDailyCount={maxDailyCount}
                            viewMode={viewMode}
                            searchTerm={searchTerm}
                            selectedCategories={selectedCategories}
                            canonicalCategoryFilter={selectedCanonicalCategories}
                            simple={simpleStyle}
                            topLoad={tech.id === topLoadTechId}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ) : (
                  /* Normal view - Grid layout with cards */
                  <div className="grid grid-cols-1 gap-3 lg:grid-cols-2 xl:grid-cols-4 lg:gap-4 animate-fadeIn">
                    {techsWithRanks.map((tech, index) => (
                      <div
                        key={tech.id}
                        className="animate-scaleIn"
                        style={{ animationDelay: `${index * 30}ms` }}
                      >
                        <TechCard
                          technician={tech}
                          rank={tech.rank}
                          onHide={handleHideTechnician}
                          selectedDate={selectedDate}
                          selectedWeek={selectedWeek}
                          selectedMonth={selectedMonth}
                          maxOpenCount={maxOpenCount}
                          maxDailyCount={maxDailyCount}
                          viewMode={viewMode}
                          searchTerm={searchTerm}
                          selectedCategories={selectedCategories}
                          canonicalCategoryFilter={selectedCanonicalCategories}
                          simple={simpleStyle}
                          topLoad={tech.id === topLoadTechId}
                        />
                      </div>
                    ))}
                  </div>
                );
              })()}
            </>
          )}
        </div>
      </main>

    </AppShell>
  );
}
