import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../contexts/SettingsContext';
import { syncAPI } from '../services/api';
import axios from 'axios';
import {
  ArrowLeft,
  Save,
  TestTube,
  RefreshCw,
  CheckCircle,
  XCircle,
  Activity,
  Users
} from 'lucide-react';

export default function Settings() {
  const navigate = useNavigate();
  const { settings, isLoading, fetchSettings, updateSettings, testConnection } = useSettings();

  const [formData, setFormData] = useState({
    freshservice_domain: '',
    freshservice_api_key: '',
    sync_interval_minutes: 5,
    default_timezone: 'America/Los_Angeles',
    dashboard_refresh_seconds: 30,
  });

  const [testStatus, setTestStatus] = useState(null);
  const [saveStatus, setSaveStatus] = useState(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [syncStatus, setSyncStatus] = useState(null);
  const [photoSyncStatus, setPhotoSyncStatus] = useState(null);
  const [isPhotoSyncing, setIsPhotoSyncing] = useState(false);
  const [photoStatus, setPhotoStatus] = useState(null);

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (settings) {
      setFormData({
        freshservice_domain: settings.freshservice_domain || '',
        freshservice_api_key: settings.freshservice_api_key === '***MASKED***' ? '' : settings.freshservice_api_key || '',
        sync_interval_minutes: settings.sync_interval_minutes || 5,
        default_timezone: settings.default_timezone || 'America/Los_Angeles',
        dashboard_refresh_seconds: settings.dashboard_refresh_seconds || 30,
      });
    }
  }, [settings]);

  useEffect(() => {
    const fetchSyncStatus = async () => {
      try {
        const status = await syncAPI.getStatus();
        setSyncStatus(status.data);
      } catch (err) {
        console.error('Failed to fetch sync status:', err);
      }
    };

    const fetchPhotoStatus = async () => {
      try {
        const response = await axios.get('/api/photos/status');
        setPhotoStatus(response.data.data);
      } catch (err) {
        console.error('Failed to fetch photo status:', err);
      }
    };

    fetchSyncStatus();
    fetchPhotoStatus();
  }, []);

  const handleChange = (e) => {
    const { name, value } = e.target;
    setFormData(prev => ({ ...prev, [name]: value }));
  };

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestStatus(null);

    try {
      const result = await testConnection();
      setTestStatus({
        success: result.connected,
        message: result.message,
      });
    } catch (err) {
      setTestStatus({
        success: false,
        message: err.message,
      });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSave = async (e) => {
    e.preventDefault();
    setIsSaving(true);
    setSaveStatus(null);

    try {
      // Only include API key if it was changed (not empty)
      const settingsToUpdate = { ...formData };
      if (!settingsToUpdate.freshservice_api_key) {
        delete settingsToUpdate.freshservice_api_key;
      }

      const result = await updateSettings(settingsToUpdate);

      if (result.success) {
        setSaveStatus({ success: true, message: 'Settings saved successfully!' });
        // Refresh settings to get masked API key
        await fetchSettings();
      } else {
        setSaveStatus({ success: false, message: result.error || 'Failed to save settings' });
      }
    } catch (err) {
      setSaveStatus({ success: false, message: err.message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleTriggerSync = async () => {
    try {
      setSaveStatus({ success: true, message: 'Manual sync triggered...' });
      await syncAPI.trigger();
      setSaveStatus({ success: true, message: 'Sync completed successfully!' });
    } catch (err) {
      setSaveStatus({ success: false, message: `Sync failed: ${err.message}` });
    }
  };

  const handlePhotoSync = async () => {
    setIsPhotoSyncing(true);
    setPhotoSyncStatus(null);

    try {
      const response = await axios.post('/api/photos/sync');

      if (response.data.success) {
        setPhotoSyncStatus({
          success: true,
          message: `Photo sync completed! ${response.data.synced} photos synced, ${response.data.failed} failed.`
        });

        // Refresh photo status
        const statusResponse = await axios.get('/api/photos/status');
        setPhotoStatus(statusResponse.data.data);
      } else {
        setPhotoSyncStatus({
          success: false,
          message: response.data.message || 'Photo sync failed'
        });
      }
    } catch (err) {
      setPhotoSyncStatus({
        success: false,
        message: err.response?.data?.message || err.message || 'Failed to sync photos'
      });
    } finally {
      setIsPhotoSyncing(false);
    }
  };

  if (isLoading && !settings) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-gray-100">
        <Activity className="w-12 h-12 animate-spin text-blue-600" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gray-100">
      {/* Header */}
      <header className="bg-white shadow-sm border-b border-gray-200">
        <div className="max-w-4xl mx-auto px-4 py-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-2 text-blue-600 hover:text-blue-700 mb-4"
          >
            <ArrowLeft className="w-5 h-5" />
            Back to Dashboard
          </button>
          <h1 className="text-2xl font-bold text-gray-800">Settings</h1>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-4xl mx-auto px-4 py-6">
        <form onSubmit={handleSave} className="space-y-6">
          {/* FreshService Configuration */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">FreshService Configuration</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  FreshService Domain
                </label>
                <input
                  type="text"
                  name="freshservice_domain"
                  value={formData.freshservice_domain}
                  onChange={handleChange}
                  placeholder="your-company"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Enter just the subdomain (e.g., "company" for company.freshservice.com)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  API Key
                </label>
                <input
                  type="password"
                  name="freshservice_api_key"
                  value={formData.freshservice_api_key}
                  onChange={handleChange}
                  placeholder={settings?.freshservice_api_key === '***MASKED***' ? '(Configured)' : 'Enter API key'}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  Leave blank to keep existing API key
                </p>
              </div>

              <button
                type="button"
                onClick={handleTestConnection}
                disabled={isTesting}
                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
              >
                <TestTube className="w-4 h-4" />
                {isTesting ? 'Testing...' : 'Test Connection'}
              </button>

              {testStatus && (
                <div className={`flex items-center gap-2 p-3 rounded-lg ${testStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {testStatus.success ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                  <span>{testStatus.message}</span>
                </div>
              )}
            </div>
          </div>

          {/* Sync Configuration */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Sync Configuration</h2>

            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Sync Interval (minutes)
                </label>
                <input
                  type="number"
                  name="sync_interval_minutes"
                  value={formData.sync_interval_minutes}
                  onChange={handleChange}
                  min="1"
                  max="60"
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                />
                <p className="text-xs text-gray-500 mt-1">
                  How often to sync with FreshService (1-60 minutes)
                </p>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Default Timezone
                </label>
                <select
                  name="default_timezone"
                  value={formData.default_timezone}
                  onChange={handleChange}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                >
                  <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
                  <option value="America/Denver">Mountain (Denver)</option>
                  <option value="America/Chicago">Central (Chicago)</option>
                  <option value="America/New_York">Eastern (New York)</option>
                </select>
              </div>

              {syncStatus && (
                <div className="mt-4 p-4 bg-blue-50 rounded-lg">
                  <p className="text-sm text-gray-700">
                    <strong>Sync Status:</strong> {syncStatus.sync?.isRunning ? 'Running' : 'Idle'}
                  </p>
                  {syncStatus.sync?.lastSyncTime && (
                    <p className="text-sm text-gray-600 mt-1">
                      Last sync: {new Date(syncStatus.sync.lastSyncTime).toLocaleString()}
                    </p>
                  )}
                </div>
              )}

              <button
                type="button"
                onClick={handleTriggerSync}
                className="flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg"
              >
                <RefreshCw className="w-4 h-4" />
                Trigger Manual Sync
              </button>
            </div>
          </div>

          {/* Dashboard Configuration */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Dashboard Configuration</h2>

            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Dashboard Refresh Interval (seconds)
              </label>
              <input
                type="number"
                name="dashboard_refresh_seconds"
                value={formData.dashboard_refresh_seconds}
                onChange={handleChange}
                min="10"
                max="300"
                className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
              />
              <p className="text-xs text-gray-500 mt-1">
                How often the dashboard polls for updates (10-300 seconds)
              </p>
            </div>
          </div>

          {/* Profile Photos */}
          <div className="bg-white rounded-lg shadow-sm p-6 border border-gray-200">
            <h2 className="text-lg font-semibold mb-4">Profile Photos</h2>

            <div className="space-y-4">
              <p className="text-sm text-gray-600">
                Sync technician profile photos from Azure AD (Entra ID) using email matching.
              </p>

              {photoStatus && (
                <div className="p-4 bg-blue-50 rounded-lg">
                  <div className="grid grid-cols-3 gap-4 text-center">
                    <div>
                      <p className="text-2xl font-bold text-gray-900">{photoStatus.total}</p>
                      <p className="text-xs text-gray-600 uppercase font-medium">Total Techs</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-green-600">{photoStatus.withPhotos}</p>
                      <p className="text-xs text-gray-600 uppercase font-medium">With Photos</p>
                    </div>
                    <div>
                      <p className="text-2xl font-bold text-gray-500">{photoStatus.withoutPhotos}</p>
                      <p className="text-xs text-gray-600 uppercase font-medium">Without Photos</p>
                    </div>
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={handlePhotoSync}
                disabled={isPhotoSyncing}
                className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
              >
                <Users className="w-4 h-4" />
                {isPhotoSyncing ? 'Syncing Photos...' : 'Sync Photos from Azure AD'}
              </button>

              {photoSyncStatus && (
                <div className={`flex items-center gap-2 p-3 rounded-lg ${photoSyncStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                  {photoSyncStatus.success ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                  <span>{photoSyncStatus.message}</span>
                </div>
              )}
            </div>
          </div>

          {/* Save Button */}
          <div className="flex items-center justify-between">
            <button
              type="submit"
              disabled={isSaving}
              className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-6 py-3 rounded-lg font-semibold disabled:opacity-50"
            >
              <Save className="w-5 h-5" />
              {isSaving ? 'Saving...' : 'Save Settings'}
            </button>
          </div>

          {saveStatus && (
            <div className={`flex items-center gap-2 p-4 rounded-lg ${saveStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
              {saveStatus.success ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
              <span>{saveStatus.message}</span>
            </div>
          )}
        </form>
      </main>
    </div>
  );
}
