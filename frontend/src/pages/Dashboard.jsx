import React, { useEffect, useState, useCallback } from 'react';
import { useNavigate, useLocation } from 'react-router-dom';
import { useDashboard } from '../contexts/DashboardContext';
import { useAuth } from '../contexts/AuthContext';
import { syncAPI, dashboardAPI } from '../services/api';
import TechCard from '../components/TechCard';
import TechCardCompact from '../components/TechCardCompact';
import StatCard from '../components/StatCard';
import SearchBox from '../components/SearchBox';
import CategoryFilter from '../components/CategoryFilter';
import {
  Users,
  Ticket,
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
  Send,
  CheckSquare,
  Clock,
  Construction
} from 'lucide-react';

export default function Dashboard() {
  const {
    dashboardData,
    isLoading,
    error,
    lastUpdated,
    sseConnected,
    fetchDashboard
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
    const stored = sessionStorage.getItem('dashboard_search');
    return stored || '';
  });

  // Category filter state - persisted in sessionStorage
  const [selectedCategories, setSelectedCategories] = useState(() => {
    const stored = sessionStorage.getItem('dashboard_categories');
    return stored ? JSON.parse(stored) : [];
  });

  // Compact view state - persisted in localStorage
  const [isCompactView, setIsCompactView] = useState(() => {
    const stored = localStorage.getItem('compactView');
    return stored ? JSON.parse(stored) : false;
  });

  // Collapsible sections state - persisted in localStorage
  const [collapsedSections, setCollapsedSections] = useState(() => {
    const stored = localStorage.getItem('collapsedSections');
    return stored ? JSON.parse(stored) : { light: true }; // Light load collapsed by default
  });

  // Weekly stats for daily ticket counts
  const [weeklyStats, setWeeklyStats] = useState(null);

  // Weekly dashboard data
  const [weeklyData, setWeeklyData] = useState(null);
  const [isLoadingWeekly, setIsLoadingWeekly] = useState(false);

  // Daily/Weekly view toggle state - restore from localStorage or navigation state
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

    // Priority 3: Default to daily
    return 'daily';
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

  // Persist selectedDate to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardSelectedDate', selectedDate.toISOString());
  }, [selectedDate]);

  // Persist selectedWeek to localStorage whenever it changes
  useEffect(() => {
    localStorage.setItem('dashboardSelectedWeek', selectedWeek.toISOString());
  }, [selectedWeek]);

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

  // Fetch dashboard data on mount and when date changes
  useEffect(() => {
    const dateStr = formatDateLocal(selectedDate);
    const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
    fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
  }, [selectedDate, fetchDashboard, formatDateLocal]);

  // Fetch weekly stats when selected date or week changes
  useEffect(() => {
    const fetchWeeklyStats = async () => {
      try {
        // Use selectedWeek for weekly view, selectedDate for daily view
        const dateToUse = viewMode === 'weekly' ? selectedWeek : selectedDate;
        const dateStr = formatDateLocal(dateToUse);
        const response = await dashboardAPI.getWeeklyStats('America/Los_Angeles', dateStr);
        setWeeklyStats(response.data.dailyCounts);
      } catch (error) {
        console.error('Failed to fetch weekly stats:', error);
        setWeeklyStats(null);
      }
    };
    fetchWeeklyStats();
  }, [selectedDate, selectedWeek, viewMode, formatDateLocal]);

  // Fetch weekly dashboard data when in weekly mode or selectedWeek changes
  useEffect(() => {
    if (viewMode !== 'weekly') return;

    const fetchWeeklyDashboard = async () => {
      try {
        setIsLoadingWeekly(true);
        const weekStartStr = formatDateLocal(selectedWeek);
        const response = await dashboardAPI.getWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
        setWeeklyData(response.data);
      } catch (error) {
        console.error('Failed to fetch weekly dashboard:', error);
        setWeeklyData(null);
      } finally {
        setIsLoadingWeekly(false);
      }
    };

    fetchWeeklyDashboard();
  }, [viewMode, selectedWeek, formatDateLocal]);

  // Poll for background sync status every 5 seconds
  useEffect(() => {
    const checkBackgroundSync = async () => {
      try {
        const status = await syncAPI.getStatus();
        const isRunning = status.data?.sync?.isRunning || false;
        setBackgroundSyncRunning(isRunning);
      } catch (err) {
        // Ignore errors, sync status is not critical
      }
    };

    // Check immediately
    checkBackgroundSync();

    // Then check every 5 seconds
    const interval = setInterval(checkBackgroundSync, 5000);

    return () => clearInterval(interval);
  }, []);

  const addSyncLog = (message, type = 'info') => {
    const timestamp = new Date().toLocaleTimeString();
    setSyncLogs(prev => [...prev, { timestamp, message, type }]);
  };

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
          addSyncLog(`Checking sync status... (${attempts * 2}s elapsed)`, 'info');

          if (!statusCheck.data?.sync?.isRunning) {
            addSyncLog('Background sync completed!', 'success');

            // Get the latest sync result
            const finalResult = await syncAPI.getStatus();
            const latestSync = finalResult.data?.latestSync;

            if (latestSync?.status === 'completed') {
              addSyncLog(`✓ Synced technicians and tickets`, 'success');
              addSyncLog(`✓ Total records: ${latestSync.recordsProcessed || 0}`, 'success');

              setSyncStatus('success');
              setSyncMessage('Background sync completed successfully!');

              // Refresh dashboard - use appropriate fetch based on view mode
              addSyncLog('Refreshing dashboard data...', 'info');
              if (viewMode === 'weekly') {
                const weekStartStr = formatDateLocal(selectedWeek);
                const weekResponse = await dashboardAPI.getWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
                setWeeklyData(weekResponse.data);
              } else {
                const dateStr = selectedDate.toISOString().split('T')[0];
                const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
                await fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
              }
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

        // Refresh the dashboard data - use appropriate fetch based on view mode
        console.log('[SYNC] Refreshing dashboard data...');
        addSyncLog('Refreshing dashboard data...', 'info');
        if (viewMode === 'weekly') {
          const weekStartStr = formatDateLocal(selectedWeek);
          const weekResponse = await dashboardAPI.getWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
          setWeeklyData(weekResponse.data);
        } else {
          const dateStr = formatDateLocal(selectedDate);
          const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
          await fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
        }
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

        // Refresh dashboard - use appropriate fetch based on view mode
        if (viewMode === 'weekly') {
          const weekStartStr = formatDateLocal(selectedWeek);
          const weekResponse = await dashboardAPI.getWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
          setWeeklyData(weekResponse.data);
        } else {
          await fetchDashboard('America/Los_Angeles', formatDateLocal(selectedDate));
        }

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
        addSyncLog('The sync operation took longer than expected (>2 minutes)', 'error');
        addSyncLog('This might indicate a large amount of data or slow network', 'warn');
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
  }, [selectedDate, selectedWeek, viewMode, fetchDashboard, formatDateLocal, setWeeklyData]);

  const handleSyncWeek = useCallback(async () => {
    console.log('[SYNC WEEK] Starting week sync process...');
    setSyncLogs([]); // Clear previous logs
    setShowSyncDetails(true); // Auto-show details panel
    addSyncLog('Starting week sync process...', 'info');

    try {
      setRefreshing(true);
      setSyncStatus('syncing');

      // Calculate Monday of the selected week
      const currentDay = (selectedDate.getDay() + 6) % 7; // Convert to Monday=0, ..., Sunday=6
      const monday = new Date(selectedDate);
      monday.setDate(selectedDate.getDate() - currentDay);
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

      const response = await syncAPI.syncWeek({
        startDate: formatDateLocal(monday),
        endDate: formatDateLocal(sunday)
      });

      const duration = ((Date.now() - startTime) / 1000).toFixed(1);

      if (response.success) {
        addSyncLog(`✓ Week sync completed in ${duration}s`, 'success');
        addSyncLog(`✓ Tickets synced: ${response.data.ticketsSynced || 0}`, 'success');
        addSyncLog(`✓ Activities analyzed: ${response.data.activitiesAnalyzed || 0}`, 'success');
        addSyncLog(`✓ Pickup times backfilled: ${response.data.pickupTimesBackfilled || 0}`, 'success');

        setSyncStatus('success');
        setSyncMessage(`Week sync completed! ${response.data.ticketsSynced || 0} tickets synced.`);

        // Refresh dashboard - use appropriate fetch based on view mode
        addSyncLog('Refreshing dashboard data...', 'info');
        if (viewMode === 'weekly') {
          const weekStartStr = formatDateLocal(selectedWeek);
          const weekResponse = await dashboardAPI.getWeeklyDashboard(weekStartStr, 'America/Los_Angeles');
          setWeeklyData(weekResponse.data);
        } else {
          const dateStr = formatDateLocal(selectedDate);
          const isCurrentDay = selectedDate.toDateString() === new Date().toDateString();
          await fetchDashboard('America/Los_Angeles', isCurrentDay ? null : dateStr);
        }
        addSyncLog('Dashboard data refreshed', 'success');

        setTimeout(() => {
          setSyncStatus(null);
          setRefreshing(false);
        }, 5000);
      } else {
        throw new Error(response.message || 'Week sync failed');
      }

    } catch (err) {
      console.error('[SYNC WEEK] Error during week sync:', err);
      addSyncLog(`✗ Error: ${err.message}`, 'error');

      setSyncStatus('error');
      setSyncMessage('Failed to sync week: ' + err.message);
      setTimeout(() => {
        setSyncStatus(null);
        setRefreshing(false);
      }, 5000);
    }
  }, [selectedDate, selectedWeek, viewMode, fetchDashboard, formatDateLocal, setWeeklyData]);

  const handleLogout = async () => {
    await logout();
    navigate('/login');
  };

  const handleSettings = () => {
    navigate('/settings');
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
            onClick={handleRefresh}
            className="mt-4 w-full bg-red-600 hover:bg-red-700 text-white py-2 rounded-lg"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // Use weekly data when in weekly mode, otherwise use daily data
  const stats = viewMode === 'weekly'
    ? (weeklyData?.statistics || {})
    : (dashboardData?.statistics || {});
  const technicians = viewMode === 'weekly'
    ? (weeklyData?.technicians || [])
    : (dashboardData?.technicians || []);

  // Filter technicians based on hidden state
  const visibleTechnicians = technicians.filter(tech => !hiddenTechIds.includes(tech.id));
  const hiddenTechnicians = technicians.filter(tech => hiddenTechIds.includes(tech.id));

  // Helper function to get tickets array from tech (handles both daily and weekly views)
  const getTechTickets = (tech) => {
    // Explicitly prioritize based on what exists (not truthiness)
    // This is important because empty arrays are truthy
    if (tech.weeklyTickets !== undefined) return tech.weeklyTickets;
    if (tech.tickets !== undefined) return tech.tickets;
    return [];
  };

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

  // Apply search filter to visible technicians
  const searchedTechnicians = searchTerm
    ? visibleTechnicians.map(tech => {
        // Filter tickets by search term
        const techTickets = getTechTickets(tech);
        const matchingTickets = techTickets.filter(ticket => {
          const searchLower = searchTerm.toLowerCase();
          const subjectMatch = ticket.subject?.toLowerCase().includes(searchLower);
          const ticketIdMatch = ticket.freshserviceTicketId?.toString().includes(searchTerm);
          const requesterMatch = ticket.requesterName?.toLowerCase().includes(searchLower);
          return subjectMatch || ticketIdMatch || requesterMatch;
        });

        // Recalculate stats based on filtered tickets
        const recalculatedStats = recalculateTechStats(tech, matchingTickets);

        // Update the appropriate field based on view mode
        const updatedTech = {
          ...tech,
          ...recalculatedStats, // Overwrite stats with recalculated values
          // Preserve original ticket counts for display
          originalTicketCount: techTickets.length || 0,
          matchingTicketCount: matchingTickets.length
        };

        // Set the correct field based on what was originally present
        // Use !== undefined to check for existence, not truthiness (empty arrays are truthy)
        if (tech.weeklyTickets !== undefined) {
          updatedTech.weeklyTickets = matchingTickets;
          delete updatedTech.tickets; // Clear daily tickets to prevent stale data
        } else {
          updatedTech.tickets = matchingTickets;
          delete updatedTech.weeklyTickets; // Clear weekly tickets to prevent stale data
        }

        return updatedTech;
      }).filter(tech => tech.matchingTicketCount > 0)
    : visibleTechnicians;

  // Apply category filter after search
  const filteredTechnicians = selectedCategories.length > 0
    ? searchedTechnicians.map(tech => {
        // Filter tickets by selected categories
        const techTickets = getTechTickets(tech);
        const matchingTickets = techTickets.filter(ticket =>
          selectedCategories.includes(ticket.ticketCategory)
        );

        // Recalculate stats based on filtered tickets
        const recalculatedStats = recalculateTechStats(tech, matchingTickets);

        // Update the appropriate field based on view mode
        const updatedTech = {
          ...tech,
          ...recalculatedStats, // Overwrite stats with recalculated values
          originalTicketCount: tech.originalTicketCount || techTickets.length || 0,
          matchingTicketCount: matchingTickets.length
        };

        // Set the correct field based on what was originally present
        if (tech.weeklyTickets !== undefined) {
          updatedTech.weeklyTickets = matchingTickets;
          delete updatedTech.tickets; // Clear daily tickets to prevent stale data
        } else {
          updatedTech.tickets = matchingTickets;
          delete updatedTech.weeklyTickets; // Clear weekly tickets to prevent stale data
        }

        return updatedTech;
      }).filter(tech => tech.matchingTicketCount > 0)
    : searchedTechnicians;

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

      // Load level counts (only meaningful in daily view with current open tickets)
      lightLoad: filteredTechnicians.filter(t => t.loadLevel === 'light').length,
      mediumLoad: filteredTechnicians.filter(t => t.loadLevel === 'medium').length,
      heavyLoad: filteredTechnicians.filter(t => t.loadLevel === 'heavy').length,
    };

    return filteredStats;
  })() : stats;

  // Format selected date in a friendly format
  const dateOptions = { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' };
  const formattedDate = selectedDate.toLocaleDateString('en-US', dateOptions);

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
  const toggleSection = (section) => {
    const newCollapsedSections = {
      ...collapsedSections,
      [section]: !collapsedSections[section]
    };
    setCollapsedSections(newCollapsedSections);
    localStorage.setItem('collapsedSections', JSON.stringify(newCollapsedSections));
  };

  // Calculate rankings based on self-picked today (only for visible/searched/filtered techs)
  const techsWithRanks = [...filteredTechnicians]
    .sort((a, b) => b.selfPickedToday - a.selfPickedToday)
    .map((tech, index) => ({
      ...tech,
      rank: tech.selfPickedToday > 0 ? index + 1 : null
    }));

  // Group technicians by load level (only when viewing today)
  const techsByLoadLevel = {
    heavy: techsWithRanks.filter(t => t.loadLevel === 'heavy'),
    medium: techsWithRanks.filter(t => t.loadLevel === 'medium'),
    light: techsWithRanks.filter(t => t.loadLevel === 'light')
  };

  // Calculate team self-pick percentage
  const totalTicketsToday = viewMode === 'weekly'
    ? (displayStats.weeklyTotalCreated || 0)
    : (displayStats.totalTicketsToday || 0);
  const selfPickedToday = viewMode === 'weekly'
    ? (displayStats.weeklySelfPicked || 0)
    : (displayStats.selfPickedToday || 0);
  const selfPickPercentage = totalTicketsToday > 0
    ? Math.round((selfPickedToday / totalTicketsToday) * 100)
    : 0;

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Compact Header - Single Row Grid */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-7xl mx-auto px-4 py-2">
          <div className="grid grid-cols-12 gap-4 items-center">
            {/* Left: Title + User - 3 cols */}
            <div className="col-span-3">
              <h1 className="text-lg font-bold text-gray-800">Ticket Pulse Dashboard</h1>
              <p className="text-xs text-gray-600">Welcome, {user?.username}</p>
            </div>

            {/* Center: Status + Last Updated - 6 cols */}
            <div className="col-span-6 flex items-center justify-center gap-4">
              {/* SSE Status */}
              <div className="flex items-center gap-1.5 text-xs">
                {sseConnected ? (
                  <>
                    <Wifi className="w-3.5 h-3.5 text-green-600" />
                    <span className="text-green-600 font-medium">Live</span>
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
                <div className="flex items-center gap-1.5 text-xs text-blue-600 bg-blue-50 px-2 py-1 rounded-full border border-blue-200">
                  <RefreshCw className="w-3 h-3 animate-spin" />
                  <span className="font-medium">Syncing...</span>
                </div>
              )}

              {/* Last Updated */}
              {lastUpdated && (
                <span className="text-xs text-gray-500">
                  Updated: {new Date(lastUpdated).toLocaleTimeString()}
                </span>
              )}
            </div>

            {/* Right: Action Buttons - 3 cols */}
            <div className="col-span-3 flex items-center justify-end gap-2">
              {/* Compact View Toggle */}
              <button
                onClick={toggleCompactView}
                className={`p-1.5 rounded transition-colors ${
                  isCompactView ? 'bg-blue-50 text-blue-600' : 'hover:bg-gray-100'
                }`}
                title={isCompactView ? 'Normal View' : 'Compact View'}
              >
                {isCompactView ? (
                  <Maximize2 className="w-4 h-4" />
                ) : (
                  <Minimize2 className="w-4 h-4" />
                )}
              </button>

              {/* Sync Week Button */}
              <button
                onClick={handleSyncWeek}
                disabled={refreshing || backgroundSyncRunning}
                className={`px-2 py-1 text-xs font-medium rounded transition-colors border ${
                  refreshing || backgroundSyncRunning
                    ? 'opacity-50 cursor-not-allowed border-gray-300'
                    : 'hover:bg-blue-50 hover:border-blue-300 border-gray-300'
                }`}
                title="Sync current week (Monday-Sunday) with full details"
              >
                <span>Sync Week</span>
              </button>

              {/* Refresh Button */}
              <button
                onClick={handleRefresh}
                disabled={refreshing || backgroundSyncRunning}
                className={`p-1.5 rounded transition-colors ${
                  refreshing || backgroundSyncRunning
                    ? 'opacity-50 cursor-not-allowed'
                    : 'hover:bg-gray-100'
                }`}
                title={backgroundSyncRunning ? 'Syncing...' : refreshing ? 'Syncing...' : 'Sync All'}
              >
                <RefreshCw className={`w-4 h-4 ${refreshing || backgroundSyncRunning ? 'animate-spin text-blue-600' : ''}`} />
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
        {/* Compact Single Row: Date + Stats + Self-Pick Rate */}
        <div className="bg-gradient-to-r from-blue-600 to-purple-600 rounded-lg shadow-lg p-3 mb-4">
          <div className="grid grid-cols-12 gap-4 items-center text-white">
            {/* Date Navigation + Day of Week - 3 cols */}
            <div className="col-span-3">
              {/* Daily/Weekly/Monthly Toggle */}
              <div className="inline-flex items-center gap-1 bg-white bg-opacity-20 rounded-lg p-1 mb-2">
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
                  disabled
                  className="px-2 py-1 rounded text-xs font-medium text-white opacity-40 cursor-not-allowed flex items-center gap-1"
                  title="Under Construction"
                >
                  <Construction className="w-3 h-3" />
                  Monthly
                </button>
              </div>
              {/* Navigation Controls */}
              <div className="flex items-center gap-2 mb-2">
                <button
                  onClick={viewMode === 'daily' ? goToPreviousDay : goToPreviousWeek}
                  className="p-1.5 hover:bg-white hover:bg-opacity-20 rounded transition-colors"
                  title={viewMode === 'daily' ? 'Previous day' : 'Previous week'}
                >
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <div className="flex items-center gap-1.5 flex-1">
                  <Calendar className="w-4 h-4" />
                  {viewMode === 'daily' ? (
                    <input
                      type="date"
                      value={formatDateLocal(selectedDate)}
                      onChange={(e) => setSelectedDate(new Date(e.target.value + 'T12:00:00'))}
                      className="bg-white bg-opacity-20 border border-white border-opacity-30 rounded px-2 py-1 text-white text-xs focus:outline-none focus:ring-1 focus:ring-white w-full"
                    />
                  ) : (
                    <div className="bg-white bg-opacity-20 border border-white border-opacity-30 rounded px-2 py-1 text-white text-xs w-full text-center">
                      {(() => {
                        const weekEnd = new Date(selectedWeek);
                        weekEnd.setDate(selectedWeek.getDate() + 6);
                        return `${selectedWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`;
                      })()}
                    </div>
                  )}
                </div>
                <button
                  onClick={viewMode === 'daily' ? goToNextDay : goToNextWeek}
                  disabled={viewMode === 'daily' && isToday}
                  className={`p-1.5 rounded transition-colors ${
                    (viewMode === 'daily' && isToday) ? 'opacity-50 cursor-not-allowed' : 'hover:bg-white hover:bg-opacity-20'
                  }`}
                  title={viewMode === 'daily' ? 'Next day' : 'Next week'}
                >
                  <ChevronRight className="w-4 h-4" />
                </button>
                {!isToday && viewMode === 'daily' && (
                  <button
                    onClick={goToToday}
                    className="px-2 py-1 bg-white bg-opacity-20 hover:bg-opacity-30 rounded text-xs font-semibold transition-colors"
                  >
                    Today
                  </button>
                )}
                {viewMode === 'weekly' && (
                  <button
                    onClick={goToCurrentWeek}
                    className="px-2 py-1 bg-white bg-opacity-20 hover:bg-opacity-30 rounded text-xs font-semibold transition-colors"
                  >
                    This Week
                  </button>
                )}
              </div>

              {/* Day of Week Indicator - Clickable (Monday to Sunday) */}
              <div className="flex justify-center gap-1">
                {['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((day, index) => {
                  // Adjust for Monday start: Mon=0, Tue=1, ..., Sun=6
                  const currentDay = (selectedDate.getDay() + 6) % 7; // Convert Sun=0 to Sun=6, Mon=1 to Mon=0, etc.
                  const isCurrentDay = index === currentDay;

                  // Get ticket count for this day
                  const dayStats = weeklyStats?.[index];
                  const ticketCount = dayStats?.count ?? null;

                  // Calculate trend (compare to previous day)
                  let trendIcon = null;
                  let trendColor = '';
                  if (weeklyStats && index > 0) {
                    const prevDayCount = weeklyStats[index - 1]?.count ?? 0;
                    const currentCount = ticketCount ?? 0;
                    if (currentCount > prevDayCount) {
                      trendIcon = <TrendingUp className="w-2.5 h-2.5" />;
                      trendColor = 'text-red-400'; // More tickets = red (bad)
                    } else if (currentCount < prevDayCount) {
                      trendIcon = <TrendingDown className="w-2.5 h-2.5" />;
                      trendColor = 'text-green-400'; // Fewer tickets = green (good)
                    } else if (currentCount === prevDayCount && currentCount > 0) {
                      trendIcon = <Minus className="w-2.5 h-2.5" />;
                      trendColor = 'text-gray-400'; // Same = gray (neutral)
                    }
                  }

                  // Calculate the date for this day of the week
                  const handleDayClick = () => {
                    // Only allow clicking in daily view, not weekly view
                    if (viewMode === 'weekly') return;

                    const dayDifference = index - currentDay;
                    const newDate = new Date(selectedDate);
                    newDate.setDate(newDate.getDate() + dayDifference);
                    setSelectedDate(newDate);
                  };

                  return (
                    <button
                      key={day}
                      onClick={handleDayClick}
                      disabled={viewMode === 'weekly'}
                      className={`text-[10px] font-semibold px-1.5 py-0.5 rounded transition-all flex flex-col items-center ${
                        isCurrentDay
                          ? 'bg-white text-blue-600 shadow-md scale-110'
                          : viewMode === 'weekly'
                          ? 'text-blue-100 opacity-60 cursor-default'
                          : 'text-blue-100 opacity-60 hover:opacity-100 hover:bg-white hover:bg-opacity-20 cursor-pointer'
                      }`}
                      title={`${day}${ticketCount !== null ? ` - ${ticketCount} tickets` : ''}`}
                    >
                      <span>{day}</span>
                      {ticketCount !== null && (
                        <div className="flex items-center gap-0.5 mt-0.5">
                          <span className="text-[9px] font-bold">{ticketCount}</span>
                          {trendIcon && (
                            <span className={trendColor}>
                              {trendIcon}
                            </span>
                          )}
                        </div>
                      )}
                    </button>
                  );
                })}
              </div>
            </div>

            {/* Stats Cards - 6 cols */}
            <div className="col-span-6 grid grid-cols-5 gap-2">
              {/* Tickets for Selected Date/Week */}
              <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg p-2 flex items-center gap-2 hover:bg-opacity-20 transition-all">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-blue-400 bg-opacity-30">
                  <Inbox className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-lg font-bold">
                    {viewMode === 'weekly' ? (displayStats.weeklyTotalCreated || 0) : (displayStats.totalTicketsToday || 0)}
                  </div>
                  <div className="text-[9px] text-blue-100 uppercase font-medium leading-tight">
                    <div>Total</div>
                    <div className="text-[8px] opacity-80">
                      {viewMode === 'weekly'
                        ? `${(() => {
                            const weekEnd = new Date(selectedWeek);
                            weekEnd.setDate(selectedWeek.getDate() + 6);
                            return `${selectedWeek.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} - ${weekEnd.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`;
                          })()}`
                        : selectedDate.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                      }
                    </div>
                  </div>
                </div>
              </div>
              {/* Open Tickets (current snapshot) - Only show in daily view */}
              {viewMode === 'daily' && (
                <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg p-2 flex items-center gap-2 hover:bg-opacity-20 transition-all">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-yellow-500 bg-opacity-30">
                    <FolderOpen className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <div className="text-lg font-bold">
                      {displayStats.openOnlyCount || 0}
                    </div>
                    <div className="text-[9px] text-blue-100 uppercase font-medium">Open</div>
                  </div>
                </div>
              )}
              {/* Pending Tickets (current snapshot) - Only show in daily view */}
              {viewMode === 'daily' && (
                <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg p-2 flex items-center gap-2 hover:bg-opacity-20 transition-all">
                  <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-orange-500 bg-opacity-30">
                    <Clock className="w-4 h-4 text-white" />
                  </div>
                  <div>
                    <div className="text-lg font-bold">
                      {displayStats.pendingCount || 0}
                    </div>
                    <div className="text-[9px] text-blue-100 uppercase font-medium">Pending</div>
                  </div>
                </div>
              )}
              {/* Closed Today/Week */}
              <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg p-2 flex items-center gap-2 hover:bg-opacity-20 transition-all">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-green-500 bg-opacity-30">
                  <CheckSquare className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-lg font-bold">
                    {viewMode === 'weekly' ? (displayStats.weeklyClosed || 0) : (displayStats.closedTicketsToday || 0)}
                  </div>
                  <div className="text-[9px] text-blue-100 uppercase font-medium">Closed</div>
                </div>
              </div>
              {/* Self-Picked Today/Week */}
              <div className="bg-white bg-opacity-10 backdrop-blur-sm rounded-lg p-2 flex items-center gap-2 hover:bg-opacity-20 transition-all">
                <div className="flex items-center justify-center w-8 h-8 rounded-lg bg-purple-500 bg-opacity-30">
                  <Hand className="w-4 h-4 text-white" />
                </div>
                <div>
                  <div className="text-lg font-bold">
                    {viewMode === 'weekly' ? (displayStats.weeklySelfPicked || 0) : (displayStats.selfPickedToday || 0)}
                  </div>
                  <div className="text-[9px] text-blue-100 uppercase font-medium">Self</div>
                </div>
              </div>
            </div>

            {/* Self-Pick Progress - 3 cols */}
            <div className="col-span-3">
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
          </div>
        </div>

        {/* Search and Filter Bar */}
        <div className="mb-4 flex items-start gap-3">
          <SearchBox
            value={searchTerm}
            onChange={setSearchTerm}
            placeholder="Search tickets by subject, ID, or requester..."
            resultsCount={searchTerm || selectedCategories.length > 0 ? searchResultsCount : null}
            className="flex-1 max-w-2xl"
          />
          <CategoryFilter
            categories={allCategories}
            selected={selectedCategories}
            onChange={setSelectedCategories}
            placeholder="Category"
          />
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
              {hiddenTechnicians.length > 0 && (
                <button
                  onClick={() => setShowHidden(!showHidden)}
                  className="flex items-center gap-2 px-3 py-1 bg-gray-100 hover:bg-gray-200 rounded-lg text-sm transition-colors"
                >
                  {showHidden ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  <span>{hiddenTechnicians.length} Hidden</span>
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
          {techsWithRanks.length === 0 ? (
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
            /* Grid or List layout based on view mode */
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
    </div>
  );
}
