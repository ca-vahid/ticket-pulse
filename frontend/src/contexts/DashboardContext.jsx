import { createContext, useContext, useState, useCallback } from 'react';
import { dashboardAPI } from '../services/api';
import { useSSE } from '../hooks/useSSE';

const DashboardContext = createContext(null);

export function DashboardProvider({ children }) {
  const [dashboardData, setDashboardData] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);
  const [lastUpdated, setLastUpdated] = useState(null);
  const [autoRefresh, setAutoRefresh] = useState(true);

  // Fetch dashboard data
  const fetchDashboard = useCallback(async (timezone = 'America/Los_Angeles', date = null) => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await dashboardAPI.getDashboard(timezone, date);

      if (response.success && response.data) {
        setDashboardData(response.data);
        setLastUpdated(new Date(response.data.timestamp));
      } else {
        throw new Error('Failed to fetch dashboard data');
      }
    } catch (err) {
      console.error('Dashboard fetch error:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Memoize SSE callbacks to prevent reconnection loops
  const handleSyncCompleted = useCallback((data) => {
    console.log('Sync completed, refreshing dashboard:', data);
    fetchDashboard();
  }, [fetchDashboard]);

  const handleConnected = useCallback(() => {
    console.log('SSE connected');
  }, []);

  const handleError = useCallback((error) => {
    console.error('SSE error:', error);
  }, []);

  // SSE connection for real-time updates
  const { isConnected: sseConnected } = useSSE({
    enabled: autoRefresh,
    onSyncCompleted: handleSyncCompleted,
    onConnected: handleConnected,
    onError: handleError,
  });

  // Get technician by ID - memoized to prevent infinite loops in consuming components
  const getTechnician = useCallback(async (id, timezone = 'America/Los_Angeles', date = null) => {
    try {
      const response = await dashboardAPI.getTechnician(id, timezone, date);

      if (response.success && response.data) {
        return response.data;
      } else {
        throw new Error('Failed to fetch technician data');
      }
    } catch (err) {
      console.error('Technician fetch error:', err);
      throw err;
    }
  }, []);

  const value = {
    dashboardData,
    isLoading,
    error,
    lastUpdated,
    autoRefresh,
    sseConnected,
    setAutoRefresh,
    fetchDashboard,
    getTechnician,
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
