import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../contexts/SettingsContext';
import { syncAPI, visualsAPI } from '../services/api';
import api from '../services/api';
import AutoResponseSettings from '../components/AutoResponseSettings';
import AutoResponseTestInteractive from '../components/AutoResponseTestInteractive';
import LlmAdminPanel from '../components/LlmAdminPanel';
import NoiseRulesPanel from '../components/NoiseRulesPanel';
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
  const [techSchedules, setTechSchedules] = useState([]);
  const [scheduleSaving, setScheduleSaving] = useState({});
  const [scheduleStatus, setScheduleStatus] = useState(null);
  const [showInactive, setShowInactive] = useState(false);

  const navigationItems = [
    { id: 'freshservice', label: 'FreshService', icon: '🔌' },
    { id: 'sync', label: 'Sync Settings', icon: '🔄' },
    { id: 'dashboard', label: 'Dashboard', icon: '📊' },
    { id: 'photos', label: 'Profile Photos', icon: '👤' },
    { id: 'business-hours', label: 'Business Hours', icon: '🕐' },
    { id: 'tech-schedules', label: 'Tech Schedules', icon: '📅' },
    { id: 'noise-rules', label: 'Noise Rules', icon: '🔇' },
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

    const fetchTechSchedules = async () => {
      const toIANA = (tz) => {
        if (!tz) return 'America/Vancouver';
        const map = {
          'Pacific Time (US & Canada)': 'America/Vancouver',
          'Mountain Time (US & Canada)': 'America/Edmonton',
          'Central Time (US & Canada)': 'America/Winnipeg',
          'Eastern Time (US & Canada)': 'America/Toronto',
          'Atlantic Time (Canada)': 'America/Halifax',
          'America/Los_Angeles': 'America/Vancouver',
          'America/Denver': 'America/Edmonton',
          'America/Chicago': 'America/Winnipeg',
          'America/New_York': 'America/Toronto',
        };
        return map[tz] || tz;
      };
      try {
        const response = await visualsAPI.getAgents({ includeInactive: true });
        if (response.success && response.data?.agents) {
          setTechSchedules(response.data.agents.map(a => ({
            id: a.id,
            name: a.name,
            timezone: toIANA(a.timezone),
            workStartTime: a.workStartTime || '',
            workEndTime: a.workEndTime || '',
            isActive: a.isActive,
          })));
        }
      } catch (err) {
        console.error('Failed to fetch tech schedules:', err);
      }
    };

    fetchSyncStatus();
    fetchPhotoStatus();
    fetchTechSchedules();
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

  const handleScheduleChange = (techId, field, value) => {
    setTechSchedules(prev => prev.map(t =>
      t.id === techId ? { ...t, [field]: value } : t,
    ));
  };

  const handleApplyAllSchedule = (field, value) => {
    setTechSchedules(prev => prev.map(t =>
      t.isActive !== false ? { ...t, [field]: value } : t,
    ));
  };

  const handleSaveAllSchedules = async () => {
    const activeTechs = techSchedules.filter(t => t.isActive !== false);
    setScheduleSaving({ _all: true });
    setScheduleStatus(null);
    let failed = 0;
    try {
      await Promise.all(activeTechs.map(async (tech) => {
        try {
          await visualsAPI.updateAgentSchedule(tech.id, {
            workStartTime: tech.workStartTime || null,
            workEndTime: tech.workEndTime || null,
            timezone: tech.timezone || undefined,
          });
        } catch {
          failed++;
        }
      }));
      if (failed === 0) {
        setScheduleStatus({ success: true, message: `All ${activeTechs.length} schedules saved.` });
      } else {
        setScheduleStatus({ success: false, message: `Saved ${activeTechs.length - failed} schedules, ${failed} failed.` });
      }
    } catch (err) {
      setScheduleStatus({ success: false, message: `Save failed: ${err.message}` });
    } finally {
      setScheduleSaving({});
      setTimeout(() => setScheduleStatus(null), 4000);
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

            {/* Technician Schedules */}
            {activeSection === 'tech-schedules' && (
              <div className="p-6">
                {(() => {
                  const TZ = [
                    { value: 'America/Halifax', short: 'AT', label: 'Atlantic' },
                    { value: 'America/Toronto', short: 'ET', label: 'Eastern' },
                    { value: 'America/Winnipeg', short: 'CT', label: 'Central' },
                    { value: 'America/Edmonton', short: 'MT', label: 'Mountain' },
                    { value: 'America/Vancouver', short: 'PT', label: 'Pacific' },
                  ];
                  const TZ_COLORS = {
                    'America/Halifax': 'bg-violet-500',
                    'America/Toronto': 'bg-blue-500',
                    'America/Winnipeg': 'bg-teal-500',
                    'America/Edmonton': 'bg-amber-500',
                    'America/Vancouver': 'bg-emerald-500',
                  };
                  const normTz = (tz) => {
                    if (!tz) return 'America/Vancouver';
                    const m = {
                      'America/Los_Angeles': 'America/Vancouver',
                      'America/Denver': 'America/Edmonton',
                      'America/Chicago': 'America/Winnipeg',
                      'America/New_York': 'America/Toronto',
                      'Pacific Time (US & Canada)': 'America/Vancouver',
                      'Mountain Time (US & Canada)': 'America/Edmonton',
                      'Central Time (US & Canada)': 'America/Winnipeg',
                      'Eastern Time (US & Canada)': 'America/Toronto',
                      'Atlantic Time (Canada)': 'America/Halifax',
                    };
                    return m[tz] || tz;
                  };
                  const tzShort = (tz) => TZ.find(t => t.value === normTz(tz))?.short || '?';
                  const tzLabel = (tz) => TZ.find(t => t.value === normTz(tz))?.label || tz;

                  const STARTS = [
                    { value: '', label: 'Auto' },
                    { value: '07:00', label: '7 AM' },
                    { value: '08:00', label: '8 AM' },
                    { value: '09:00', label: '9 AM' },
                  ];
                  const ENDS = [
                    { value: '', label: 'Auto' },
                    { value: '16:00', label: '4 PM' },
                    { value: '17:00', label: '5 PM' },
                  ];

                  const activeTechs = techSchedules.filter(t => t.isActive !== false);
                  const inactiveTechs = techSchedules.filter(t => t.isActive === false);
                  const isSavingAll = !!scheduleSaving._all;

                  const Pill = ({ options, value, onChange, className = '' }) => (
                    <div className={`inline-flex rounded-lg border border-gray-200 overflow-hidden ${className}`}>
                      {options.map(opt => (
                        <button
                          key={opt.value}
                          onClick={() => onChange(opt.value)}
                          className={`px-3 py-1.5 text-xs font-medium transition-all ${
                            value === opt.value
                              ? 'bg-blue-600 text-white shadow-inner'
                              : 'bg-white text-gray-600 hover:bg-gray-50'
                          } ${options.indexOf(opt) > 0 ? 'border-l border-gray-200' : ''}`}
                        >
                          {opt.label}
                        </button>
                      ))}
                    </div>
                  );

                  const TzPill = ({ value, onChange }) => (
                    <div className="inline-flex rounded-lg border border-gray-200 overflow-hidden">
                      {TZ.map((tz, i) => (
                        <button
                          key={tz.value}
                          onClick={() => onChange(tz.value)}
                          title={tz.label}
                          className={`px-2.5 py-1.5 text-xs font-bold transition-all ${
                            normTz(value) === tz.value
                              ? `${TZ_COLORS[tz.value]} text-white shadow-inner`
                              : 'bg-white text-gray-500 hover:bg-gray-50'
                          } ${i > 0 ? 'border-l border-gray-200' : ''}`}
                        >
                          {tz.short}
                        </button>
                      ))}
                    </div>
                  );

                  return (
                    <div className="space-y-5">
                      {/* Header + Apply All */}
                      <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                        <div className="px-5 pt-5 pb-3">
                          <h2 className="text-base font-semibold text-gray-900">Work Schedules</h2>
                          <p className="text-xs text-gray-500 mt-0.5">Click to set timezone and hours per tech. Use the bar below to apply to everyone.</p>
                        </div>

                        {scheduleStatus && (
                          <div className={`mx-5 mb-3 flex items-center gap-2 p-2.5 rounded-lg text-sm ${scheduleStatus.success ? 'bg-green-50 text-green-700' : 'bg-red-50 text-red-700'}`}>
                            {scheduleStatus.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                            {scheduleStatus.message}
                          </div>
                        )}

                        {/* Bulk controls */}
                        <div className="px-5 py-3 bg-gradient-to-r from-blue-50 to-indigo-50 border-y border-blue-100 flex items-center gap-4 flex-wrap">
                          <span className="text-xs font-semibold text-blue-700 uppercase tracking-wide">Set all</span>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-blue-500 font-medium">TZ</span>
                            <TzPill value="" onChange={v => {
                              const label = TZ.find(t => t.value === v)?.label || v;
                              if (window.confirm(`Set timezone to ${label} for all ${activeTechs.length} active techs?`)) handleApplyAllSchedule('timezone', v);
                            }} />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-blue-500 font-medium">IN</span>
                            <Pill options={STARTS} value="__none__" onChange={v => {
                              const label = STARTS.find(s => s.value === v)?.label || v;
                              if (window.confirm(`Set start time to ${label} for all ${activeTechs.length} active techs?`)) handleApplyAllSchedule('workStartTime', v);
                            }} />
                          </div>
                          <div className="flex items-center gap-1.5">
                            <span className="text-[10px] text-blue-500 font-medium">OUT</span>
                            <Pill options={ENDS} value="__none__" onChange={v => {
                              const label = ENDS.find(s => s.value === v)?.label || v;
                              if (window.confirm(`Set end time to ${label} for all ${activeTechs.length} active techs?`)) handleApplyAllSchedule('workEndTime', v);
                            }} />
                          </div>
                        </div>

                        {/* Tech rows */}
                        <div className="divide-y divide-gray-100">
                          {activeTechs.map(tech => (
                            <div key={tech.id} className="px-5 py-3 flex items-center gap-4 hover:bg-gray-50/50 transition-colors">
                              {/* Name */}
                              <div className="w-[160px] flex-shrink-0">
                                <div className="text-sm font-semibold text-gray-900 truncate">{tech.name}</div>
                                <div className="text-[10px] text-gray-400">{tzLabel(tech.timezone)}</div>
                              </div>

                              {/* TZ pills */}
                              <TzPill
                                value={tech.timezone}
                                onChange={v => handleScheduleChange(tech.id, 'timezone', v)}
                              />

                              {/* Start pills */}
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-gray-400 font-medium w-5">IN</span>
                                <Pill
                                  options={STARTS}
                                  value={tech.workStartTime}
                                  onChange={v => handleScheduleChange(tech.id, 'workStartTime', v)}
                                />
                              </div>

                              {/* End pills */}
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-gray-400 font-medium w-6">OUT</span>
                                <Pill
                                  options={ENDS}
                                  value={tech.workEndTime}
                                  onChange={v => handleScheduleChange(tech.id, 'workEndTime', v)}
                                />
                              </div>
                            </div>
                          ))}
                        </div>

                        {/* Save bar */}
                        <div className="px-5 py-3 bg-gray-50 border-t border-gray-200 flex items-center justify-between">
                          <button
                            onClick={handleSaveAllSchedules}
                            disabled={isSavingAll}
                            className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm"
                          >
                            <Save className="w-4 h-4" />
                            {isSavingAll ? 'Saving...' : `Save All Schedules`}
                          </button>
                          <span className="text-xs text-gray-400">{activeTechs.length} active technicians</span>
                        </div>
                      </div>

                      {/* Inactive techs - collapsible */}
                      {inactiveTechs.length > 0 && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 overflow-hidden">
                          <button
                            onClick={() => setShowInactive(p => !p)}
                            className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-gray-50 transition-colors"
                          >
                            <span className="text-xs font-semibold text-gray-400 uppercase tracking-wide">
                              Inactive Technicians ({inactiveTechs.length})
                            </span>
                            <span className={`text-gray-400 text-xs transition-transform ${showInactive ? 'rotate-180' : ''}`}>&#9660;</span>
                          </button>
                          {showInactive && (
                            <div className="divide-y divide-gray-100 border-t border-gray-100">
                              {inactiveTechs.map(tech => (
                                <div key={tech.id} className="px-5 py-2.5 flex items-center gap-4 opacity-50">
                                  <div className="w-[160px] text-sm text-gray-600 truncate">{tech.name}</div>
                                  <span className="text-xs text-gray-400">{tzShort(tech.timezone)}</span>
                                  <span className="text-xs text-gray-400">{tech.workStartTime || '—'}</span>
                                  <span className="text-xs text-gray-400">{tech.workEndTime || '—'}</span>
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      )}

                      {techSchedules.length === 0 && (
                        <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-8 text-center">
                          <p className="text-sm text-gray-500">No technicians found. Sync technicians first.</p>
                        </div>
                      )}
                    </div>
                  );
                })()}
              </div>
            )}

            {/* Noise Rules */}
            {activeSection === 'noise-rules' && (
              <NoiseRulesPanel />
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
