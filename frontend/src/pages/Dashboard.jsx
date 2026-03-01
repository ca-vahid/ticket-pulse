import { useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { useAuth } from '../contexts/AuthContext';
import { syncAPI, getGlobalExcludeNoise, setGlobalExcludeNoise } from '../services/api';
import TechCard from '../components/TechCard';
import TechCardCompact from '../components/TechCardCompact';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import MonthlyCalendar from '../components/MonthlyCalendar';
import ExportButton from '../components/ExportButton';
import { filterTickets } from '../utils/ticketFilter';
import { getHolidayTooltip, getHolidayInfo } from '../utils/holidays';
// formatDateLocal is defined locally via useCallback
import ChangelogModal from '../components/ChangelogModal';
import { APP_VERSION } from '../data/changelog';
import { usePrefetch } from '../hooks/usePrefetch';
import {
  Users,
  CheckCircle,
  XCircle,
  Activity,
  RefreshCw,
  LogOut,
  Settings,
  Wifi,
  WifiOff,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  ChevronDown,
  Calendar,
  Eye,
  EyeOff,
  Maximize2,
  Minimize2,
  TrendingUp,
  TrendingDown,
  Minus,
  FolderOpen,
  Hand,
  Inbox,
  CheckSquare,
  Clock,
  Map,
  Layers,
  GitBranch,
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
    isRefreshing,
    isLoading,
    error,
    lastUpdated,
    sseConnectionStatus,
    fetchDashboard,
    fetchWeeklyStats,
    fetchWeeklyDashboard,
    fetchMonthlyDashboard,
    setCurrentView,
    invalidateCurrentView,
    invalidateDateRange,
    clearCacheOnLogout,
  } = useDashboard();
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
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

  // Noise filter
  const [excludeNoise, setExcludeNoise] = useState(() => getGlobalExcludeNoise());

  // Changelog modal
  const [showChangelog, setShowChangelog] = useState(false);

  // Compact view state - persisted in localStorage
  const [isCompactView, setIsCompactView] = useState(() => {
    const stored = localStorage.getItem('compactView');
    return stored ? JSON.parse(stored) : false;
  });

  // Expand-all override for compact view: null = individual control, true/false = forced
  const [expandAllOverride, setExpandAllOverride] = useState(null);

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

  // Persist search term to sessionStorage whenever it changes
  useEffect(() => {
    sessionStorage.setItem('dashboard_search', searchTerm);
  }, [searchTerm]);

  // Persist selected categories to sessionStorage whenever they change
  useEffect(() => {
    sessionStorage.setItem('dashboard_categories', JSON.stringify(selectedCategories));
  }, [selectedCategories]);

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
    invalidateCurrentView();
    await new Promise(resolve => setTimeout(resolve, 200));
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
  }, [excludeNoise, viewMode, selectedDate, selectedWeek, selectedMonth, invalidateCurrentView, fetchDashboard, fetchWeeklyDashboard, fetchMonthlyDashboard, fetchWeeklyStats, formatDateLocal]);

  const handleRetryLoad = useCallback(async () => {
    await refreshCurrentView();
  }, [refreshCurrentView]);

  const handleRefresh = useCallback(async () => {
    console.log('[SYNC] Starting sync process...');
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
      console.log('[SYNC] Initial status:', initialStatus.data);
      addSyncLog(`Initial status: ${initialStatus.data?.sync?.isRunning ? 'Sync already running' : 'Ready to sync'}`, 'info');

      // Trigger the sync (this waits for completion)
      console.log('[SYNC] Calling trigger API...');
      addSyncLog('Calling sync API endpoint...', 'info');
      addSyncLog('⏱ This may take several minutes due to FreshService API rate limits (1 request/second)', 'warn');
      addSyncLog('The backend will process each ticket sequentially to avoid hitting rate limits', 'info');

      const startTime = Date.now();
      const triggerResult = await syncAPI.trigger();
      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      console.log('[SYNC] Trigger result:', triggerResult.data);

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
      console.log('[SYNC] Fetching final status...');
      const finalStatus = await syncAPI.getStatus();
      console.log('[SYNC] Final status:', finalStatus.data);

      const latestSync = finalStatus.data?.latestSync;
      console.log('[SYNC] Latest sync record:', latestSync);

      if (latestSync?.status === 'completed') {
        const techCount = triggerResult.data?.techniciansSynced || 0;
        const ticketCount = triggerResult.data?.ticketsSynced || 0;

        addSyncLog(`✓ Synced ${techCount} technicians`, 'success');
        addSyncLog(`✓ Synced ${ticketCount} tickets`, 'success');
        addSyncLog(`✓ Total records processed: ${latestSync.recordsProcessed || (techCount + ticketCount)}`, 'success');

        setSyncStatus('success');
        setSyncMessage(`Sync completed! Synced ${techCount} technicians and ${ticketCount} tickets.`);

        console.log('[SYNC] Refreshing dashboard data...');
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
    console.log('[SYNC WEEK] Starting week sync process...');
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

  const handleLogout = async () => {
    clearCacheOnLogout();
    await logout();
    navigate('/login');
  };

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

  const handleSettings = () => {
    navigate('/settings');
  };

  const handleVisuals = () => {
    navigate('/visuals');
  };

  const handleTimeline = () => {
    navigate('/timeline');
  };

  if (isLoading && !dashboardData) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="text-center">
          <Activity className="w-12 h-12 animate-spin mx-auto mb-4 text-blue-600" />
          <p className="text-gray-600">Loading dashboard...</p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <div className="bg-red-50 border border-red-200 rounded-lg p-6 max-w-md">
          <XCircle className="w-12 h-12 text-red-600 mx-auto mb-4" />
          <p className="text-red-800 text-center">{error}</p>
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
    const assigned = filteredTickets.filter(t => !t.isSelfPicked && t.assignedBy !== tech.name);
    const closed = filteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status));

    // Calculate assigners (who assigned tickets to this tech)
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
        const dayAssigned = dayTickets.filter(t => !t.isSelfPicked && t.assignedBy !== tech.name).length;
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
      assignedToday: assigned.length,
      closedToday: closed.length,

      // Weekly stats (if in weekly mode)
      weeklyTotalCreated: filteredTickets.length,
      weeklySelfPicked: selfPicked.length,
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
      if (ticket.ticketCategory) {
        categorySet.add(ticket.ticketCategory);
      }
    });
  });
  const allCategories = Array.from(categorySet).sort();

  // Apply search and category filters using centralized filtering utility
  const filteredTechnicians = (searchTerm || selectedCategories.length > 0)
    ? visibleTechnicians.map(tech => {
      // Filter tickets using centralized filterTickets function
      const techTickets = getTechTickets(tech);
      const matchingTickets = filterTickets(techTickets, searchTerm, selectedCategories);

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
  const searchResultsCount = searchTerm || selectedCategories.length > 0
    ? filteredTechnicians.reduce((sum, tech) => sum + (tech.matchingTicketCount || getTechTickets(tech).length || 0), 0)
    : 0;

  // Recalculate stats based on filtered tickets (if filters are active)
  const displayStats = (searchTerm || selectedCategories.length > 0) ? (() => {
    // Collect all filtered tickets
    const allFilteredTickets = filteredTechnicians.flatMap(tech => getTechTickets(tech));

    // Calculate filtered stats based on view mode
    const filteredStats = {
      totalTechnicians: filteredTechnicians.length,

      // Daily view stats
      totalTicketsToday: allFilteredTickets.length,
      openOnlyCount: allFilteredTickets.filter(t => t.status === 'Open').length,
      pendingCount: allFilteredTickets.filter(t => t.status === 'Pending').length,
      closedTicketsToday: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      selfPickedToday: allFilteredTickets.filter(t => t.isSelfPicked).length,

      // Weekly view stats
      weeklyTotalCreated: allFilteredTickets.length,
      weeklyClosed: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      weeklySelfPicked: allFilteredTickets.filter(t => t.isSelfPicked).length,
      weeklyAssigned: allFilteredTickets.filter(t => !t.isSelfPicked).length,

      // Monthly view stats
      monthTotalCreated: allFilteredTickets.length,
      monthClosed: allFilteredTickets.filter(t => ['Closed', 'Resolved'].includes(t.status)).length,
      monthSelfPicked: allFilteredTickets.filter(t => t.isSelfPicked).length,
      monthAssigned: allFilteredTickets.filter(t => !t.isSelfPicked).length,

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

  // Calculate rankings based on self-picked today (only for visible/searched/filtered techs)
  const techsWithRanks = [...filteredTechnicians]
    .sort((a, b) => b.selfPickedToday - a.selfPickedToday)
    .map((tech, index) => ({
      ...tech,
      rank: tech.selfPickedToday > 0 ? index + 1 : null,
    }));

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
  const selfPickPercentage = totalTicketsToday > 0
    ? Math.round((selfPickedToday / totalTicketsToday) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-100 relative">
      {/* Fancy Loading Overlay */}
      {(isColdLoading && (dashboardData || weeklyData || monthlyData)) && (
        <div className="fixed inset-0 z-50 flex items-center justify-center pointer-events-none">
          {/* Faded background overlay */}
          <div className="absolute inset-0 bg-gray-900/20 backdrop-blur-[1px]" />
          
          {/* Animated spinner container */}
          <div className="relative">
            {/* Outer ring - slow spin */}
            <div 
              className="absolute inset-0 w-20 h-20 rounded-full border-4 border-transparent border-t-blue-500 border-r-blue-300 opacity-80"
              style={{ animation: 'spin 1.5s linear infinite' }}
            />
            
            {/* Middle ring - medium spin, opposite direction */}
            <div 
              className="absolute inset-2 w-16 h-16 rounded-full border-4 border-transparent border-b-purple-500 border-l-purple-300 opacity-70"
              style={{ animation: 'spin 1s linear infinite reverse', marginLeft: '0.5rem', marginTop: '0.5rem' }}
            />
            
            {/* Inner ring - fast spin */}
            <div 
              className="absolute inset-4 w-12 h-12 rounded-full border-4 border-transparent border-t-indigo-500 border-r-indigo-300 opacity-90"
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
      
      {/* Compact Header - Single Row Grid */}
      <header className="sticky top-0 z-40 bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="grid grid-cols-12 gap-4 items-center">
            {/* Left: Title + User - 3 cols */}
            <div className="col-span-3">
              <div className="flex items-center gap-2">
                <h1 className="text-lg font-bold text-gray-800">Ticket Pulse Dashboard</h1>
                <button
                  onClick={() => setShowChangelog(true)}
                  className="text-[10px] font-semibold text-blue-600 bg-blue-50 px-1.5 py-0.5 rounded-md hover:bg-blue-100 border border-blue-200 transition-colors"
                  title="View changelog"
                >
                  v{APP_VERSION}
                </button>
              </div>
              <p className="text-xs text-gray-600">Welcome, {user?.name || user?.username}</p>
            </div>

            {/* Center: Status + Last Updated - 6 cols */}
            <div className="col-span-6 flex items-center justify-center gap-4">
              {/* SSE Status */}
              <div className="flex items-center gap-1.5 text-xs">
                {sseConnectionStatus === 'connected' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-green-600" />
                    <span className="text-green-600 font-medium">Live</span>
                  </>
                ) : sseConnectionStatus === 'connecting' ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-amber-500 animate-pulse" />
                    <span className="text-amber-500 font-medium">Connecting...</span>
                  </>
                ) : (
                  <>
                    <WifiOff className="w-3.5 h-3.5 text-red-600" />
                    <span className="text-red-600 font-medium">Offline</span>
                  </>
                )}
              </div>

              {/* Background Sync Status */}
              {backgroundSyncRunning && (
                <div className="flex items-center gap-1 text-xs bg-blue-50 border border-blue-200 rounded-lg px-2 py-1 max-w-[260px]">
                  <RefreshCw className="w-3 h-3 text-blue-500 animate-spin flex-none" />
                  <div className="flex flex-col min-w-0 mx-1">
                    <span className="font-semibold text-blue-700 leading-tight">Syncing…</span>
                    {backgroundSyncStep && (
                      <span className="text-[9px] text-blue-500 truncate leading-tight">{backgroundSyncStep}</span>
                    )}
                  </div>
                  <button
                    onClick={handleKillSync}
                    disabled={killingSync}
                    className="flex-none ml-1 p-0.5 rounded hover:bg-red-100 text-slate-400 hover:text-red-600 transition-colors"
                    title="Force-stop stuck sync"
                  >
                    <XCircle className="w-3.5 h-3.5" />
                  </button>
                </div>
              )}

              {/* Last Updated / Refreshing indicator */}
              {isRefreshing && !isColdLoading ? (
                <span className="text-xs text-blue-500 flex items-center gap-1">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  Refreshing...
                </span>
              ) : lastUpdated ? (
                <span className="text-xs text-gray-500">
                  Updated: {new Date(lastUpdated).toLocaleTimeString()}
                </span>
              ) : null}
            </div>

            {/* Right: Action Buttons - 3 cols */}
            <div className="col-span-3 flex items-center justify-end gap-2">
              {/* Export Button */}
              <ExportButton
                tickets={filteredTechnicians.flatMap(tech => getTechTickets(tech))}
                technicians={filteredTechnicians}
                viewMode={viewMode}
                selectedDate={selectedDate}
                selectedWeek={selectedWeek}
                selectedMonth={selectedMonth}
              />

              {/* Sync buttons — greyed out when any sync is running */}
              <div className="flex items-center">
                <button
                  onClick={handleRefresh}
                  disabled={refreshing || backgroundSyncRunning}
                  className={`p-1.5 rounded-l-lg border border-r-0 border-gray-300 transition-colors ${
                    refreshing || backgroundSyncRunning
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-gray-100'
                  }`}
                  title="Sync All"
                >
                  <RefreshCw className="w-4 h-4" />
                </button>
                <button
                  onClick={handleSyncWeek}
                  disabled={refreshing || backgroundSyncRunning}
                  className={`p-1.5 rounded-r-lg border border-gray-300 transition-colors ${
                    refreshing || backgroundSyncRunning
                      ? 'opacity-40 cursor-not-allowed'
                      : 'hover:bg-blue-50 hover:border-blue-300'
                  }`}
                  title="Sync Week (full detail sync for current week)"
                >
                  <Calendar className="w-4 h-4" />
                </button>
              </div>

              {/* Timeline Explorer */}
              <button
                onClick={handleTimeline}
                className="group flex items-center gap-1.5 pl-2 pr-3 py-1.5 rounded-full text-xs font-semibold transition-all border border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100 hover:border-indigo-300 hover:shadow-sm whitespace-nowrap"
                title="Timeline Explorer"
              >
                <span className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center group-hover:bg-indigo-700 transition-colors">
                  <Clock className="w-3 h-3 text-white" />
                </span>
                Timeline Explorer
              </button>

              {/* Visuals Button */}
              <button
                onClick={handleVisuals}
                className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                title="Visuals"
              >
                <Map className="w-4 h-4" />
              </button>

              {/* Settings Button */}
              <button
                onClick={handleSettings}
                className="p-1.5 hover:bg-gray-100 rounded transition-colors"
                title="Settings"
              >
                <Settings className="w-4 h-4" />
              </button>

              {/* Logout Button */}
              <button
                onClick={handleLogout}
                className="p-1.5 hover:bg-gray-100 rounded transition-colors text-red-600"
                title="Logout"
              >
                <LogOut className="w-4 h-4" />
              </button>
            </div>
          </div>
        </div>
      </header>

      {/* Sync Status Notification */}
      {syncStatus && (
        <div className="max-w-7xl mx-auto px-4 pt-4">
          <div className={`
            rounded-lg p-4 flex items-center justify-between shadow-lg
            ${syncStatus === 'syncing' ? 'bg-blue-50 border border-blue-200' : ''}
            ${syncStatus === 'success' ? 'bg-green-50 border border-green-200' : ''}
            ${syncStatus === 'error' ? 'bg-red-50 border border-red-200' : ''}
          `}>
            <div className="flex items-center gap-3">
              {syncStatus === 'syncing' && (
                <RefreshCw className="w-5 h-5 text-blue-600 animate-spin" />
              )}
              {syncStatus === 'success' && (
                <CheckCircle className="w-5 h-5 text-green-600" />
              )}
              {syncStatus === 'error' && (
                <XCircle className="w-5 h-5 text-red-600" />
              )}
              <div>
                <p className={`font-semibold ${
                  syncStatus === 'syncing' ? 'text-blue-900' :
                    syncStatus === 'success' ? 'text-green-900' :
                      'text-red-900'
                }`}>
                  {syncStatus === 'syncing' ? 'Syncing...' :
                    syncStatus === 'success' ? 'Sync Successful' :
                      'Sync Failed'}
                </p>
                <p className={`text-sm ${
                  syncStatus === 'syncing' ? 'text-blue-700' :
                    syncStatus === 'success' ? 'text-green-700' :
                      'text-red-700'
                }`}>
                  {syncMessage}
                </p>
              </div>
            </div>
            {syncStatus !== 'syncing' && (
              <button
                onClick={() => setSyncStatus(null)}
                className="text-gray-400 hover:text-gray-600"
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
          <div className="bg-white rounded-lg border border-gray-300 shadow-md overflow-hidden">
            {/* Header */}
            <div
              className="bg-gray-100 px-4 py-3 flex items-center justify-between cursor-pointer hover:bg-gray-150 transition-colors"
              onClick={() => setShowSyncDetails(!showSyncDetails)}
            >
              <div className="flex items-center gap-2">
                <Activity className="w-5 h-5 text-blue-600" />
                <h3 className="font-semibold text-gray-800">Sync Details</h3>
                <span className="text-sm text-gray-500">({syncLogs.length} events)</span>
              </div>
              <button className="text-gray-500 hover:text-gray-700">
                {showSyncDetails ? (
                  <ChevronUp className="w-5 h-5" />
                ) : (
                  <ChevronDown className="w-5 h-5" />
                )}
              </button>
            </div>

            {/* Log Content */}
            {showSyncDetails && (
              <div className="p-4 bg-gray-50 max-h-96 overflow-y-auto">
                <div className="space-y-1 font-mono text-sm">
                  {syncLogs.map((log, index) => (
                    <div
                      key={index}
                      className={`flex items-start gap-3 py-1 px-2 rounded ${
                        log.type === 'error' ? 'bg-red-50 text-red-800' :
                          log.type === 'warn' ? 'bg-yellow-50 text-yellow-800' :
                            log.type === 'success' ? 'bg-green-50 text-green-800' :
                              'text-gray-700'
                      }`}
                    >
                      <span className="text-gray-500 text-xs whitespace-nowrap">{log.timestamp}</span>
                      <span className={`font-semibold ${
                        log.type === 'error' ? 'text-red-600' :
                          log.type === 'warn' ? 'text-yellow-600' :
                            log.type === 'success' ? 'text-green-600' :
                              'text-blue-600'
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
      <main className="max-w-7xl mx-auto px-4 py-3">
        {/* Stats Bar: Date Navigation (left) + Stats + Self-Pick + View Toggle (right) */}
        <div className="sticky top-[52px] z-30 bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg shadow-lg p-3 mb-4">
          <div className="flex items-stretch gap-3 text-white">

            {/* LEFT ZONE: Date Navigation + Day Grid */}
            <div className="flex-none w-80">
              {/* Navigation Controls */}
              <div className="flex items-center gap-1.5 mb-1.5">
                <button
                  onClick={viewMode === 'daily' ? goToPreviousDay : viewMode === 'weekly' ? goToPreviousWeek : goToPreviousMonth}
                  className="p-1.5 hover:bg-white hover:bg-opacity-20 rounded transition-colors flex-none"
                  title={viewMode === 'daily' ? 'Previous day' : viewMode === 'weekly' ? 'Previous week' : 'Previous month'}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1.5 flex-1 min-w-0">
                  <Calendar className="w-3.5 h-3.5 flex-none opacity-80" />
                  {viewMode === 'daily' ? (
                    <input
                      type="date"
                      value={formatDateLocal(selectedDate)}
                      onChange={(e) => setSelectedDate(new Date(e.target.value + 'T12:00:00'))}
                      className="bg-white bg-opacity-20 border border-white border-opacity-30 rounded px-2 py-0.5 text-white text-xs focus:outline-none focus:ring-1 focus:ring-white flex-1 min-w-0"
                    />
                  ) : viewMode === 'weekly' ? (
                    <div className="bg-white bg-opacity-20 border border-white border-opacity-30 rounded px-2 py-0.5 text-white text-xs flex-1 min-w-0 text-center truncate">
                      {(() => {
                        const weekEnd = new Date(selectedWeek);
                        weekEnd.setDate(selectedWeek.getDate() + 6);
                        return `${selectedWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} \u2013 ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
                      })()}
                    </div>
                  ) : (
                    <div className="bg-white bg-opacity-20 border border-white border-opacity-30 rounded px-2 py-0.5 text-white text-xs flex-1 min-w-0 text-center">
                      {selectedMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })}
                    </div>
                  )}
                </div>
                <button
                  onClick={viewMode === 'daily' ? goToNextDay : viewMode === 'weekly' ? goToNextWeek : goToNextMonth}
                  disabled={viewMode === 'daily' && isToday}
                  className={`p-1.5 rounded transition-colors flex-none ${(viewMode === 'daily' && isToday) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white hover:bg-opacity-20'}`}
                  title={viewMode === 'daily' ? 'Next day' : viewMode === 'weekly' ? 'Next week' : 'Next month'}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                {!isToday && viewMode === 'daily' && (
                  <button
                    onClick={goToToday}
                    className="px-2 py-0.5 bg-white bg-opacity-20 hover:bg-opacity-30 rounded text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    Today
                  </button>
                )}
                {viewMode === 'weekly' && (
                  <button
                    onClick={goToCurrentWeek}
                    className="px-2 py-0.5 bg-white bg-opacity-20 hover:bg-opacity-30 rounded text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    This Week
                  </button>
                )}
                {viewMode === 'monthly' && (
                  <button
                    onClick={goToCurrentMonth}
                    className="px-2 py-0.5 bg-white bg-opacity-20 hover:bg-opacity-30 rounded text-xs font-semibold transition-colors whitespace-nowrap"
                  >
                    This Month
                  </button>
                )}
              </div>

              {/* Day of Week Indicators - Clickable (Monday to Sunday) */}
              <div className="flex justify-between gap-0.5">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
                  const currentDay = (selectedDate.getDay() + 6) % 7;
                  const dayStats = weeklyStats?.[index];
                  const ticketCount = dayStats?.count ?? null;

                  let dayDate;
                  if (viewMode === 'weekly' && selectedWeek) {
                    dayDate = new Date(selectedWeek);
                    dayDate.setDate(selectedWeek.getDate() + index);
                  } else {
                    const dayDifference = index - currentDay;
                    dayDate = new Date(selectedDate);
                    dayDate.setDate(dayDate.getDate() + dayDifference);
                  }
                  const dayDateStr = `${dayDate.getFullYear()}-${String(dayDate.getMonth() + 1).padStart(2, '0')}-${String(dayDate.getDate()).padStart(2, '0')}`;

                  const todayStr = formatDateLocal(new Date());
                  const isActualToday = dayDateStr === todayStr;
                  const isSelectedDay = viewMode === 'daily'
                    ? index === currentDay
                    : isActualToday;
                  const isWeekendDay = index === 5 || index === 6;
                  const holidayInfo = getHolidayInfo(dayDateStr);
                  const isHolidayDay = holidayInfo.isHoliday;
                  const holidayTooltip = getHolidayTooltip(dayDateStr);

                  let trendIcon = null;
                  let trendColor = '';
                  if (weeklyStats && index > 0) {
                    const prevDayCount = weeklyStats[index - 1]?.count ?? 0;
                    const currentCount = ticketCount ?? 0;
                    if (currentCount > prevDayCount) {
                      trendIcon = <TrendingUp className="w-2.5 h-2.5" />;
                      trendColor = 'text-red-400';
                    } else if (currentCount < prevDayCount) {
                      trendIcon = <TrendingDown className="w-2.5 h-2.5" />;
                      trendColor = 'text-green-400';
                    } else if (currentCount === prevDayCount && currentCount > 0) {
                      trendIcon = <Minus className="w-2.5 h-2.5" />;
                      trendColor = 'text-gray-400';
                    }
                  }

                  const handleDayClick = () => {
                    if (viewMode === 'weekly') {
                      setSelectedDate(new Date(dayDate));
                      setViewMode('daily');
                      return;
                    }
                    setSelectedDate(new Date(dayDate));
                  };

                  let buttonTooltip = day;
                  if (ticketCount !== null) buttonTooltip += ` - ${ticketCount} tickets`;
                  if (holidayTooltip) buttonTooltip += `\n${holidayTooltip}`;

                  const getButtonClasses = () => {
                    if (isSelectedDay) {
                      if (isHolidayDay && holidayInfo.isCanadian) return 'bg-rose-100 text-rose-700 shadow-md scale-110 ring-2 ring-rose-300';
                      if (isHolidayDay) return 'bg-indigo-100 text-indigo-700 shadow-md scale-110 ring-2 ring-indigo-300';
                      if (isWeekendDay) return 'bg-slate-100 text-slate-700 shadow-md scale-110';
                      return 'bg-white text-blue-600 shadow-md scale-110';
                    }
                    if (viewMode === 'weekly') {
                      if (isHolidayDay && holidayInfo.isCanadian) return 'text-rose-300 hover:text-rose-100 hover:bg-rose-400 hover:bg-opacity-30 cursor-pointer';
                      if (isHolidayDay) return 'text-indigo-300 hover:text-indigo-100 hover:bg-indigo-400 hover:bg-opacity-30 cursor-pointer';
                      if (isWeekendDay) return 'text-slate-300 hover:text-white hover:bg-slate-400 hover:bg-opacity-30 cursor-pointer';
                      return 'text-white opacity-90 hover:opacity-100 hover:bg-white hover:bg-opacity-20 cursor-pointer';
                    }
                    if (isHolidayDay && holidayInfo.isCanadian) return 'text-rose-300 hover:text-rose-100 hover:bg-rose-400 hover:bg-opacity-30 cursor-pointer';
                    if (isHolidayDay) return 'text-indigo-300 hover:text-indigo-100 hover:bg-indigo-400 hover:bg-opacity-30 cursor-pointer';
                    if (isWeekendDay) return 'text-slate-300 hover:text-white hover:bg-slate-400 hover:bg-opacity-30 cursor-pointer';
                    return 'text-white opacity-90 hover:opacity-100 hover:bg-white hover:bg-opacity-20 cursor-pointer';
                  };

                  return (
                    <button
                      key={day}
                      onClick={handleDayClick}
                      className={`text-[10px] font-semibold px-1 py-0.5 rounded transition-all flex flex-col items-center relative flex-1 ${getButtonClasses()}`}
                      title={buttonTooltip}
                    >
                      {isHolidayDay && (
                        <div className={`absolute -top-0.5 -right-0.5 w-1.5 h-1.5 rounded-full ${holidayInfo.isCanadian ? 'bg-rose-400' : 'bg-indigo-400'}`} />
                      )}
                      <span>{day}</span>
                      <span className="text-[7px] opacity-60 -mt-0.5">{dayDate.getDate()}</span>
                      {ticketCount !== null && (
                        <div className="flex items-center gap-0.5">
                          <span className="text-[9px] font-bold">{ticketCount}</span>
                          {trendIcon && <span className={trendColor}>{trendIcon}</span>}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Vertical Divider */}
            <div className="w-px bg-white bg-opacity-20 flex-none self-stretch" />

            {/* RIGHT ZONE: Stats Cards + Self-Pick + View Toggle */}
            <div className="flex items-center gap-2 flex-1 min-w-0 justify-end">

              {/* Stats Cards */}
              <div className="flex items-center gap-1.5">
                {/* Total */}
                <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-opacity-20 transition-all">
                  <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-blue-400 bg-opacity-30 flex-none">
                    <Inbox className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div>
                    <div className="text-base font-bold leading-tight">
                      {viewMode === 'monthly' ? (displayStats.monthTotalCreated || 0) : viewMode === 'weekly' ? (displayStats.weeklyTotalCreated || 0) : (displayStats.totalTicketsToday || 0)}
                    </div>
                    <div className="text-[9px] text-blue-100 uppercase font-medium leading-tight">
                      <div>Total</div>
                      <div className="text-[8px] opacity-80">
                        {viewMode === 'monthly'
                          ? selectedMonth.toLocaleDateString('en-US', { month: 'short', year: 'numeric' })
                          : viewMode === 'weekly'
                            ? `${(() => {
                              const weekEnd = new Date(selectedWeek);
                              weekEnd.setDate(selectedWeek.getDate() + 6);
                              return `${selectedWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} \u2013 ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                            })()}`
                            : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                        }
                      </div>
                    </div>
                  </div>
                </div>

                {/* Open - Daily only */}
                {viewMode === 'daily' && (
                  <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-opacity-20 transition-all">
                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-yellow-500 bg-opacity-30 flex-none">
                      <FolderOpen className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                      <div className="text-base font-bold leading-tight">{displayStats.openOnlyCount || 0}</div>
                      <div className="text-[9px] text-blue-100 uppercase font-medium">Open</div>
                    </div>
                  </div>
                )}

                {/* Pending - Daily only */}
                {viewMode === 'daily' && (
                  <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-opacity-20 transition-all">
                    <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-orange-500 bg-opacity-30 flex-none">
                      <Clock className="w-3.5 h-3.5 text-white" />
                    </div>
                    <div>
                      <div className="text-base font-bold leading-tight">{displayStats.pendingCount || 0}</div>
                      <div className="text-[9px] text-blue-100 uppercase font-medium">Pending</div>
                    </div>
                  </div>
                )}

                {/* Closed */}
                <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-opacity-20 transition-all">
                  <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-green-500 bg-opacity-30 flex-none">
                    <CheckSquare className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div>
                    <div className="text-base font-bold leading-tight">
                      {viewMode === 'monthly' ? (displayStats.monthClosed || 0) : viewMode === 'weekly' ? (displayStats.weeklyClosed || 0) : (displayStats.closedTicketsToday || 0)}
                    </div>
                    <div className="text-[9px] text-blue-100 uppercase font-medium">Closed</div>
                  </div>
                </div>

                {/* Self */}
                <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg px-2.5 py-1.5 flex items-center gap-1.5 hover:bg-opacity-20 transition-all">
                  <div className="flex items-center justify-center w-7 h-7 rounded-lg bg-purple-500 bg-opacity-30 flex-none">
                    <Hand className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div>
                    <div className="text-base font-bold leading-tight">
                      {viewMode === 'monthly' ? (displayStats.monthSelfPicked || 0) : viewMode === 'weekly' ? (displayStats.weeklySelfPicked || 0) : (displayStats.selfPickedToday || 0)}
                    </div>
                    <div className="text-[9px] text-blue-100 uppercase font-medium">Self</div>
                  </div>
                </div>
              </div>

              {/* Divider */}
              <div className="w-px h-10 bg-white bg-opacity-20 flex-none" />

              {/* Self-Pick Progress */}
              <div className="flex-none w-40">
                <div className="flex items-center justify-between mb-1">
                  <span className="text-xs font-semibold">Team Self-Pick</span>
                  <span className="text-xs font-bold">{selfPickPercentage}%</span>
                </div>
                <div className="w-full bg-blue-900 bg-opacity-30 rounded-full h-2 overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      selfPickPercentage >= 70 ? 'bg-green-400' :
                        selfPickPercentage >= 50 ? 'bg-yellow-400' :
                          'bg-red-400'
                    }`}
                    style={{ width: `${selfPickPercentage}%` }}
                  />
                </div>
                <div className="flex justify-between text-[10px] text-blue-200 mt-0.5">
                  <span>Goal: 70%</span>
                  {isToday && (
                    <span className="flex items-center gap-1">
                      <div className="w-2 h-2 rounded-full bg-green-500"></div>
                      <span>{displayStats.lightLoad || 0}</span>
                      <div className="w-2 h-2 rounded-full bg-yellow-500"></div>
                      <span>{displayStats.mediumLoad || 0}</span>
                      <div className="w-2 h-2 rounded-full bg-red-500"></div>
                      <span>{displayStats.heavyLoad || 0}</span>
                    </span>
                  )}
                </div>
              </div>

              {/* Divider */}
              <div className="w-px h-10 bg-white bg-opacity-20 flex-none" />

              {/* View Toggle - far right */}
              <div className="flex-none inline-flex items-center gap-1 bg-white bg-opacity-20 rounded-lg p-1">
                <button
                  onClick={handleSwitchToDaily}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'daily'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-white hover:bg-white hover:bg-opacity-10'
                  }`}
                >
                  Daily
                </button>
                <button
                  onClick={handleSwitchToWeekly}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'weekly'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-white hover:bg-white hover:bg-opacity-10'
                  }`}
                >
                  Weekly
                </button>
                <button
                  onClick={handleSwitchToMonthly}
                  className={`px-3 py-1 rounded text-xs font-medium transition-colors ${
                    viewMode === 'monthly'
                      ? 'bg-white text-blue-600 shadow-sm'
                      : 'text-white hover:bg-white hover:bg-opacity-10'
                  }`}
                >
                  Monthly
                </button>
              </div>
            </div>
          </div>
        </div>

        {/* Search and Filter Bar */}
        <div className="mb-4 flex items-start gap-3">
          <SearchBox
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search tickets... (use OR or | for alternatives)"
            resultsCount={searchTerm || selectedCategories.length > 0 ? searchResultsCount : null}
            className="flex-1 max-w-2xl"
          />
          <CategoryFilter
            categories={allCategories}
            selected={selectedCategories}
            onChange={setSelectedCategories}
            placeholder="Category"
          />
          {(searchTerm || selectedCategories.length > 0 || (viewMode === 'monthly' && monthlyData)) && (
            <button
              type="button"
              onClick={() => {
                setSearchTerm('');
                setSelectedCategories([]);
              }}
              className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors whitespace-nowrap"
              title="Clear all filters"
            >
              Clear All Filters
            </button>
          )}
        </div>

        {/* Technicians List - Cascading */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <div className="flex items-center gap-4">
              <div className="flex items-baseline gap-2">
                <h2 className="text-lg font-semibold">Technicians</h2>
                <span className="text-xs text-gray-500">
                  ({searchTerm || selectedCategories.length > 0 ? `${techsWithRanks.length} of ${stats.totalTechnicians || 0}` : `${stats.totalTechnicians || 0} active`})
                </span>
              </div>

              {/* View toggle — Card / Compact */}
              <div className="flex bg-gray-100 rounded-lg p-0.5 text-xs font-medium">
                <button
                  onClick={() => { if (isCompactView) toggleCompactView(); }}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                    !isCompactView ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                  }`}
                >
                  <LayoutGrid className="w-3.5 h-3.5" />
                  Cards
                </button>
                <button
                  onClick={() => { if (!isCompactView) toggleCompactView(); }}
                  className={`flex items-center gap-1.5 px-2.5 py-1 rounded-md transition-all ${
                    isCompactView ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-800'
                  }`}
                >
                  <List className="w-3.5 h-3.5" />
                  Compact
                </button>
              </div>

              <button
                onClick={handleToggleNoise}
                className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm transition-colors ${
                  excludeNoise
                    ? 'bg-amber-100 hover:bg-amber-200 text-amber-800 ring-1 ring-amber-300'
                    : 'bg-gray-100 hover:bg-gray-200 text-gray-600'
                }`}
                title={excludeNoise ? 'Noise tickets are hidden. Click to show all tickets.' : 'Click to hide automated/noise tickets (alerts, backups, monitoring, spam)'}
              >
                {excludeNoise ? <VolumeX className="w-4 h-4" /> : <Volume2 className="w-4 h-4" />}
                <span>{excludeNoise ? 'Noise Hidden' : 'Hide Noise'}</span>
              </button>
              {hiddenTechnicians.length > 0 && (
                <button
                  onClick={() => setShowHidden(!showHidden)}
                  className="flex items-center gap-2 px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors"
                >
                  {showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  <span>{hiddenTechnicians.length} Hidden</span>
                </button>
              )}
              {isCompactView && (
                <button
                  onClick={() => setExpandAllOverride(prev => prev === true ? null : true)}
                  className={`flex items-center gap-1.5 px-3 py-1 rounded-lg text-sm transition-colors ${
                    expandAllOverride === true
                      ? 'bg-blue-100 hover:bg-blue-200 text-blue-700'
                      : 'bg-gray-100 hover:bg-gray-200 text-gray-700'
                  }`}
                  title={expandAllOverride === true ? 'Collapse all ticket details' : 'Expand all ticket details'}
                >
                  {expandAllOverride === true ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
                  <span>{expandAllOverride === true ? 'Collapse All' : 'Expand All'}</span>
                </button>
              )}
            </div>
            <div className="text-xs text-gray-500">
              <span className="font-semibold">Legend:</span>
              {/* Only show "Open" metric when viewing today (current workload) */}
              {isToday && <span className="ml-2">Open = All Open Tickets</span>}
              <span className="ml-2 text-blue-600">Today = Total Today</span>
              <span className="ml-2 text-purple-600">Self = Self-Picked</span>
              <span className="ml-2 text-orange-600">Asgn = Assigned</span>
              <span className="ml-2 text-green-600">Done = Closed</span>
              <span className="ml-2 text-yellow-600">⭐ = CSAT</span>
            </div>
          </div>

          {/* Hidden Technicians Section */}
          {showHidden && hiddenTechnicians.length > 0 && (
            <div className="mb-6 bg-gray-50 border border-gray-200 rounded-lg p-4">
              <div className="flex items-center justify-between mb-3">
                <h3 className="text-sm font-semibold text-gray-700">Hidden Technicians</h3>
                <button
                  onClick={handleClearAllHidden}
                  className="text-xs text-blue-600 hover:text-blue-800 font-medium"
                >
                  Restore All
                </button>
              </div>
              <div className="space-y-2">
                {hiddenTechnicians.map((tech) => (
                  <div
                    key={tech.id}
                    className="flex items-center justify-between bg-white p-3 rounded border border-gray-200"
                  >
                    <span className="text-sm text-gray-700">{tech.name}</span>
                    <button
                      onClick={() => handleRestoreTechnician(tech.id)}
                      className="flex items-center gap-1 px-3 py-1 bg-blue-50 hover:bg-blue-100 text-blue-600 rounded text-xs font-medium transition-colors"
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
                selectedCategories={selectedCategories}
                onClearSelections={() => {
                  // This will be handled by the useEffect in MonthlyCalendar
                }}
              />
            </div>
          ) : techsWithRanks.length === 0 ? (
            /* No technicians found (daily/weekly only) */
            <div className="bg-white rounded-lg shadow-sm p-8 text-center border border-gray-200">
              <Users className="w-12 h-12 text-gray-400 mx-auto mb-3" />
              <p className="text-gray-600">
                {searchTerm || selectedCategories.length > 0 ? 'No matching tickets found' : 'No technicians found'}
              </p>
              <p className="text-sm text-gray-500 mt-2">
                {searchTerm || selectedCategories.length > 0
                  ? 'Try adjusting your search or filters'
                  : technicians.length > 0
                    ? 'All technicians are hidden. Click "Show Hidden" to restore them.'
                    : 'Sync with FreshService to see technicians'}
              </p>
              {(searchTerm || selectedCategories.length > 0) && (
                <div className="flex gap-2 justify-center mt-4">
                  {searchTerm && (
                    <button
                      onClick={() => setSearchTerm('')}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      Clear Search
                    </button>
                  )}
                  {selectedCategories.length > 0 && (
                    <button
                      onClick={() => setSelectedCategories([])}
                      className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg text-sm font-medium transition-colors"
                    >
                      Clear Filters
                    </button>
                  )}
                </div>
              )}
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

                return isCompactView ? (
                  /* Compact view - One row per technician */
                  <div className="space-y-2 animate-fadeIn">
                    {techsWithRanks.map((tech, index) => (
                      <div
                        key={tech.id}
                        className="animate-slideInLeft"
                        style={{ animationDelay: `${index * 30}ms` }}
                      >
                        <TechCardCompact
                          technician={tech}
                          rank={tech.rank}
                          onHide={handleHideTechnician}
                          selectedDate={selectedDate}
                          selectedWeek={selectedWeek}
                          maxOpenCount={maxOpenCount}
                          maxDailyCount={maxDailyCount}
                          viewMode={viewMode}
                          searchTerm={searchTerm}
                          selectedCategories={selectedCategories}
                          forceExpand={expandAllOverride}
                        />
                      </div>
                    ))}
                  </div>
                ) : (
                  /* Normal view - Grid layout with cards */
                  <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-4 gap-4 animate-fadeIn">
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
                          maxOpenCount={maxOpenCount}
                          maxDailyCount={maxDailyCount}
                          viewMode={viewMode}
                          searchTerm={searchTerm}
                          selectedCategories={selectedCategories}
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

      <ChangelogModal isOpen={showChangelog} onClose={() => setShowChangelog(false)} />
    </div>
  );
}
