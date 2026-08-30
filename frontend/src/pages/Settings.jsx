import { Fragment, useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { motion } from 'motion/react';
import { useSettings } from '../contexts/SettingsContext';
import { useWorkspace } from '../contexts/WorkspaceContext';
import { useAuth } from '../contexts/AuthContext';
import { settingsAPI, syncAPI, visualsAPI } from '../services/api';
import api from '../services/api';
import { dataCache } from '../services/dataCache';
import AutoResponseSettings from '../components/AutoResponseSettings';
import MobileTabBar from '../components/nav/MobileTabBar';
import NoiseRulesPanel from '../components/NoiseRulesPanel';
import SyncOperationsPanel from '../components/settings/SyncOperationsPanel';
import BackfillPanel from '../components/settings/BackfillPanel';
import WorkspaceManagementPanel from '../components/settings/WorkspaceManagementPanel';
import MailboxConnectionsPanel from '../components/settings/MailboxConnectionsPanel';
import MembersPanel from '../components/settings/MembersPanel';
import SignaturesPanel from '../components/settings/SignaturesPanel';
import GroupsPanel from '../components/settings/GroupsPanel';
import ApprovalCategoriesPanel from '../components/settings/ApprovalCategoriesPanel';
import TicketOpsPanel from '../components/settings/TicketOpsPanel';
import ApiKeysPanel from '../components/settings/ApiKeysPanel';
import BackupRestorePanel from '../components/settings/BackupRestorePanel';
import AiUsagePanel from '../components/settings/AiUsagePanel';
import AdminManagementPanel from '../components/settings/AdminManagementPanel';
import VacationTrackerPanel from '../components/settings/VacationTrackerPanel';
import CalendarLeavePanel from '../components/settings/CalendarLeavePanel';
import TechnicianVisibilityPanel from '../components/settings/TechnicianVisibilityPanel';
import WorkspaceAccessPanel from '../components/settings/WorkspaceAccessPanel';
import FreshServiceWebhookCard from '../components/settings/FreshServiceWebhookCard';
import AiProviderSettingsPanel from '../components/settings/AiProviderSettingsPanel';
import EmailHealthCard from '../components/settings/EmailHealthCard';
import SyncHealthCard from '../components/settings/SyncHealthCard';
import RealtimeHealthCard from '../components/settings/RealtimeHealthCard';
import PublicTicketStatusPanel from '../components/settings/PublicTicketStatusPanel';
import FeedbackPagePanel from '../components/settings/FeedbackPagePanel';
import UrgentEscalationPanel from '../components/settings/UrgentEscalationPanel';
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui';
import { cn } from '../lib/utils';
// Section-nav icons now live with the nav model in settingsNav.js — only the
// icons used directly by this page's content remain imported here.
import {
  ArrowLeft,
  Save,
  TestTube,
  RefreshCw,
  CheckCircle,
  XCircle,
  Activity,
  Users,
  Shield,
  Mail,
  MessageCircle,
  MessageSquare,
  PhoneCall,
  Send,
  PanelLeftClose,
  PanelLeftOpen,
} from 'lucide-react';
import { AssignmentConfigPanel } from './AssignmentReview';
import { filterSettingsNavItems, resolveActiveSettingsItem } from './settingsNav';
import { useWorkspaceRole } from '../components/nav/navDestinations';
import useSettingsSectionHash from '../hooks/useSettingsSectionHash';

export default function Settings() {
  const navigate = useNavigate();
  const { settings, isLoading, fetchSettings, updateSettings, testConnection } = useSettings();
  const { currentWorkspace, availableWorkspaces, switchWorkspace } = useWorkspace();
  const { user } = useAuth();

  const isGlobalAdmin = user?.role === 'admin';
  // Fails closed (null until hydrated) — the same resolver the nav uses.
  const wsRole = useWorkspaceRole();
  const isWsAdmin = wsRole === 'admin';
  // Reviewers no longer have Settings sections (v3.7.02): approval categories
  // moved to Approvals → Categories. Kept as an input to the nav filter so
  // the role model stays explicit in one place (settingsNav.js).
  const isWsReviewer = isWsAdmin || wsRole === 'reviewer';

  // The user's REQUEST (deep-link hash or nav click). What actually renders
  // is resolved against the role-filtered list below — a hash pointing at a
  // section this role can't see falls back to the first visible section.
  // Reactive to location.hash so banner deep links work from INSIDE Settings
  // (QA 08-17 #3 — the old initializer-only read made them silent no-ops).
  const [activeSection, setActiveSection] = useSettingsSectionHash();

  // Mail Workflows moved out of Settings (QA 07-06 #1) — its single home is the
  // main-nav /workflows page. Old deep links land there instead of a dead tab.
  useEffect(() => {
    if (window.location.hash.replace('#', '') === 'notification-workflows') {
      navigate('/workflows', { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [isNavCollapsed, setIsNavCollapsed] = useState(() => {
    try {
      return window.localStorage.getItem('ticketPulse.settingsNavCollapsed') === 'true';
    } catch {
      return false;
    }
  });

  const [formData, setFormData] = useState({
    freshservice_domain: '',
    freshservice_api_key: '',
    service_account_names: '',
    sendgrid_api_key: '',
    sendgrid_from_email: '',
    sendgrid_from_name: '',
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

  // Role-aware navigation (Phase A1): the list, gates, and resolution live in
  // settingsNav.js. Agents get an empty list (friendly card below); a hash
  // pointing at a hidden section falls back to the first visible one, and the
  // content pane keys off the RESOLVED item so it can never show a section
  // the sidebar doesn't offer.
  const navigationItems = filterSettingsNavItems({
    isAgent: user?.role === 'agent',
    isGlobalAdmin,
    isWsAdmin,
    isWsReviewer,
  });
  const activeNavigationItem = resolveActiveSettingsItem(navigationItems, activeSection);
  const activeSectionId = activeNavigationItem?.id ?? null;

  useEffect(() => {
    fetchSettings();
  }, [fetchSettings]);

  useEffect(() => {
    try {
      window.localStorage.setItem('ticketPulse.settingsNavCollapsed', String(isNavCollapsed));
    } catch {
      // Ignore storage failures; the nav still works for the current session.
    }
  }, [isNavCollapsed]);

  useEffect(() => {
    if (settings) {
      setFormData({
        freshservice_domain: settings.freshservice_domain || '',
        freshservice_api_key: settings.freshservice_api_key === '***MASKED***' ? '' : settings.freshservice_api_key || '',
        service_account_names: settings.service_account_names || '',
        sendgrid_api_key: settings.sendgrid_api_key === '***MASKED***' ? '' : settings.sendgrid_api_key || '',
        sendgrid_from_email: settings.sendgrid_from_email || '',
        sendgrid_from_name: settings.sendgrid_from_name || '',
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
        sendgrid_from_name: formData.sendgrid_from_name,
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
      sendgrid_from_name: formData.sendgrid_from_name,
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
          'sendgrid_from_name',
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
      const keys = sectionKeys[activeSectionId] || Object.keys(formData);
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
      <div className="tp-page-backdrop flex min-h-screen items-center justify-center">
        <div className="tp-glass-strong flex items-center gap-3 rounded-2xl border border-card/70 dark:border-white/10 px-5 py-4 text-sm font-semibold text-foreground/85">
          <Activity className="h-5 w-5 animate-spin text-blue-600 dark:text-blue-300" />
          Loading settings
        </div>
      </div>
    );
  }

  return (
    <TooltipProvider delayDuration={180}>
      <div className="tp-page-backdrop flex h-screen flex-col overflow-hidden text-foreground pb-[calc(4rem+env(safe-area-inset-bottom))] md:pb-0">
        <header className="tp-glass-strong sticky top-0 z-40 flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-card/70 dark:border-white/10 px-3 py-2.5 sm:px-6">
          <div className="flex min-w-0 items-center gap-3">
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => navigate('/dashboard')}
              className="shrink-0 text-muted-foreground hover:text-foreground"
            >
              <ArrowLeft className="h-4 w-4" />
              <span className="hidden sm:inline">Back to Dashboard</span>
            </Button>
            <div className="hidden h-5 w-px bg-muted-foreground/80 sm:block" />
            <div className="flex min-w-0 items-center gap-2">
              {activeNavigationItem?.Icon && (
                <span className="hidden h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-card/70 text-blue-700 dark:text-blue-200 ring-1 ring-border/80 sm:inline-flex">
                  <activeNavigationItem.Icon className="h-4 w-4" />
                </span>
              )}
              <div className="min-w-0">
                <h1 className="truncate text-sm font-semibold text-foreground">Settings</h1>
                <p className="hidden truncate text-xs text-muted-foreground sm:block">{activeNavigationItem?.label || 'Workspace settings'}</p>
              </div>
            </div>
          </div>
          {currentWorkspace && availableWorkspaces.length > 1 && (
            <div className="flex items-center gap-2 rounded-xl border border-card/70 dark:border-white/10 bg-card/65 px-2 py-1 shadow-subtle backdrop-blur-xl">
              <span className="hidden text-xs font-semibold uppercase tracking-wide text-muted-foreground sm:inline">Workspace</span>
              <select
                value={currentWorkspace.id}
                onChange={(e) => {
                  const newId = Number(e.target.value);
                  if (newId === currentWorkspace.id) return;
                  switchWorkspace(newId);
                  window.location.reload();
                }}
                className="min-w-[180px] rounded-lg border border-blue-100 dark:border-blue-500/20 bg-blue-50/90 dark:bg-blue-500/10 px-2.5 py-1.5 text-xs font-semibold text-blue-700 dark:text-blue-200 outline-none transition hover:bg-blue-100 dark:hover:bg-blue-500/20 focus:ring-2 focus:ring-blue-200 dark:focus:ring-blue-500/30"
                title="Switch workspace"
              >
                {availableWorkspaces.map(ws => (
                  <option key={ws.id} value={ws.id}>{ws.name}{ws.role ? ` [${ws.role}]` : ''}</option>
                ))}
              </select>
            </div>
          )}
        </header>

        <div className="flex flex-1 flex-col overflow-hidden md:flex-row">
          <motion.aside
            layout
            transition={{ type: 'spring', stiffness: 360, damping: 34 }}
            className={cn(
              'tp-glass-strong z-30 w-full shrink-0 border-b border-card/70 dark:border-white/10 md:sticky md:top-[61px] md:h-[calc(100vh-61px)] md:self-start md:border-b-0 md:border-r',
              isNavCollapsed ? 'md:w-[76px]' : 'md:w-[250px]',
            )}
          >
            <div className={cn('hidden items-center border-b border-card/65 dark:border-white/[0.08] px-3 py-3 md:flex', isNavCollapsed ? 'justify-center' : 'justify-between')}>
              {!isNavCollapsed && (
                <div>
                  <div className="text-[11px] font-bold uppercase tracking-wide text-muted-foreground">Settings</div>
                  <div className="text-xs text-muted-foreground/75">Workspace controls</div>
                </div>
              )}
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    type="button"
                    variant="ghost"
                    size="iconSm"
                    onClick={() => setIsNavCollapsed((current) => !current)}
                    aria-label={isNavCollapsed ? 'Expand settings navigation' : 'Collapse settings navigation'}
                  >
                    {isNavCollapsed ? <PanelLeftOpen className="h-4 w-4" /> : <PanelLeftClose className="h-4 w-4" />}
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="right">
                  {isNavCollapsed ? 'Expand navigation' : 'Collapse navigation'}
                </TooltipContent>
              </Tooltip>
            </div>
            <nav className="settings-scrollbar flex gap-1 overflow-x-auto p-2 md:block md:h-[calc(100%-65px)] md:space-y-1 md:overflow-y-auto">
              {navigationItems.map((item, idx) => {
                const isActive = activeSectionId === item.id;
                const isDisabled = !!item.disabled;
                // Group header when the group changes (desktop vertical nav only;
                // the mobile horizontal strip stays a flat scroll).
                const showGroupHeader = item.group && item.group !== navigationItems[idx - 1]?.group;
                const groupHeader = showGroupHeader && !isNavCollapsed ? (
                  <div key={`group-${item.group}`} className={cn('hidden px-3 pb-1 text-[10px] font-bold uppercase tracking-wide text-muted-foreground/75 md:block', idx > 0 && 'pt-3')}>
                    {item.group}
                  </div>
                ) : null;
                const navButton = (
                  <button
                    key={item.id}
                    onClick={() => setActiveSection(item.id)}
                    disabled={isDisabled}
                    className={cn(
                      'group relative flex h-11 shrink-0 items-center gap-2.5 rounded-xl px-3 text-left text-[13px] font-medium transition-all md:w-full',
                      isDisabled && 'cursor-not-allowed bg-muted/70 text-muted-foreground/75 opacity-70',
                      !isDisabled && isActive && 'bg-card/82 text-foreground shadow-subtle ring-1 ring-card/80 dark:bg-white/[0.07] dark:ring-white/10',
                      !isDisabled && !isActive && 'text-muted-foreground hover:bg-card/58 hover:text-foreground dark:hover:bg-white/[0.04]',
                      isNavCollapsed && 'md:justify-center md:px-2',
                    )}
                  >
                    {isActive && !isDisabled && (
                      <span className="absolute left-1 hidden h-6 w-1 rounded-full bg-primary md:block" />
                    )}
                    <item.Icon className={cn('h-4 w-4 shrink-0 transition-colors', isActive && !isDisabled ? 'text-blue-600 dark:text-blue-300' : 'text-muted-foreground/75 group-hover:text-muted-foreground')} />
                    <span
                      className={cn(
                        'truncate transition-all duration-200',
                        isNavCollapsed ? 'md:w-0 md:opacity-0' : 'md:w-auto md:opacity-100',
                      )}
                    >
                      {item.label}
                    </span>
                    {item.status && !isNavCollapsed && (
                      <span className="ml-auto hidden rounded-full bg-secondary/80 px-1.5 py-0.5 text-[10px] font-semibold text-muted-foreground md:inline">
                        {item.status}
                      </span>
                    )}
                  </button>
                );

                if (!isNavCollapsed) {
                  return groupHeader
                    ? <Fragment key={item.id}>{groupHeader}{navButton}</Fragment>
                    : navButton;
                }

                return (
                  <Tooltip key={item.id}>
                    <TooltipTrigger asChild>{navButton}</TooltipTrigger>
                    <TooltipContent side="right">
                      {isDisabled ? `${item.label} is in development` : item.label}
                    </TooltipContent>
                  </Tooltip>
                );
              })}
            </nav>
          </motion.aside>

          <main className="settings-scrollbar min-w-0 flex-1 overflow-x-hidden overflow-y-auto bg-transparent">
            {/* Zero visible sections (e.g. agent-role deep link): friendly
                empty state instead of a blank pane (Phase A1). */}
            {!activeNavigationItem && (
              <div className="flex min-h-full items-center justify-center p-8">
                <div className="tp-card max-w-md p-8 text-center">
                  <span className="mx-auto mb-4 inline-flex h-12 w-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground/75">
                    <Shield className="h-6 w-6" />
                  </span>
                  <h2 className="text-base font-semibold text-foreground">No settings available for your role</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Workspace settings are managed by coordinators and admins. Your
                    personal preferences live in your agent pages instead.
                  </p>
                  <Button type="button" className="mt-5" onClick={() => navigate('/tickets')}>
                    Back to Tickets
                  </Button>
                </div>
              </div>
            )}
            {activeNavigationItem && (
              <motion.div
                key={activeSectionId}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18, ease: 'easeOut' }}
                className="min-h-full min-w-0"
              >
                {/* FreshService Configuration */}
                {activeSectionId === 'freshservice' && (
                  <form onSubmit={handleSave} className="p-6 space-y-4">
                    <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
                      <h2 className="text-base font-semibold mb-4 text-foreground">FreshService Configuration</h2>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-foreground/85 mb-2">
                  FreshService Domain
                          </label>
                          <input
                            type="text"
                            name="freshservice_domain"
                            value={formData.freshservice_domain}
                            onChange={handleChange}
                            placeholder="your-company"
                            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                  Enter just the subdomain (e.g., &quot;company&quot; for company.freshservice.com)
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-foreground/85 mb-2">
                  API Key
                          </label>
                          <input
                            type="password"
                            name="freshservice_api_key"
                            value={formData.freshservice_api_key}
                            onChange={handleChange}
                            placeholder={settings?.freshservice_api_key === '***MASKED***' ? '(Configured)' : 'Enter API key'}
                            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                  Leave blank to keep existing API key
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-foreground/85 mb-1">
                  Service Account Name(s)
                          </label>
                          <input
                            type="text"
                            name="service_account_names"
                            value={formData.service_account_names}
                            onChange={handleChange}
                            placeholder="e.g. Ticket Pulse, Vahid Haeri"
                            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
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
                          <div className={`flex items-center gap-2 p-3 rounded-lg ${testStatus.success ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'}`}>
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
                      <div className={`flex items-center gap-2 p-4 rounded-lg ${saveStatus.success ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'}`}>
                        {saveStatus.success ? <CheckCircle className="w-5 h-5" /> : <XCircle className="w-5 h-5" />}
                        <span>{saveStatus.message}</span>
                      </div>
                    )}
                  </form>
                )}

                {/* FreshService Webhooks */}
                {activeSectionId === 'webhooks' && (
                  <div className="p-6 space-y-4">
                    <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
                      <div className="mb-3 flex flex-wrap items-start justify-between gap-3">
                        <div>
                          <h2 className="text-base font-semibold text-foreground">FreshService Webhooks</h2>
                          <p className="mt-1 text-sm text-muted-foreground">
                        Configure the inbound ticket webhook for {currentWorkspace?.name || 'the selected workspace'}.
                          </p>
                        </div>
                        {currentWorkspace?.slug && (
                          <span className="rounded-full border border-border bg-muted/50 px-2.5 py-1 text-xs font-medium text-muted-foreground">
                            {currentWorkspace.slug}
                          </span>
                        )}
                      </div>
                      <FreshServiceWebhookCard workspaceTimezone={formData.default_timezone} />
                    </div>
                  </div>
                )}

                {/* Notification Provider Configuration */}
                {activeSectionId === 'notification-providers' && (
                  <form onSubmit={handleSave} className="p-6 space-y-5">
                    <EmailHealthCard />
                    {/* Realtime plan Phase 3: sync liveness + sampled client
                        realtime telemetry live in the same health surface. */}
                    <SyncHealthCard />
                    <RealtimeHealthCard />
                    {!isGlobalAdmin && (
                      <div className="rounded-xl border border-border bg-muted/50 p-4 text-sm text-muted-foreground">
                      Notification <span className="font-semibold text-foreground">provider setup</span> (SendGrid / Twilio
                      credentials) is shared across all workspaces and managed by a global admin. You can monitor
                      delivery health above; contact a global admin to change provider credentials.
                      </div>
                    )}
                    {isGlobalAdmin && (
                      <div className="rounded-xl border border-border bg-card p-5 shadow-sm">
                        <div className="flex flex-wrap items-start justify-between gap-3 border-b border-border/60 pb-4">
                          <div>
                            <h2 className="text-base font-semibold text-foreground">Notification Providers</h2>
                            <p className="mt-1 text-sm text-muted-foreground">
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
                          <section className="rounded-xl border border-border bg-muted/30 p-4">
                            <div className="mb-4 flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-blue-100 dark:bg-blue-500/20 text-blue-700 dark:text-blue-200">
                                  <Mail className="h-4 w-4" />
                                </span>
                                <div>
                                  <h3 className="text-sm font-semibold text-foreground">SendGrid Email</h3>
                                  <p className="text-xs text-muted-foreground">Uses the SendGrid v3 Web API with a Bearer API key.</p>
                                </div>
                              </div>
                              <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                settings?.sendgrid_api_key === '***MASKED***' && settings?.sendgrid_from_email
                                  ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200'
                                  : 'bg-secondary text-muted-foreground'
                              }`}>
                                {settings?.sendgrid_api_key === '***MASKED***' && settings?.sendgrid_from_email ? 'Configured' : 'Not configured'}
                              </span>
                            </div>

                            <div className="grid gap-3">
                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">API key</span>
                                <input
                                  type="password"
                                  name="sendgrid_api_key"
                                  value={formData.sendgrid_api_key}
                                  onChange={handleChange}
                                  placeholder={settings?.sendgrid_api_key === '***MASKED***' ? '(Configured)' : 'SG.xxxxx'}
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                                <span className="mt-1 block text-xs text-muted-foreground">Leave blank to keep the existing key.</span>
                              </label>

                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From email</span>
                                <input
                                  type="email"
                                  name="sendgrid_from_email"
                                  value={formData.sendgrid_from_email}
                                  onChange={handleChange}
                                  placeholder="ticketpulse@example.com"
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                                <span className="mt-1 block text-xs text-muted-foreground">Must be a verified sender or domain in SendGrid.</span>
                              </label>

                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">From display name</span>
                                <input
                                  type="text"
                                  name="sendgrid_from_name"
                                  value={formData.sendgrid_from_name}
                                  onChange={handleChange}
                                  placeholder="Ticket Pulse"
                                  maxLength={80}
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                                <span className="mt-1 block text-xs text-muted-foreground">
                                  Default sender name recipients see (&quot;Ticket Pulse&quot; when blank). Workspaces can override it under Mail Workflows &rarr; Email Branding.
                                </span>
                              </label>

                              <div className="mt-2 rounded-lg border border-border bg-card p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Test email</div>
                                <div className="flex flex-col gap-2 sm:flex-row">
                                  <input
                                    type="email"
                                    value={providerTestTargets.sendgrid}
                                    onChange={(event) => handleProviderTargetChange('sendgrid', event.target.value)}
                                    placeholder="recipient@example.com"
                                    className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleProviderTest('sendgrid')}
                                    disabled={providerTesting === 'sendgrid' || !providerTestTargets.sendgrid}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    <Send className="h-4 w-4" />
                                    {providerTesting === 'sendgrid' ? 'Sending...' : 'Send Test'}
                                  </button>
                                </div>
                                {providerTestStatus.sendgrid && (
                                  <div className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                                    providerTestStatus.sendgrid.success ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200'
                                  }`}>
                                    {providerTestStatus.sendgrid.success ? <CheckCircle className="h-4 w-4 shrink-0" /> : <XCircle className="h-4 w-4 shrink-0" />}
                                    <span>{providerTestStatus.sendgrid.message}</span>
                                  </div>
                                )}
                              </div>
                            </div>
                          </section>

                          <section className="rounded-xl border border-border bg-muted/30 p-4">
                            <div className="mb-4 flex items-start justify-between gap-3">
                              <div className="flex items-center gap-2">
                                <span className="inline-flex h-9 w-9 items-center justify-center rounded-lg bg-indigo-100 dark:bg-indigo-500/20 text-indigo-700 dark:text-indigo-200">
                                  <MessageSquare className="h-4 w-4" />
                                </span>
                                <div>
                                  <h3 className="text-sm font-semibold text-foreground">Twilio SMS, WhatsApp, and Voice</h3>
                                  <p className="text-xs text-muted-foreground">WhatsApp alerts use an approved Twilio Content template.</p>
                                </div>
                              </div>
                              <div className="flex flex-wrap justify-end gap-1.5">
                                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  settings?.twilio_account_sid && settings?.twilio_auth_token === '***MASKED***' && settings?.twilio_from_number
                                    ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200'
                                    : 'bg-secondary text-muted-foreground'
                                }`}>
                                  {settings?.twilio_account_sid && settings?.twilio_auth_token === '***MASKED***' && settings?.twilio_from_number ? 'SMS/voice ready' : 'SMS/voice incomplete'}
                                </span>
                                <span className={`rounded-full px-2 py-1 text-xs font-semibold ${
                                  settings?.twilio_account_sid
                              && settings?.twilio_auth_token === '***MASKED***'
                              && settings?.twilio_whatsapp_content_sid
                              && (settings?.twilio_whatsapp_messaging_service_sid || settings?.twilio_whatsapp_sender || settings?.twilio_from_number)
                                    ? 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-700 dark:text-emerald-200'
                                    : 'bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200'
                                }`}>
                                  {settings?.twilio_whatsapp_content_sid ? 'WhatsApp template set' : 'WhatsApp template needed'}
                                </span>
                              </div>
                            </div>

                            <div className="grid gap-3">
                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Account SID</span>
                                <input
                                  type="text"
                                  name="twilio_account_sid"
                                  value={formData.twilio_account_sid}
                                  onChange={handleChange}
                                  placeholder="AC..."
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                              </label>

                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Auth token</span>
                                <input
                                  type="password"
                                  name="twilio_auth_token"
                                  value={formData.twilio_auth_token}
                                  onChange={handleChange}
                                  placeholder={settings?.twilio_auth_token === '***MASKED***' ? '(Configured)' : 'Enter auth token'}
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                                <span className="mt-1 block text-xs text-muted-foreground">Leave blank to keep the existing token.</span>
                              </label>

                              <label className="block">
                                <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Twilio phone number</span>
                                <input
                                  type="tel"
                                  name="twilio_from_number"
                                  value={formData.twilio_from_number}
                                  onChange={handleChange}
                                  placeholder="+16045550100"
                                  className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                />
                                <span className="mt-1 block text-xs text-muted-foreground">Use E.164 format.</span>
                              </label>

                              <div className="grid gap-3 rounded-lg border border-emerald-100 dark:border-emerald-500/20 bg-emerald-50/50 dark:bg-emerald-500/10 p-3">
                                <div>
                                  <div className="text-xs font-semibold uppercase tracking-wide text-emerald-700 dark:text-emerald-200">WhatsApp template</div>
                                  <p className="mt-1 text-xs text-emerald-700/80">
                              Use a Twilio-approved template for business-initiated WhatsApp tests and alerts.
                                  </p>
                                </div>

                                <label className="block">
                                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">WhatsApp sender</span>
                                  <input
                                    type="tel"
                                    name="twilio_whatsapp_sender"
                                    value={formData.twilio_whatsapp_sender}
                                    onChange={handleChange}
                                    placeholder="Defaults to Twilio phone number"
                                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <span className="mt-1 block text-xs text-muted-foreground">Optional. Use +16045550100 or whatsapp:+16045550100.</span>
                                </label>

                                <label className="block">
                                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Messaging Service SID</span>
                                  <input
                                    type="text"
                                    name="twilio_whatsapp_messaging_service_sid"
                                    value={formData.twilio_whatsapp_messaging_service_sid}
                                    onChange={handleChange}
                                    placeholder="MG..."
                                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <span className="mt-1 block text-xs text-muted-foreground">Optional. If set, Twilio selects the WhatsApp sender from the service.</span>
                                </label>

                                <label className="block">
                                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Content SID</span>
                                  <input
                                    type="text"
                                    name="twilio_whatsapp_content_sid"
                                    value={formData.twilio_whatsapp_content_sid}
                                    onChange={handleChange}
                                    placeholder="HX..."
                                    className="w-full rounded-lg border border-border bg-card px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <span className="mt-1 block text-xs text-muted-foreground">Required for WhatsApp tests and assignment alerts.</span>
                                </label>

                                <label className="block">
                                  <span className="mb-1.5 block text-xs font-semibold uppercase tracking-wide text-muted-foreground">Content variables JSON</span>
                                  <textarea
                                    name="twilio_whatsapp_content_variables"
                                    value={formData.twilio_whatsapp_content_variables}
                                    onChange={handleChange}
                                    rows={3}
                                    className="w-full rounded-lg border border-border bg-card px-3 py-2 font-mono text-xs outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <span className="mt-1 block text-xs text-muted-foreground">Default sends the full alert text as template variable 1.</span>
                                </label>
                              </div>

                              <div className="mt-2 rounded-lg border border-border bg-card p-3">
                                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">Test SMS, WhatsApp, and voice</div>
                                <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto_auto_auto]">
                                  <input
                                    type="tel"
                                    value={providerTestTargets.twilio}
                                    onChange={(event) => handleProviderTargetChange('twilio', event.target.value)}
                                    placeholder="+16045550100"
                                    className="min-w-0 flex-1 rounded-lg border border-border px-3 py-2 text-sm outline-none transition focus:border-blue-400 focus:ring-2 focus:ring-blue-100 dark:focus:ring-blue-500/30"
                                  />
                                  <button
                                    type="button"
                                    onClick={() => handleProviderTest('twilio_sms')}
                                    disabled={providerTesting === 'twilio_sms' || !providerTestTargets.twilio}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg bg-foreground px-4 text-sm font-semibold text-background hover:bg-foreground/90 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    <MessageSquare className="h-4 w-4" />
                                    {providerTesting === 'twilio_sms' ? 'Sending...' : 'Test SMS'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleProviderTest('twilio_whatsapp')}
                                    disabled={providerTesting === 'twilio_whatsapp' || !providerTestTargets.twilio}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-4 text-sm font-semibold text-emerald-800 dark:text-emerald-200 hover:bg-emerald-100 dark:hover:bg-emerald-500/20 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    <MessageCircle className="h-4 w-4" />
                                    {providerTesting === 'twilio_whatsapp' ? 'Sending...' : 'Test WhatsApp'}
                                  </button>
                                  <button
                                    type="button"
                                    onClick={() => handleProviderTest('twilio_voice')}
                                    disabled={providerTesting === 'twilio_voice' || !providerTestTargets.twilio}
                                    className="inline-flex h-10 items-center justify-center gap-2 rounded-lg border border-border bg-card px-4 text-sm font-semibold text-foreground/85 hover:bg-muted/50 disabled:cursor-not-allowed disabled:opacity-60"
                                  >
                                    <PhoneCall className="h-4 w-4" />
                                    {providerTesting === 'twilio_voice' ? 'Calling...' : 'Test Voice'}
                                  </button>
                                </div>
                                {['twilio_sms', 'twilio_whatsapp', 'twilio_voice'].map((channel) => (
                                  providerTestStatus[channel] && (
                                    <div key={channel} className={`mt-2 flex items-start gap-2 rounded-lg px-3 py-2 text-xs ${
                                      providerTestStatus[channel].success ? 'bg-emerald-50 dark:bg-emerald-500/15 text-emerald-700 dark:text-emerald-200' : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200'
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
                    )}

                    {isGlobalAdmin && saveStatus && (
                      <div className={`flex items-center gap-2 rounded-lg p-4 ${saveStatus.success ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'}`}>
                        {saveStatus.success ? <CheckCircle className="h-5 w-5" /> : <XCircle className="h-5 w-5" />}
                        <span>{saveStatus.message}</span>
                      </div>
                    )}
                  </form>
                )}

                {/* Sync Configuration */}
                {activeSectionId === 'sync' && (
                  <div className="p-6 space-y-4">
                    <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
                      <h2 className="text-base font-semibold mb-4 text-foreground">Sync Configuration</h2>

                      <div className="space-y-4">
                        <div>
                          <label className="block text-sm font-medium text-foreground/85 mb-2">
                  Sync Interval (minutes)
                          </label>
                          <input
                            type="number"
                            name="sync_interval_minutes"
                            value={formData.sync_interval_minutes}
                            onChange={handleChange}
                            min="1"
                            max="60"
                            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          />
                          <p className="text-xs text-muted-foreground mt-1">
                  How often to sync with FreshService (1-60 minutes)
                          </p>
                        </div>

                        <div>
                          <label className="block text-sm font-medium text-foreground/85 mb-2">
                  Default Timezone
                          </label>
                          <select
                            name="default_timezone"
                            value={formData.default_timezone}
                            onChange={handleChange}
                            className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                          >
                            <option value="America/Los_Angeles">Pacific (Los Angeles)</option>
                            <option value="America/Denver">Mountain (Denver)</option>
                            <option value="America/Chicago">Central (Chicago)</option>
                            <option value="America/New_York">Eastern (New York)</option>
                          </select>
                        </div>

                        {syncStatus && (
                          <div className="mt-4 p-4 bg-blue-50 dark:bg-blue-500/15 rounded-lg">
                            <p className="text-sm text-foreground/85">
                              <strong>Sync Status:</strong> {syncStatus.sync?.isRunning ? 'Running' : 'Idle'}
                            </p>
                            {syncStatus.sync?.lastSyncTime && (
                              <p className="text-sm text-muted-foreground mt-1">
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
                {activeSectionId === 'sync-ops' && <SyncOperationsPanel />}

                {/* Backfill */}
                {activeSectionId === 'backfill' && (
                  <div className="p-6">
                    <BackfillPanel />
                  </div>
                )}

                {/* Backup & Restore (config snapshots + restore wizard) */}
                {activeSectionId === 'backup-restore' && (
                  <div className="p-6">
                    <BackupRestorePanel />
                  </div>
                )}

                {/* Ticket Mailboxes (native ticketing email channel) */}
                {activeSectionId === 'ticket-mailboxes' && (
                  <div className="p-6">
                    <MailboxConnectionsPanel />
                  </div>
                )}

                {/* Members (local + FreshService) */}
                {activeSectionId === 'agents' && (
                  <div className="p-6">
                    <MembersPanel />
                  </div>
                )}

                {/* Groups (internal + FreshService) */}
                {activeSectionId === 'groups' && (
                  <div className="p-6">
                    <GroupsPanel />
                  </div>
                )}

                {/* Per-user email signatures (Phase D) */}
                {activeSectionId === 'signatures' && (
                  <div className="p-6">
                    <SignaturesPanel />
                  </div>
                )}

                {/* Approval categories (per-workspace) */}
                {activeSectionId === 'approval-categories' && (
                  <div className="p-6">
                    <ApprovalCategoriesPanel />
                  </div>
                )}

                {/* Ticket ops: SLA policies, macros, custom fields */}
                {activeSectionId === 'ticket-ops' && (
                  <div className="p-6">
                    <TicketOpsPanel />
                  </div>
                )}

                {/* Integration API keys (gap plan P3.1) */}
                {activeSectionId === 'api-keys' && (
                  <div className="p-6">
                    <ApiKeysPanel />
                  </div>
                )}

                {/* Workspaces */}
                {activeSectionId === 'workspaces' && (
                  <div className="p-6">
                    <WorkspaceManagementPanel />
                  </div>
                )}

                {/* AI Usage & Cost — super admins only, spans all workspaces */}
                {activeSectionId === 'ai-usage' && (
                  <div className="p-6">
                    <AiUsagePanel />
                  </div>
                )}

                {/* Admins */}
                {activeSectionId === 'admins' && (
                  <div className="p-6">
                    <AdminManagementPanel />
                  </div>
                )}

                {/* Workspace Access */}
                {activeSectionId === 'workspace-access' && (
                  <div className="p-6">
                    <WorkspaceAccessPanel />
                  </div>
                )}

                {/* Dashboard Configuration */}
                {activeSectionId === 'dashboard' && (
                  <div className="p-6">
                    <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
                      <h2 className="text-base font-semibold mb-4 text-foreground">Dashboard Configuration</h2>

                      <div>
                        <label className="block text-sm font-medium text-foreground/85 mb-2">
                Dashboard Refresh Interval (seconds)
                        </label>
                        <input
                          type="number"
                          name="dashboard_refresh_seconds"
                          value={formData.dashboard_refresh_seconds}
                          onChange={handleChange}
                          min="10"
                          max="300"
                          className="w-full px-4 py-2 border border-input rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent"
                        />
                        <p className="text-xs text-muted-foreground mt-1">
                How often the dashboard polls for updates (10-300 seconds)
                        </p>
                      </div>
                    </div>
                  </div>
                )}

                {/* Photos & Locations */}
                {activeSectionId === 'photos' && (
                  <div className="p-6">
                    <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
                      <h2 className="text-base font-semibold mb-1 text-foreground">Photos &amp; Locations</h2>
                      <p className="text-sm text-muted-foreground mb-4">
                    Sync technician profile photos and office locations from Azure AD (Entra ID). Locations are only updated for technicians without a manually set location.
                      </p>

                      {photoStatus && (
                        <div className="grid grid-cols-2 gap-3 mb-4">
                          <div className="p-3 bg-blue-50 dark:bg-blue-500/15 rounded-lg">
                            <p className="text-xs text-muted-foreground uppercase font-medium mb-2">Photos</p>
                            <div className="flex items-baseline gap-3">
                              <span className="text-2xl font-bold text-green-600 dark:text-green-300">{photoStatus.withPhotos}</span>
                              <span className="text-xs text-muted-foreground">with photos</span>
                              <span className="text-lg font-semibold text-muted-foreground/75">{photoStatus.withoutPhotos}</span>
                              <span className="text-xs text-muted-foreground">missing</span>
                            </div>
                          </div>
                          <div className="p-3 bg-indigo-50 dark:bg-indigo-500/15 rounded-lg">
                            <p className="text-xs text-muted-foreground uppercase font-medium mb-2">Locations</p>
                            <div className="flex items-baseline gap-3">
                              <span className="text-2xl font-bold text-indigo-600 dark:text-indigo-300">{photoStatus.withLocation ?? '—'}</span>
                              <span className="text-xs text-muted-foreground">with location</span>
                              <span className="text-lg font-semibold text-muted-foreground/75">{photoStatus.withoutLocation ?? '—'}</span>
                              <span className="text-xs text-muted-foreground">missing</span>
                            </div>
                          </div>
                        </div>
                      )}

                      {photoStatus && (
                        <p className="text-xs text-muted-foreground/75 mb-4">{photoStatus.total} active technician{photoStatus.total !== 1 ? 's' : ''} in this workspace</p>
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
                        <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer select-none">
                          <input
                            type="checkbox"
                            checked={forceLocations}
                            onChange={(e) => setForceLocations(e.target.checked)}
                            className="rounded border-input"
                          />
                      Overwrite existing locations with AD data
                        </label>
                      </div>

                      {photoSyncStatus && (
                        <div className={`flex items-start gap-2 p-3 rounded-lg ${photoSyncStatus.success ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'}`}>
                          {photoSyncStatus.success ? <CheckCircle className="w-5 h-5 mt-0.5 flex-shrink-0" /> : <XCircle className="w-5 h-5 mt-0.5 flex-shrink-0" />}
                          <span className="text-sm">{photoSyncStatus.message}</span>
                        </div>
                      )}

                      {syncDetails && syncDetails.length > 0 && (
                        <div className="mt-4 border border-border rounded-lg overflow-hidden">
                          <div className="bg-muted/50 px-4 py-2 border-b border-border">
                            <h3 className="text-xs font-semibold text-muted-foreground uppercase">Sync Details</h3>
                          </div>
                          <div className="max-h-80 overflow-y-auto">
                            <table className="w-full text-xs">
                              <thead>
                                <tr className="bg-muted/50 border-b">
                                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Name</th>
                                  <th className="text-center px-3 py-1.5 font-medium text-muted-foreground">Photo</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Location (DB)</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">Location (AD)</th>
                                  <th className="text-left px-3 py-1.5 font-medium text-muted-foreground">AD Title</th>
                                  <th className="text-center px-3 py-1.5 font-medium text-muted-foreground">Action</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-border/60">
                                {syncDetails.map((d, i) => (
                                  <tr key={i} className="hover:bg-muted/25">
                                    <td className="px-3 py-1.5 font-medium text-foreground">{d.name}</td>
                                    <td className="px-3 py-1.5 text-center">
                                      {d.photo ? <span className="text-green-600 dark:text-green-300">&#10003;</span> : <span className="text-muted-foreground/50">&#10005;</span>}
                                    </td>
                                    <td className="px-3 py-1.5 text-muted-foreground">{d.locationBefore || <span className="text-muted-foreground/50 italic">none</span>}</td>
                                    <td className="px-3 py-1.5 text-muted-foreground">{d.locationAD || <span className="text-muted-foreground/50 italic">none</span>}</td>
                                    <td className="px-3 py-1.5 text-muted-foreground">{d.adJobTitle || '—'}</td>
                                    <td className="px-3 py-1.5 text-center">
                                      {d.locationAction === 'set' && <span className="text-green-600 dark:text-green-300 font-medium">Set</span>}
                                      {d.locationAction === 'overwritten' && <span className="text-amber-600 dark:text-amber-300 font-medium">Updated</span>}
                                      {d.locationAction === 'kept' && <span className="text-muted-foreground/75">Kept</span>}
                                      {d.locationAction === 'no_ad_data' && <span className="text-muted-foreground/50 italic">No AD data</span>}
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
                {activeSectionId === 'business-hours' && (
                  <div className="p-6">
                    <AutoResponseSettings />
                  </div>
                )}


                {activeSectionId === 'public-ticket-status' && (
                  <PublicTicketStatusPanel />
                )}

                {activeSectionId === 'feedback-page' && (
                  <FeedbackPagePanel />
                )}

                {activeSectionId === 'urgent-escalation' && (
                  <UrgentEscalationPanel />
                )}

                {activeSectionId === 'ai-providers' && (
                  <div className="p-6">
                    <AiProviderSettingsPanel />
                  </div>
                )}

                {/* AI & Routing — the assignment pipeline configuration (moved
                  here from Assignment Review's Configuration tab). */}
                {activeSectionId === 'ai-routing' && (
                  <div className="p-6">
                    <AssignmentConfigPanel workspaceTimezone={currentWorkspace?.defaultTimezone || 'America/Los_Angeles'} />
                  </div>
                )}

                {/* Technician Schedules */}
                {activeSectionId === 'tech-schedules' && (
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
                        <div className={`inline-flex rounded-lg border border-border overflow-hidden ${className}`}>
                          {options.map(opt => (
                            <button
                              key={opt.value}
                              onClick={() => onChange(opt.value)}
                              className={`px-3 py-1.5 text-xs font-medium transition-all ${
                                value === opt.value
                                  ? 'bg-blue-600 text-white shadow-inner'
                                  : 'bg-card text-muted-foreground hover:bg-muted/50'
                              } ${options.indexOf(opt) > 0 ? 'border-l border-border' : ''}`}
                            >
                              {opt.label}
                            </button>
                          ))}
                        </div>
                      );

                      const TzPill = ({ value, onChange }) => (
                        <div className="inline-flex rounded-lg border border-border overflow-hidden">
                          {TZ.map((tz, i) => (
                            <button
                              key={tz.value}
                              onClick={() => onChange(tz.value)}
                              title={tz.label}
                              className={`px-2.5 py-1.5 text-xs font-bold transition-all ${
                                normTz(value) === tz.value
                                  ? `${TZ_COLORS[tz.value]} text-white shadow-inner`
                                  : 'bg-card text-muted-foreground hover:bg-muted/50'
                              } ${i > 0 ? 'border-l border-border' : ''}`}
                            >
                              {tz.short}
                            </button>
                          ))}
                        </div>
                      );

                      return (
                        <div className="space-y-5">
                          {/* Header + Apply All */}
                          <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
                            <div className="px-5 pt-5 pb-3">
                              <h2 className="text-base font-semibold text-foreground">Work Schedules</h2>
                              <p className="text-xs text-muted-foreground mt-0.5">Click to set timezone and hours per tech. Use the bar below to apply to everyone.</p>
                            </div>

                            {scheduleStatus && (
                              <div className={`mx-5 mb-3 flex items-center gap-2 p-2.5 rounded-lg text-sm ${scheduleStatus.success ? 'bg-green-50 dark:bg-green-500/15 text-green-700 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-700 dark:text-red-200'}`}>
                                {scheduleStatus.success ? <CheckCircle className="w-4 h-4" /> : <XCircle className="w-4 h-4" />}
                                {scheduleStatus.message}
                              </div>
                            )}

                            {/* Bulk controls */}
                            <div className="px-5 py-3 bg-gradient-to-r from-blue-50 dark:from-blue-500/15 to-indigo-50 dark:to-indigo-500/15 border-y border-blue-100 dark:border-blue-500/20 flex items-center gap-4 flex-wrap">
                              <span className="text-xs font-semibold text-blue-700 dark:text-blue-200 uppercase tracking-wide">Set all</span>
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
                            <div className="divide-y divide-border/60">
                              {activeTechs.map(tech => (
                                <div key={tech.id} className="px-5 py-3 flex items-center gap-4 hover:bg-muted/25 transition-colors">
                                  {/* Name */}
                                  <div className="w-[160px] flex-shrink-0">
                                    <div className="text-sm font-semibold text-foreground truncate">{tech.name}</div>
                                    <div className="text-[10px] text-muted-foreground/75">{tzLabel(tech.timezone)}</div>
                                  </div>

                                  {/* TZ pills */}
                                  <TzPill
                                    value={tech.timezone}
                                    onChange={v => handleScheduleChange(tech.id, 'timezone', v)}
                                  />

                                  {/* Start pills */}
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] text-muted-foreground/75 font-medium w-5">IN</span>
                                    <Pill
                                      options={STARTS}
                                      value={tech.workStartTime}
                                      onChange={v => handleScheduleChange(tech.id, 'workStartTime', v)}
                                    />
                                  </div>

                                  {/* End pills */}
                                  <div className="flex items-center gap-1.5">
                                    <span className="text-[10px] text-muted-foreground/75 font-medium w-6">OUT</span>
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
                            <div className="px-5 py-3 bg-muted/50 border-t border-border flex items-center justify-between">
                              <button
                                onClick={handleSaveAllSchedules}
                                disabled={isSavingAll}
                                className="flex items-center gap-2 bg-blue-600 hover:bg-blue-700 text-white px-5 py-2 rounded-lg text-sm font-semibold disabled:opacity-50 transition-colors shadow-sm"
                              >
                                <Save className="w-4 h-4" />
                                {isSavingAll ? 'Saving...' : 'Save All Schedules'}
                              </button>
                              <span className="text-xs text-muted-foreground/75">{activeTechs.length} active technicians</span>
                            </div>
                          </div>

                          {/* Inactive techs - collapsible */}
                          {inactiveTechs.length > 0 && (
                            <div className="bg-card rounded-xl shadow-sm border border-border overflow-hidden">
                              <button
                                onClick={() => setShowInactive(p => !p)}
                                className="w-full px-5 py-3 flex items-center justify-between text-left hover:bg-muted/50 transition-colors"
                              >
                                <span className="text-xs font-semibold text-muted-foreground/75 uppercase tracking-wide">
                              Inactive Technicians ({inactiveTechs.length})
                                </span>
                                <span className={`text-muted-foreground/75 text-xs transition-transform ${showInactive ? 'rotate-180' : ''}`}>&#9660;</span>
                              </button>
                              {showInactive && (
                                <div className="divide-y divide-border/60 border-t border-border/60">
                                  {inactiveTechs.map(tech => (
                                    <div key={tech.id} className="px-5 py-2.5 flex items-center gap-4 opacity-50">
                                      <div className="w-[160px] text-sm text-muted-foreground truncate">{tech.name}</div>
                                      <span className="text-xs text-muted-foreground/75">{tzShort(tech.timezone)}</span>
                                      <span className="text-xs text-muted-foreground/75">{tech.workStartTime || '—'}</span>
                                      <span className="text-xs text-muted-foreground/75">{tech.workEndTime || '—'}</span>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}

                          {techSchedules.length === 0 && (
                            <div className="bg-card rounded-xl shadow-sm border border-border p-8 text-center">
                              <p className="text-sm text-muted-foreground">No technicians found. Sync technicians first.</p>
                            </div>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {/* Technician Visibility */}
                {activeSectionId === 'tech-visibility' && (
                  <div className="p-6">
                    <TechnicianVisibilityPanel />
                  </div>
                )}

                {/* Noise Rules */}
                {activeSectionId === 'noise-rules' && (
                  <NoiseRulesPanel />
                )}

                {/* Vacation Tracker */}
                {activeSectionId === 'vacation-tracker' && (
                  <div className="p-6">
                    <VacationTrackerPanel />
                  </div>
                )}

                {/* Shared Calendar Leave */}
                {activeSectionId === 'calendar-leave' && (
                  <div className="p-6">
                    <CalendarLeavePanel />
                  </div>
                )}
              </motion.div>
            )}
          </main>
        </div>
        <MobileTabBar />
      </div>
    </TooltipProvider>
  );
}
