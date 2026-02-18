import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../contexts/SettingsContext';
import { syncAPI } from '../services/api';
import api from '../services/api';
import AutoResponseSettings from '../components/AutoResponseSettings';
import AutoResponseTestInteractive from '../components/AutoResponseTestInteractive';
import LlmAdminPanel from '../components/LlmAdminPanel';
import {
  ArrowLeft,
  Save,
  TestTube,
  RefreshCw,
  CheckCircle,
  XCircle,
  Activity,
  Users,
} from 'lucide-react';

export default function Settings() {
  const navigate = useNavigate();
  const { settings, isLoading, fetchSettings, updateSettings, testConnection } = useSettings();

  const [activeSection, setActiveSection] = useState('freshservice');

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

  const navigationItems = [
    { id: 'freshservice', label: 'FreshService', icon: '🔌' },
    { id: 'sync', label: 'Sync Settings', icon: '🔄' },
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'photos', label: 'Profile Photos', icon: '👤' },
    { id: 'business-hours', label: 'Business Hours', icon: '🕐' },
    { id: 'llm-config', label: 'LLM Configuration', icon: '🤖' },
    { id: 'auto-response-test', label: 'Test Auto-Response', icon: '🧪' },
  ];

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
        const response = await api.get('/photos/status');
        setPhotoStatus(response.data);
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
      const response = await api.post('/photos/sync');

      if (response.success) {
        setPhotoSyncStatus({
          success: true,
          message: `Photo sync completed! ${response.synced} photos synced, ${response.failed} failed.`,
        });

        const statusResponse = await api.get('/photos/status');
        setPhotoStatus(statusResponse.data);
      } else {
        setPhotoSyncStatus({
          success: false,
          message: response.message || 'Photo sync failed',
        });
      }
    } catch (err) {
      setPhotoSyncStatus({
        success: false,
        message: err.response?.data?.message || err.message || 'Failed to sync photos',
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
    <div className="h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Compact Header */}
      <header className="bg-white border-b border-gray-200 px-6 py-2.5 flex items-center justify-between flex-shrink-0">
        <div className="flex items-center gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="flex items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span>Back to Dashboard</span>
          </button>
          <div className="h-4 w-px bg-gray-300"></div>
          <h1 className="text-sm font-semibold text-gray-900">Settings</h1>
        </div>
      </header>

      {/* Main Content with Sidebar */}
      <div className="flex-1 flex overflow-hidden">
        {/* Left Navigation Pane */}
        <aside className="w-56 bg-white border-r border-gray-200 flex-shrink-0">
          <nav className="p-3 space-y-0.5 h-full overflow-y-auto">
            {navigationItems.map((item) => (
              <button
                key={item.id}
                onClick={() => setActiveSection(item.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-md text-sm text-left transition-all ${
                  activeSection === item.id
                    ? 'bg-blue-600 text-white shadow-sm'
                    : 'text-gray-700 hover:bg-gray-100'
                }`}
              >
                <span className="text-base">{item.icon}</span>
                <span className="font-medium">{item.label}</span>
              </button>
            ))}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="flex-1 overflow-y-auto bg-gray-50">
          <div className="h-full">
            {/* FreshService Configuration */}
            {activeSection === 'freshservice' && (
              <form onSubmit={handleSave} className="p-6 space-y-4">
                <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
                  <h2 className="text-base font-semibold mb-4 text-gray-900">FreshService Configuration</h2>

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
                  Enter just the subdomain (e.g., &quot;company&quot; for company.freshservice.com)
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

                {/* Save Button for FreshService */}
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
            )}

            {/* Sync Configuration */}
            {activeSection === 'sync' && (
              <div className="p-6 space-y-4">
                <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
                  <h2 className="text-base font-semibold mb-4 text-gray-900">Sync Configuration</h2>

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
              </div>
            )}

            {/* Dashboard Configuration */}
            {activeSection === 'dashboard' && (
              <div className="p-6">
                <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
                  <h2 className="text-base font-semibold mb-4 text-gray-900">Dashboard Configuration</h2>

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
              </div>
            )}

            {/* Profile Photos */}
            {activeSection === 'photos' && (
              <div className="p-6">
                <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
                  <h2 className="text-base font-semibold mb-4 text-gray-900">Profile Photos</h2>

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
              </div>
            )}

            {/* Business Hours & Holidays */}
            {activeSection === 'business-hours' && (
              <div className="p-6">
                <AutoResponseSettings />
              </div>
            )}

            {/* LLM Configuration */}
            {activeSection === 'llm-config' && (
              <div className="h-full">
                <LlmAdminPanel />
              </div>
            )}

            {/* Test Auto-Response */}
            {activeSection === 'auto-response-test' && (
              <div className="p-6">
                <AutoResponseTestInteractive />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
