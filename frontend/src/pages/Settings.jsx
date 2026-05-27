import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSettings } from '../contexts/SettingsContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { settingsAPI, syncAPI, visualsAPI } from '../services/api';
import api from '../services/api';
import { dataCache } from '../services/dataCache';
import AutoResponseSettings from '../components/AutoResponseSettings';
import AutoResponseTestInteractive from '../components/AutoResponseTestInteractive';
import LlmAdminPanel from '../components/LlmAdminPanel';
import NoiseRulesPanel from '../components/NoiseRulesPanel';
import SyncOperationsPanel from '../components/settings/SyncOperationsPanel';
import BackfillPanel from '../components/settings/BackfillPanel';
import WorkspaceManagementPanel from '../components/settings/WorkspaceManagementPanel';
import AdminManagementPanel from '../components/settings/AdminManagementPanel';
import VacationTrackerPanel from '../components/settings/VacationTrackerPanel';
import CalendarLeavePanel from '../components/settings/CalendarLeavePanel';
import TechnicianVisibilityPanel from '../components/settings/TechnicianVisibilityPanel';
import WorkspaceAccessPanel from '../components/settings/WorkspaceAccessPanel';
import {
  ArrowLeft,
  Save,
  TestTube,
  RefreshCw,
  CheckCircle,
  XCircle,
  Activity,
  Users,
  Plug,
  BarChart3,
  LayoutDashboard,
  Camera,
  Clock,
  CalendarDays,
  VolumeX,
  Bot,
  FlaskConical,
  Download,
  Globe,
  Shield,
  EyeOff,
  KeyRound,
  Bell,
  Mail,
  MessageCircle,
  MessageSquare,
  PhoneCall,
  Send,
} from 'lucide-react';

const DISABLED_SETTING_SECTIONS = new Set(['llm-config', 'auto-response-test']);

export default function Settings() {
  const navigate = useNavigate();
  const { settings, isLoading, fetchSettings, updateSettings, testConnection } = useSettings();
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const { user } = useAuth();

  const isGlobalAdmin = user?.role === 'admin';
  const wsRole = (() => {
    if (isGlobalAdmin) return 'admin';
    const ws = availableWorkspaces?.find(w => w.id === currentWorkspace?.id);
    return ws?.role || 'viewer';
  })();
  const isWsAdmin = wsRole === 'admin';

  const validSections = ['freshservice', 'notification-providers', 'sync', 'sync-ops', 'backfill', 'workspaces', 'admins', 'workspace-access', 'dashboard', 'photos', 'business-hours', 'tech-schedules', 'tech-visibility', 'noise-rules', 'llm-config', 'auto-response-test', 'vacation-tracker', 'calendar-leave'];
  const initialSection = (() => {
    const hash = window.location.hash.replace('#', '');
    return validSections.includes(hash) && !DISABLED_SETTING_SECTIONS.has(hash) ? hash : 'freshservice';
  })();
  const [activeSection, setActiveSectionRaw] = useState(initialSection);

  const setActiveSection = (id) => {
    if (DISABLED_SETTING_SECTIONS.has(id)) return;
    setActiveSectionRaw(id);
    window.history.replaceState(null, '', `#${id}`);
  };

  const [formData, setFormData] = useState({
    freshservice_domain: '',
    freshservice_api_key: '',
    service_account_names: '',
    sendgrid_api_key: '',
    sendgrid_from_email: '',
    twilio_account_sid: '',
    twilio_auth_token: '',
    twilio_from_number: '',
    twilio_whatsapp_sender: '',
    twilio_whatsapp_messaging_service_sid: '',
    twilio_whatsapp_content_sid: '',
    twilio_whatsapp_content_variables: '{"1":"{{message}}"}',
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
  const [providerTestTargets, setProviderTestTargets] = useState({
    sendgrid: user?.email || '',
    twilio: '',
  });
  const [providerTesting, setProviderTesting] = useState(null);
  const [providerTestStatus, setProviderTestStatus] = useState({});

  // role: 'global' = global admin only, 'admin' = workspace admin+, 'viewer' = anyone
  const allNavigationItems = [
    { id: 'freshservice', label: 'FreshService', Icon: Plug, minRole: 'global' },
    { id: 'notification-providers', label: 'Notifications', Icon: Bell, minRole: 'global' },
    { id: 'sync', label: 'Sync Settings', Icon: RefreshCw, minRole: 'admin' },
    { id: 'sync-ops', label: 'Sync Operations', Icon: BarChart3, minRole: 'admin' },
    { id: 'backfill', label: 'Backfill', Icon: Download, minRole: 'admin' },
    { id: 'workspaces', label: 'Workspaces', Icon: Globe, minRole: 'global' },
    { id: 'admins', label: 'Admins', Icon: Shield, minRole: 'global' },
    { id: 'workspace-access', label: 'Workspace Access', Icon: KeyRound, minRole: 'admin' },
    { id: 'dashboard', label: 'Dashboard', Icon: LayoutDashboard, minRole: 'viewer' },
    { id: 'photos', label: 'Photos & Locations', Icon: Camera, minRole: 'admin' },
    { id: 'business-hours', label: 'Business Hours', Icon: Clock, minRole: 'admin' },
    { id: 'tech-schedules', label: 'Tech Schedules', Icon: CalendarDays, minRole: 'admin' },
    { id: 'tech-visibility', label: 'Tech Visibility', Icon: EyeOff, minRole: 'admin' },
    { id: 'noise-rules', label: 'Noise Rules', Icon: VolumeX, minRole: 'admin' },
    { id: 'llm-config', label: 'LLM Config', Icon: Bot, minRole: 'admin', disabled: true, status: 'In development' },
    { id: 'auto-response-test', label: 'Test Auto-Response', Icon: FlaskConical, minRole: 'admin', disabled: true, status: 'In development' },
    { id: 'vacation-tracker', label: 'Vacation Tracker', Icon: CalendarDays, minRole: 'admin' },
    { id: 'calendar-leave', label: 'Shared Calendar', Icon: CalendarDays, minRole: 'admin' },
  ];

  const navigationItems = allNavigationItems.filter(item => {
    if (item.minRole === 'global') return isGlobalAdmin;
    if (item.minRole === 'admin') return isWsAdmin;
    return true; // viewer
  });

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    if (settings) {
      setFormData({
        freshservice_domain: settings.freshservice_domain || '',
        freshservice_api_key: settings.freshservice_api_key === '***MASKED***' ? '' : settings.freshservice_api_key || '',
        service_account_names: settings.service_account_names || '',
        sendgrid_api_key: settings.sendgrid_api_key === '***MASKED***' ? '' : settings.sendgrid_api_key || '',
        sendgrid_from_email: settings.sendgrid_from_email || '',
        twilio_account_sid: settings.twilio_account_sid || '',
        twilio_auth_token: settings.twilio_auth_token === '***MASKED***' ? '' : settings.twilio_auth_token || '',
        twilio_from_number: settings.twilio_from_number || '',
        twilio_whatsapp_sender: settings.twilio_whatsapp_sender || '',
        twilio_whatsapp_messaging_service_sid: settings.twilio_whatsapp_messaging_service_sid || '',
        twilio_whatsapp_content_sid: settings.twilio_whatsapp_content_sid || '',
        twilio_whatsapp_content_variables: settings.twilio_whatsapp_content_variables || '{"1":"{{message}}"}',
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

  const handleProviderTargetChange = (name, value) => {
    setProviderTestTargets(prev => ({ ...prev, [name]: value }));
  };

  const pruneNotificationSecrets = (settingsToUpdate) => {
    const pruned = { ...settingsToUpdate };
    if (!pruned.sendgrid_api_key) delete pruned.sendgrid_api_key;
    if (!pruned.twilio_auth_token) delete pruned.twilio_auth_token;
    return pruned;
  };

  const buildNotificationProviderSettings = (channel = 'all') => {
    if (channel === 'sendgrid') {
      return pruneNotificationSecrets({
        sendgrid_api_key: formData.sendgrid_api_key,
        sendgrid_from_email: formData.sendgrid_from_email,
      });
    }

    if (channel === 'twilio_sms' || channel === 'twilio_whatsapp' || channel === 'twilio_voice' || channel === 'twilio') {
      return pruneNotificationSecrets({
        twilio_account_sid: formData.twilio_account_sid,
        twilio_auth_token: formData.twilio_auth_token,
        twilio_from_number: formData.twilio_from_number,
        twilio_whatsapp_sender: formData.twilio_whatsapp_sender,
        twilio_whatsapp_messaging_service_sid: formData.twilio_whatsapp_messaging_service_sid,
        twilio_whatsapp_content_sid: formData.twilio_whatsapp_content_sid,
        twilio_whatsapp_content_variables: formData.twilio_whatsapp_content_variables,
      });
    }

    return pruneNotificationSecrets({
      sendgrid_api_key: formData.sendgrid_api_key,
      sendgrid_from_email: formData.sendgrid_from_email,
      twilio_account_sid: formData.twilio_account_sid,
      twilio_auth_token: formData.twilio_auth_token,
      twilio_from_number: formData.twilio_from_number,
      twilio_whatsapp_sender: formData.twilio_whatsapp_sender,
      twilio_whatsapp_messaging_service_sid: formData.twilio_whatsapp_messaging_service_sid,
      twilio_whatsapp_content_sid: formData.twilio_whatsapp_content_sid,
      twilio_whatsapp_content_variables: formData.twilio_whatsapp_content_variables,
    });
  };

  const handleProviderTest = async (channel) => {
    setProviderTesting(channel);
    setProviderTestStatus(prev => ({ ...prev, [channel]: null }));

    try {
      const saveResult = await updateSettings(buildNotificationProviderSettings(channel));
      if (!saveResult.success) {
        throw new Error(saveResult.error || 'Could not save provider settings before testing');
      }

      const recipient = channel === 'sendgrid'
        ? providerTestTargets.sendgrid
        : providerTestTargets.twilio;
      const result = await settingsAPI.testNotificationProvider({ channel, recipient });
      const providerMessageId = result?.data?.providerMessageId ? ` Provider ID: ${result.data.providerMessageId}` : '';
      setProviderTestStatus(prev => ({
        ...prev,
        [channel]: {
          success: true,
          message: `Test sent.${providerMessageId}`,
        },
      }));
      await fetchSettings();
    } catch (err) {
      setProviderTestStatus(prev => ({
        ...prev,
        [channel]: {
          success: false,
          message: err.message || 'Provider test failed',
        },
      }));
    } finally {
      setProviderTesting(null);
    }
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
      const sectionKeys = {
        freshservice: ['freshservice_domain', 'freshservice_api_key', 'service_account_names'],
        'notification-providers': [
          'sendgrid_api_key',
          'sendgrid_from_email',
          'twilio_account_sid',
          'twilio_auth_token',
          'twilio_from_number',
          'twilio_whatsapp_sender',
          'twilio_whatsapp_messaging_service_sid',
          'twilio_whatsapp_content_sid',
          'twilio_whatsapp_content_variables',
        ],
        sync: ['sync_interval_minutes', 'default_timezone'],
        dashboard: ['dashboard_refresh_seconds'],
      };
      const keys = sectionKeys[activeSection] || Object.keys(formData);
      const settingsToUpdate = Object.fromEntries(keys.map((key) => [key, formData[key]]));
      if (!settingsToUpdate.freshservice_api_key) {
        delete settingsToUpdate.freshservice_api_key;
      }
      if (!settingsToUpdate.sendgrid_api_key) {
        delete settingsToUpdate.sendgrid_api_key;
      }
      if (!settingsToUpdate.twilio_auth_token) {
        delete settingsToUpdate.twilio_auth_token;
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

  const [syncDetails, setSyncDetails] = useState(null);
  const [forceLocations, setForceLocations] = useState(false);

  const handlePhotoSync = async () => {
    setIsPhotoSyncing(true);
    setPhotoSyncStatus(null);
    setSyncDetails(null);

    try {
      const response = await api.post('/photos/sync', { forceLocations });

      if (response.success) {
        dataCache.clear();

        const p = response.photos || {};
        const l = response.locations || {};
        const parts = [];
        parts.push(`Photos: ${p.synced || 0} synced, ${p.failed || 0} missing`);
        parts.push(`Locations: ${l.synced || 0} updated, ${l.skipped || 0} kept, ${l.failed || 0} not in AD`);

        setPhotoSyncStatus({ success: true, message: parts.join(' · ') });
        setSyncDetails(response.details || []);

        const statusResponse = await api.get('/photos/status');
        setPhotoStatus(statusResponse.data);
      } else {
        setPhotoSyncStatus({
          success: false,
          message: response.message || 'Sync failed',
        });
      }
    } catch (err) {
      setPhotoSyncStatus({
        success: false,
        message: err.message || 'Failed to sync from Azure AD',
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
    <div className="min-h-screen bg-gray-50 flex flex-col overflow-hidden">
      {/* Compact Header */}
      <header className="bg-white border-b border-gray-200 px-3 sm:px-6 py-2.5 flex flex-wrap items-center justify-between gap-2 flex-shrink-0">
        <div className="flex min-w-0 items-center gap-3 sm:gap-4">
          <button
            onClick={() => navigate('/dashboard')}
            className="flex min-h-[40px] flex-shrink-0 items-center gap-1.5 text-sm text-gray-600 hover:text-gray-900 transition-colors"
          >
            <ArrowLeft className="w-4 h-4" />
            <span className="hidden sm:inline">Back to Dashboard</span>
          </button>
          <div className="h-4 w-px bg-gray-300"></div>
          <h1 className="min-w-0 truncate text-sm font-semibold text-gray-900">Settings</h1>
        </div>
        {currentWorkspace && availableWorkspaces.length > 1 && (
          <select
            value={currentWorkspace.id}
            onChange={(e) => {
              const newId = Number(e.target.value);
              if (newId === currentWorkspace.id) return;
              switchWorkspace(newId);
              window.location.reload();
            }}
            className="text-xs bg-blue-50 text-blue-700 border border-blue-200 rounded px-2 py-1 font-medium cursor-pointer hover:bg-blue-100"
            title="Switch workspace"
          >
            {availableWorkspaces.map(ws => (
              <option key={ws.id} value={ws.id}>{ws.name}{ws.role ? ` [${ws.role}]` : ''}</option>
            ))}
          </select>
        )}
      </header>

      {/* Main Content with Sidebar */}
      <div className="flex-1 flex flex-col overflow-hidden md:flex-row">
        {/* Left Navigation Pane */}
        <aside className="w-full bg-gray-50/70 border-b border-gray-200/80 flex-shrink-0 md:w-52 md:border-b-0 md:border-r">
          <nav className="flex gap-1 overflow-x-auto p-2 [scrollbar-width:none] [-ms-overflow-style:none] md:block md:h-full md:space-y-px md:overflow-y-auto [&::-webkit-scrollbar]:hidden">
            {navigationItems.map((item) => {
              const isActive = activeSection === item.id;
              const isDisabled = !!item.disabled;
              return (
                <button
                  key={item.id}
                  onClick={() => setActiveSection(item.id)}
                  disabled={isDisabled}
                  title={isDisabled ? `${item.label} is in development` : undefined}
                  className={`flex flex-shrink-0 items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] transition-all md:w-full ${
                    isDisabled
                      ? 'cursor-not-allowed bg-gray-100/70 text-gray-400 opacity-70'
                      : isActive
                        ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200/80 font-medium'
                        : 'text-gray-500 hover:text-gray-700 hover:bg-white/60'
                  }`}
                >
                  <item.Icon className={`w-4 h-4 flex-shrink-0 ${isActive && !isDisabled ? 'text-blue-600' : 'text-gray-400'}`} />
                  <span className="truncate">{item.label}</span>
                  {item.status && (
                    <span className="ml-auto hidden rounded-full bg-gray-200 px-1.5 py-0.5 text-[10px] font-semibold text-gray-500 md:inline">
                      {item.status}
                    </span>
                  )}
                </button>
              );
            })}
          </nav>
        </aside>

        {/* Main Content Area */}
        <main className="min-w-0 flex-1 overflow-y-auto bg-gray-50">
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

                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">
                  Service Account Name(s)
                      </label>
                      <input
                        type="text"
                        name="service_account_names"
                        value={formData.service_account_names}
                        onChange={handleChange}
                        placeholder="e.g. Ticket Pulse, Vahid Haeri"
                        className="w-full px-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                      />
                      <p className="text-xs text-gray-500 mt-1">
                  Comma-separated names of FreshService agents used by the app. Assignments by these agents will be shown as &ldquo;App Assigned&rdquo; on the dashboard. Tip: create a dedicated agent (e.g. &ldquo;Ticket Pulse&rdquo;) and use its API key above.
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

            {/* Notification Provider Configuration */}
            {activeSection === 'notification-providers' && (
              <form onSubmit={handleSave} className="p-6 space-y-5">
                <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                  <div className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-100 pb-4">
                    <div>
                      <h2 className="text-base font-semibold text-slate-950">Notification Providers</h2>
                      <p className="mt-1 text-sm text-slate-500">
                        Global provider setup for all workspaces. Tests save the provider settings first, then send a real test message.
                      </p>
                    </div>
                    <button
                      type="submit"
                      disabled={isSaving}
                      className="inline-flex h-10 items-center gap-2 rounded-lg bg-blue-600 px-4 text-sm font-semibold text-white shadow-sm hover:bg-blue-700 disabled:cursor-wait disabled:opacity-60"
                    >
                      <Save className="h-4 w-4" />
                      {isSaving ? 'Saving...' : 'Save Providers'}
                    </button>
                  </div>

                  <div className="mt-5 grid gap-4 xl:grid-cols-2">
                    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                      <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 text-blue-700">
                            <Mail className="h-4 w-4" />
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold text-slate-950">SendGrid Email</h3>
                            <p className="text-xs text-slate-500">Uses the SendGrid v3 Web API with a Bearer API key.</p>
                          </div>
                        </div>
                        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                          settings?.sendgrid_api_key === '***MASKED***' && settings?.sendgrid_from_email
                            ? 'bg-emerald-100 text-emerald-700'
                            : 'bg-slate-200 text-slate-600'
                        }`}>
                          {settings?.sendgrid_api_key === '***MASKED***' && settings?.sendgrid_from_email ? 'Configured' : 'Not configured'}
                        </span>
                      </div>

                      <div className="grid gap-3">
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">API key</span>
                          <input
                            type="password"
                            name="sendgrid_api_key"
                            value={formData.sendgrid_api_key}
                            onChange={handleChange}
                            placeholder={settings?.sendgrid_api_key === '***MASKED***' ? '(Configured)' : 'SG.xxxxx'}
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                          <span className="mt-1 block text-xs text-slate-500">Leave blank to keep the existing key.</span>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">From email</span>
                          <input
                            type="email"
                            name="sendgrid_from_email"
                            value={formData.sendgrid_from_email}
                            onChange={handleChange}
                            placeholder="ticketpulse@example.com"
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                          <span className="mt-1 block text-xs text-slate-500">Must be a verified sender or domain in SendGrid.</span>
                        </label>

                        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Test email</div>
                          <div className="flex flex-col gap-2 sm:flex-row">
                            <input
                              type="email"
                              value={providerTestTargets.sendgrid}
                              onChange={(event) => handleProviderTargetChange('sendgrid', event.target.value)}
                              placeholder="recipient@example.com"
                              className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleProviderTest('sendgrid')}
                              disabled={providerTesting === 'sendgrid' || !providerTestTargets.sendgrid}
                              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <Send className="h-4 w-4" />
                              {providerTesting === 'sendgrid' ? 'Sending...' : 'Send Test'}
                            </button>
                          </div>
                          {providerTestStatus.sendgrid && (
                            <div className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                              providerTestStatus.sendgrid.success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                            }`}>
                              {providerTestStatus.sendgrid.success ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                              <span>{providerTestStatus.sendgrid.message}</span>
                            </div>
                          )}
                        </div>
                      </div>
                    </section>

                    <section className="rounded-xl border border-slate-200 bg-slate-50/60 p-4">
                      <div className="mb-4 flex items-start justify-between gap-3">
                        <div className="flex items-center gap-2">
                          <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 text-indigo-700">
                            <MessageSquare className="h-4 w-4" />
                          </span>
                          <div>
                            <h3 className="text-sm font-semibold text-slate-950">Twilio SMS, WhatsApp, and Voice</h3>
                            <p className="text-xs text-slate-500">WhatsApp alerts use an approved Twilio Content template.</p>
                          </div>
                        </div>
                        <div className="flex flex-wrap justify-end gap-1.5">
                          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            settings?.twilio_account_sid && settings?.twilio_auth_token === '***MASKED***' && settings?.twilio_from_number
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-slate-200 text-slate-600'
                          }`}>
                            {settings?.twilio_account_sid && settings?.twilio_auth_token === '***MASKED***' && settings?.twilio_from_number ? 'SMS/voice ready' : 'SMS/voice incomplete'}
                          </span>
                          <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                            settings?.twilio_account_sid
                              && settings?.twilio_auth_token === '***MASKED***'
                              && settings?.twilio_whatsapp_content_sid
                              && (settings?.twilio_whatsapp_messaging_service_sid || settings?.twilio_whatsapp_sender || settings?.twilio_from_number)
                              ? 'bg-emerald-100 text-emerald-700'
                              : 'bg-amber-100 text-amber-700'
                          }`}>
                            {settings?.twilio_whatsapp_content_sid ? 'WhatsApp template set' : 'WhatsApp template needed'}
                          </span>
                        </div>
                      </div>

                      <div className="grid gap-3">
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Account SID</span>
                          <input
                            type="text"
                            name="twilio_account_sid"
                            value={formData.twilio_account_sid}
                            onChange={handleChange}
                            placeholder="AC..."
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Auth token</span>
                          <input
                            type="password"
                            name="twilio_auth_token"
                            value={formData.twilio_auth_token}
                            onChange={handleChange}
                            placeholder={settings?.twilio_auth_token === '***MASKED***' ? '(Configured)' : 'Enter auth token'}
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                          <span className="mt-1 block text-xs text-slate-500">Leave blank to keep the existing token.</span>
                        </label>

                        <label className="block">
                          <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Twilio phone number</span>
                          <input
                            type="tel"
                            name="twilio_from_number"
                            value={formData.twilio_from_number}
                            onChange={handleChange}
                            placeholder="+16045550100"
                            className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                          />
                          <span className="mt-1 block text-xs text-slate-500">Use E.164 format.</span>
                        </label>

                        <div className="grid gap-3 rounded-lg border border-emerald-100 bg-emerald-50/50 p-3">
                          <div>
                            <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700">WhatsApp template</div>
                            <p className="mt-1 text-xs text-emerald-700/80">
                              Use a Twilio-approved template for business-initiated WhatsApp tests and alerts.
                            </p>
                          </div>

                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">WhatsApp sender</span>
                            <input
                              type="tel"
                              name="twilio_whatsapp_sender"
                              value={formData.twilio_whatsapp_sender}
                              onChange={handleChange}
                              placeholder="Defaults to Twilio phone number"
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <span className="mt-1 block text-xs text-slate-500">Optional. Use +16045550100 or whatsapp:+16045550100.</span>
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Messaging Service SID</span>
                            <input
                              type="text"
                              name="twilio_whatsapp_messaging_service_sid"
                              value={formData.twilio_whatsapp_messaging_service_sid}
                              onChange={handleChange}
                              placeholder="MG..."
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <span className="mt-1 block text-xs text-slate-500">Optional. If set, Twilio selects the WhatsApp sender from the service.</span>
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Content SID</span>
                            <input
                              type="text"
                              name="twilio_whatsapp_content_sid"
                              value={formData.twilio_whatsapp_content_sid}
                              onChange={handleChange}
                              placeholder="HX..."
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <span className="mt-1 block text-xs text-slate-500">Required for WhatsApp tests and assignment alerts.</span>
                          </label>

                          <label className="block">
                            <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-slate-500">Content variables JSON</span>
                            <textarea
                              name="twilio_whatsapp_content_variables"
                              value={formData.twilio_whatsapp_content_variables}
                              onChange={handleChange}
                              rows={3}
                              className="w-full rounded-lg border border-slate-200 bg-white px-3 py-2 font-mono text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <span className="mt-1 block text-xs text-slate-500">Default sends the full alert text as template variable 1.</span>
                          </label>
                        </div>

                        <div className="mt-2 rounded-lg border border-slate-200 bg-white p-3">
                          <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Test SMS, WhatsApp, and voice</div>
                          <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                            <input
                              type="tel"
                              value={providerTestTargets.twilio}
                              onChange={(event) => handleProviderTargetChange('twilio', event.target.value)}
                              placeholder="+16045550100"
                              className="min-w-0 flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100"
                            />
                            <button
                              type="button"
                              onClick={() => handleProviderTest('twilio_sms')}
                              disabled={providerTesting === 'twilio_sms' || !providerTestTargets.twilio}
                              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-slate-900 px-4 text-sm font-semibold text-white hover:bg-slate-800 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <MessageSquare className="h-4 w-4" />
                              {providerTesting === 'twilio_sms' ? 'Sending...' : 'Test SMS'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleProviderTest('twilio_whatsapp')}
                              disabled={providerTesting === 'twilio_whatsapp' || !providerTestTargets.twilio}
                              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-emerald-200 bg-emerald-50 px-4 text-sm font-semibold text-emerald-800 hover:bg-emerald-100 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <MessageCircle className="h-4 w-4" />
                              {providerTesting === 'twilio_whatsapp' ? 'Sending...' : 'Test WhatsApp'}
                            </button>
                            <button
                              type="button"
                              onClick={() => handleProviderTest('twilio_voice')}
                              disabled={providerTesting === 'twilio_voice' || !providerTestTargets.twilio}
                              className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-slate-200 bg-white px-4 text-sm font-semibold text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                            >
                              <PhoneCall className="h-4 w-4" />
                              {providerTesting === 'twilio_voice' ? 'Calling...' : 'Test Voice'}
                            </button>
                          </div>
                          {['twilio_sms', 'twilio_whatsapp', 'twilio_voice'].map((channel) => (
                            providerTestStatus[channel] && (
                              <div key={channel} className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                                providerTestStatus[channel].success ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'
                              }`}>
                                {providerTestStatus[channel].success ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                                <span>{channel === 'twilio_sms' ? 'SMS: ' : channel === 'twilio_whatsapp' ? 'WhatsApp: ' : 'Voice: '}{providerTestStatus[channel].message}</span>
                              </div>
                            )
                          ))}
                        </div>
                      </div>
                    </section>
                  </div>
                </div>

                {saveStatus && (
                  <div className={`flex items-center gap-2 rounded-lg p-4 ${saveStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                    {saveStatus.success ? <CheckCircle className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
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

            {/* Sync Operations */}
            {activeSection === 'sync-ops' && <SyncOperationsPanel />}

            {/* Backfill */}
            {activeSection === 'backfill' && (
              <div className="p-6">
                <BackfillPanel />
              </div>
            )}

            {/* Workspaces */}
            {activeSection === 'workspaces' && (
              <div className="p-6">
                <WorkspaceManagementPanel />
              </div>
            )}

            {/* Admins */}
            {activeSection === 'admins' && (
              <div className="p-6">
                <AdminManagementPanel />
              </div>
            )}

            {/* Workspace Access */}
            {activeSection === 'workspace-access' && (
              <div className="p-6">
                <WorkspaceAccessPanel />
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

            {/* Photos & Locations */}
            {activeSection === 'photos' && (
              <div className="p-6">
                <div className="bg-white rounded-lg shadow-sm p-5 border border-gray-200">
                  <h2 className="text-base font-semibold mb-1 text-gray-900">Photos &amp; Locations</h2>
                  <p className="text-sm text-gray-500 mb-4">
                    Sync technician profile photos and office locations from Azure AD (Entra ID). Locations are only updated for technicians without a manually set location.
                  </p>

                  {photoStatus && (
                    <div className="grid grid-cols-2 gap-3 mb-4">
                      <div className="p-3 bg-blue-50 rounded-lg">
                        <p className="text-xs text-gray-500 uppercase font-medium mb-2">Photos</p>
                        <div className="flex items-baseline gap-3">
                          <span className="text-2xl font-bold text-green-600">{photoStatus.withPhotos}</span>
                          <span className="text-xs text-gray-500">with photos</span>
                          <span className="text-lg font-semibold text-gray-400">{photoStatus.withoutPhotos}</span>
                          <span className="text-xs text-gray-500">missing</span>
                        </div>
                      </div>
                      <div className="p-3 bg-indigo-50 rounded-lg">
                        <p className="text-xs text-gray-500 uppercase font-medium mb-2">Locations</p>
                        <div className="flex items-baseline gap-3">
                          <span className="text-2xl font-bold text-indigo-600">{photoStatus.withLocation ?? '—'}</span>
                          <span className="text-xs text-gray-500">with location</span>
                          <span className="text-lg font-semibold text-gray-400">{photoStatus.withoutLocation ?? '—'}</span>
                          <span className="text-xs text-gray-500">missing</span>
                        </div>
                      </div>
                    </div>
                  )}

                  {photoStatus && (
                    <p className="text-xs text-gray-400 mb-4">{photoStatus.total} active technician{photoStatus.total !== 1 ? 's' : ''} in this workspace</p>
                  )}

                  <div className="flex items-center gap-4 mb-3">
                    <button
                      type="button"
                      onClick={handlePhotoSync}
                      disabled={isPhotoSyncing}
                      className="flex items-center gap-2 bg-purple-600 hover:bg-purple-700 text-white px-4 py-2 rounded-lg disabled:opacity-50"
                    >
                      <Users className="w-4 h-4" />
                      {isPhotoSyncing ? 'Syncing from Azure AD...' : 'Sync Photos & Locations from Azure AD'}
                    </button>
                    <label className="flex items-center gap-2 text-sm text-gray-600 cursor-pointer select-none">
                      <input
                        type="checkbox"
                        checked={forceLocations}
                        onChange={(e) => setForceLocations(e.target.checked)}
                        className="rounded border-gray-300"
                      />
                      Overwrite existing locations with AD data
                    </label>
                  </div>

                  {photoSyncStatus && (
                    <div className={`flex items-start gap-2 p-3 rounded-lg ${photoSyncStatus.success ? 'bg-green-50 text-green-800' : 'bg-red-50 text-red-800'}`}>
                      {photoSyncStatus.success ? <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /> : <XCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />}
                      <span className="text-sm">{photoSyncStatus.message}</span>
                    </div>
                  )}

                  {syncDetails && syncDetails.length > 0 && (
                    <div className="mt-4 border border-gray-200 rounded-lg overflow-hidden">
                      <div className="bg-gray-50 px-4 py-2 border-b border-gray-200">
                        <h3 className="text-xs font-semibold text-gray-600 uppercase">Sync Details</h3>
                      </div>
                      <div className="max-h-80 overflow-y-auto">
                        <table className="w-full text-xs">
                          <thead>
                            <tr className="bg-gray-50 border-b">
                              <th className="text-left px-3 py-1.5 font-medium text-gray-500">Name</th>
                              <th className="text-center px-3 py-1.5 font-medium text-gray-500">Photo</th>
                              <th className="text-left px-3 py-1.5 font-medium text-gray-500">Location (DB)</th>
                              <th className="text-left px-3 py-1.5 font-medium text-gray-500">Location (AD)</th>
                              <th className="text-left px-3 py-1.5 font-medium text-gray-500">AD Title</th>
                              <th className="text-center px-3 py-1.5 font-medium text-gray-500">Action</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-gray-100">
                            {syncDetails.map((d, i) => (
                              <tr key={i} className="hover:bg-gray-50/50">
                                <td className="px-3 py-1.5 font-medium text-gray-900">{d.name}</td>
                                <td className="px-3 py-1.5 text-center">
                                  {d.photo ? <span className="text-green-600">&#10003;</span> : <span className="text-gray-300">&#10005;</span>}
                                </td>
                                <td className="px-3 py-1.5 text-gray-600">{d.locationBefore || <span className="text-gray-300 italic">none</span>}</td>
                                <td className="px-3 py-1.5 text-gray-600">{d.locationAD || <span className="text-gray-300 italic">none</span>}</td>
                                <td className="px-3 py-1.5 text-gray-500">{d.adJobTitle || '—'}</td>
                                <td className="px-3 py-1.5 text-center">
                                  {d.locationAction === 'set' && <span className="text-green-600 font-medium">Set</span>}
                                  {d.locationAction === 'overwritten' && <span className="text-amber-600 font-medium">Updated</span>}
                                  {d.locationAction === 'kept' && <span className="text-gray-400">Kept</span>}
                                  {d.locationAction === 'no_ad_data' && <span className="text-gray-300 italic">No AD data</span>}
                                  {d.locationAction === 'error' && <span className="text-red-500">Error</span>}
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
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
                            {isSavingAll ? 'Saving...' : 'Save All Schedules'}
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

            {/* Technician Visibility */}
            {activeSection === 'tech-visibility' && (
              <div className="p-6">
                <TechnicianVisibilityPanel />
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

            {/* Vacation Tracker */}
            {activeSection === 'vacation-tracker' && (
              <div className="p-6">
                <VacationTrackerPanel />
              </div>
            )}

            {/* Shared Calendar Leave */}
            {activeSection === 'calendar-leave' && (
              <div className="p-6">
                <CalendarLeavePanel />
              </div>
            )}
          </div>
        </main>
      </div>
    </div>
  );
}
