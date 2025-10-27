import { createContext, useContext, useState, useCallback } from 'react';
import { settingsAPI } from '../services/api';

const SettingsContext = createContext(null);

export function SettingsProvider({ children }) {
  const [settings, setSettings] = useState(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState(null);

  // Fetch all settings
  const fetchSettings = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await settingsAPI.getAll();

      if (response.success && response.data) {
        setSettings(response.data);
      } else {
        throw new Error('Failed to fetch settings');
      }
    } catch (err) {
      console.error('Settings fetch error:', err);
      setError(err.message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Update settings
  const updateSettings = async (newSettings) => {
    try {
      setIsLoading(true);
      setError(null);

      const response = await settingsAPI.update(newSettings);

      if (response.success) {
        // Refresh settings after update
        await fetchSettings();
        return { success: true };
      } else {
        throw new Error('Failed to update settings');
      }
    } catch (err) {
      console.error('Settings update error:', err);
      setError(err.message);
      return { success: false, error: err.message };
    } finally {
      setIsLoading(false);
    }
  };

  // Update single setting
  const updateSetting = async (key, value) => {
    try {
      setError(null);

      const response = await settingsAPI.updateSingle(key, value);

      if (response.success) {
        // Update local state
        setSettings(prev => ({ ...prev, [key]: value }));
        return { success: true };
      } else {
        throw new Error('Failed to update setting');
      }
    } catch (err) {
      console.error('Setting update error:', err);
      setError(err.message);
      return { success: false, error: err.message };
    }
  };

  // Test FreshService connection
  const testConnection = async () => {
    try {
      setError(null);
      const response = await settingsAPI.testConnection();
      return response;
    } catch (err) {
      console.error('Connection test error:', err);
      setError(err.message);
      return { success: false, connected: false, message: err.message };
    }
  };

  // Initialize default settings
  const initializeDefaults = async () => {
    try {
      setError(null);
      const response = await settingsAPI.initialize();

      if (response.success) {
        await fetchSettings();
        return { success: true };
      } else {
        throw new Error('Failed to initialize settings');
      }
    } catch (err) {
      console.error('Initialize settings error:', err);
      setError(err.message);
      return { success: false, error: err.message };
    }
  };

  const value = {
    settings,
    isLoading,
    error,
    fetchSettings,
    updateSettings,
    updateSetting,
    testConnection,
    initializeDefaults,
  };

  return (
    <SettingsContext.Provider value={value}>
      {children}
    </SettingsContext.Provider>
  );
}

export function useSettings() {
  const context = useContext(SettingsContext);
  if (!context) {
    throw new Error('useSettings must be used within a SettingsProvider');
  }
  return context;
}
