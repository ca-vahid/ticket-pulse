import { useState, useEffect, useCallback } from 'react';
import { vacationTrackerAPI, dashboardAPI } from '../../services/api';
import {
  CalendarDays, Key, CheckCircle, XCircle, Loader, RefreshCw,
  Users, Link2, Unlink, Save, Zap, ArrowRight,
} from 'lucide-react';

const CATEGORIES = [
  { value: 'OFF', label: 'OFF', desc: 'Vacation / PTO / Sick', color: 'bg-amber-100 text-amber-800 border-amber-300' },
  { value: 'WFH', label: 'WFH', desc: 'Work From Home', color: 'bg-teal-100 text-teal-800 border-teal-300' },
  { value: 'OTHER', label: 'OTHER', desc: 'Training / Site Visit', color: 'bg-purple-100 text-purple-800 border-purple-300' },
  { value: 'IGNORED', label: 'IGNORED', desc: 'Don\'t track', color: 'bg-gray-100 text-gray-500 border-gray-300' },
];

export default function VacationTrackerPanel() {
  const [tab, setTab] = useState('connection');
  const [config, setConfig] = useState(null);
  const [apiKey, setApiKey] = useState('');
  const [testResult, setTestResult] = useState(null);
  const [isTesting, setIsTesting] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  const [leaveTypes, setLeaveTypes] = useState([]);
  const [leaveTypeDirty, setLeaveTypeDirty] = useState(false);
  const [isSyncingTypes, setIsSyncingTypes] = useState(false);
  const [isSavingTypes, setIsSavingTypes] = useState(false);

  const [userMappings, setUserMappings] = useState([]);
  const [technicians, setTechnicians] = useState([]);
  const [isSyncingUsers, setIsSyncingUsers] = useState(false);

  const [isSyncing, setIsSyncing] = useState(false);
  const [syncResult, setSyncResult] = useState(null);

  const fetchConfig = useCallback(async () => {
    try {
      const res = await vacationTrackerAPI.getConfig();
      setConfig(res?.data || null);
    } catch { /* not configured yet */ }
  }, []);

  const fetchLeaveTypes = useCallback(async () => {
    try {
      const res = await vacationTrackerAPI.getLeaveTypes();
      setLeaveTypes(res?.data || []);
    } catch { /* empty */ }
  }, []);

  const fetchUsers = useCallback(async () => {
    try {
      const res = await vacationTrackerAPI.getUsers();
      setUserMappings(res?.data || []);
    } catch { /* empty */ }
  }, []);

  const fetchTechnicians = useCallback(async () => {
    try {
      const res = await dashboardAPI.getDashboard();
      const techs = (res?.data?.technicians || []).map(t => ({ id: t.id, name: t.name, email: t.email }));
      setTechnicians(techs);
    } catch { /* empty */ }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchLeaveTypes();
    fetchUsers();
    fetchTechnicians();
  }, [fetchConfig, fetchLeaveTypes, fetchUsers, fetchTechnicians]);

  const handleTestConnection = async () => {
    setIsTesting(true);
    setTestResult(null);
    try {
      const key = apiKey || undefined;
      const res = await vacationTrackerAPI.testConnection(key);
      setTestResult(res);
    } catch (err) {
      setTestResult({ success: false, error: err.message });
    } finally {
      setIsTesting(false);
    }
  };

  const handleSaveConfig = async () => {
    setIsSaving(true);
    setSaveMsg(null);
    try {
      const data = {};
      if (apiKey) data.apiKey = apiKey;
      data.syncEnabled = true;
      await vacationTrackerAPI.updateConfig(data);
      setSaveMsg({ ok: true, text: 'Configuration saved' });
      setApiKey('');
      fetchConfig();
    } catch (err) {
      setSaveMsg({ ok: false, text: err.message });
    } finally {
      setIsSaving(false);
    }
  };

  const handleSyncLeaveTypes = async () => {
    setIsSyncingTypes(true);
    try {
      await vacationTrackerAPI.syncLeaveTypes();
      await fetchLeaveTypes();
    } catch { /* */ }
    setIsSyncingTypes(false);
  };

  const handleSaveLeaveTypes = async () => {
    setIsSavingTypes(true);
    try {
      const mappings = leaveTypes.map(lt => ({ id: lt.id, category: lt.category }));
      await vacationTrackerAPI.updateLeaveTypeMappings(mappings);
      setLeaveTypeDirty(false);
    } catch { /* */ }
    setIsSavingTypes(false);
  };

  const handleSyncUsers = async () => {
    setIsSyncingUsers(true);
    try {
      await vacationTrackerAPI.syncUsers();
      await fetchUsers();
    } catch { /* */ }
    setIsSyncingUsers(false);
  };

  const handleMatchUser = async (mappingId, technicianId) => {
    try {
      await vacationTrackerAPI.matchUser(mappingId, technicianId || null);
      await fetchUsers();
    } catch { /* */ }
  };

  const handleFullSync = async () => {
    setIsSyncing(true);
    setSyncResult(null);
    try {
      const res = await vacationTrackerAPI.triggerSync();
      setSyncResult(res?.data || { success: true });
    } catch (err) {
      setSyncResult({ error: err.message });
    } finally {
      setIsSyncing(false);
    }
  };

  const tabs = [
    { id: 'connection', label: 'Connection', Icon: Key },
    { id: 'leave-types', label: 'Leave Types', Icon: CalendarDays },
    { id: 'user-matching', label: 'User Matching', Icon: Users },
  ];

  const matched = userMappings.filter(m => m.matchStatus !== 'unmatched').length;
  const unmatched = userMappings.filter(m => m.matchStatus === 'unmatched').length;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-amber-100 rounded-lg">
          <CalendarDays className="w-5 h-5 text-amber-600" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-gray-900">Vacation Tracker</h3>
          <p className="text-sm text-gray-500">
            Sync leave data from Vacation Tracker to show who is OFF, WFH, or on training.
          </p>
        </div>
        {config?.hasApiKey && (
          <button
            onClick={handleFullSync}
            disabled={isSyncing}
            className="ml-auto flex items-center gap-2 px-4 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-sm font-medium rounded-lg transition-colors"
          >
            {isSyncing ? <Loader className="w-4 h-4 animate-spin" /> : <Zap className="w-4 h-4" />}
            {isSyncing ? 'Syncing...' : 'Sync Now'}
          </button>
        )}
      </div>

      {syncResult && (
        <div className={`p-3 rounded-lg border text-sm ${syncResult.error ? 'bg-red-50 border-red-200 text-red-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
          {syncResult.error
            ? `Sync failed: ${syncResult.error}`
            : `Sync complete: ${syncResult.leavesProcessed || 0} leave requests processed, ${syncResult.leaveDaysCreated || 0} day records created`}
        </div>
      )}

      {/* Tab navigation */}
      <div className="flex gap-1 bg-gray-100 p-1 rounded-lg">
        {tabs.map(({ id, label, Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-md transition-colors flex-1 justify-center ${
              tab === id ? 'bg-white text-gray-900 shadow-sm' : 'text-gray-500 hover:text-gray-700'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
            {id === 'user-matching' && unmatched > 0 && (
              <span className="ml-1 px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700 rounded-full">{unmatched}</span>
            )}
          </button>
        ))}
      </div>

      {/* Connection Tab */}
      {tab === 'connection' && (
        <div className="space-y-4">
          <div className="bg-white border border-gray-200 rounded-lg p-4 space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-1">API Key</label>
              <div className="flex gap-2">
                <input
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder={config?.hasApiKey ? '••••••••••••• (saved)' : 'Enter your Vacation Tracker API key'}
                  className="flex-1 px-3 py-2 border border-gray-300 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 focus:border-amber-500"
                />
                <button
                  onClick={handleTestConnection}
                  disabled={isTesting}
                  className="flex items-center gap-1.5 px-3 py-2 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 text-gray-700 text-sm font-medium rounded-lg border border-gray-300 transition-colors"
                >
                  {isTesting ? <Loader className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
                  Test
                </button>
                <button
                  onClick={handleSaveConfig}
                  disabled={isSaving}
                  className="flex items-center gap-1.5 px-3 py-2 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-sm font-medium rounded-lg transition-colors"
                >
                  {isSaving ? <Loader className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
                  Save
                </button>
              </div>
            </div>

            {testResult && (
              <div className={`flex items-center gap-2 p-3 rounded-lg border text-sm ${testResult.success ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {testResult.success ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                <span className={testResult.success ? 'text-emerald-800' : 'text-red-800'}>
                  {testResult.success ? 'Connection successful!' : `Connection failed: ${testResult.error || 'Unknown error'}`}
                </span>
              </div>
            )}

            {saveMsg && (
              <div className={`flex items-center gap-2 p-3 rounded-lg border text-sm ${saveMsg.ok ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200'}`}>
                {saveMsg.ok ? <CheckCircle className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-red-600" />}
                <span className={saveMsg.ok ? 'text-emerald-800' : 'text-red-800'}>{saveMsg.text}</span>
              </div>
            )}

            {config && (
              <div className="text-xs text-gray-500 flex items-center gap-4 pt-2 border-t border-gray-100">
                <span>Status: {config.syncEnabled ? 'Enabled' : 'Disabled'}</span>
                {config.lastSyncAt && <span>Last sync: {new Date(config.lastSyncAt).toLocaleString()}</span>}
              </div>
            )}
          </div>

          {config?.hasApiKey && (
            <div className="bg-blue-50 border border-blue-200 rounded-lg p-4 text-sm text-blue-800">
              <p className="font-medium mb-1">Setup steps:</p>
              <ol className="list-decimal list-inside space-y-1 text-blue-700">
                <li className={leaveTypes.length > 0 ? 'line-through opacity-60' : ''}>
                  Go to <strong>Leave Types</strong> tab and sync, then categorize each type
                </li>
                <li className={userMappings.length > 0 ? 'line-through opacity-60' : ''}>
                  Go to <strong>User Matching</strong> tab to link VT users to technicians
                </li>
                <li>Click <strong>Sync Now</strong> to pull leave data</li>
              </ol>
            </div>
          )}
        </div>
      )}

      {/* Leave Types Tab */}
      {tab === 'leave-types' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">Map each Vacation Tracker leave type to a dashboard category.</p>
            <div className="flex gap-2">
              <button
                onClick={handleSyncLeaveTypes}
                disabled={isSyncingTypes}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 text-gray-700 text-xs font-medium rounded-lg border border-gray-300 transition-colors"
              >
                {isSyncingTypes ? <Loader className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
                Fetch from VT
              </button>
              {leaveTypeDirty && (
                <button
                  onClick={handleSaveLeaveTypes}
                  disabled={isSavingTypes}
                  className="flex items-center gap-1.5 px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-xs font-medium rounded-lg transition-colors"
                >
                  {isSavingTypes ? <Loader className="w-3 h-3 animate-spin" /> : <Save className="w-3 h-3" />}
                  Save Mappings
                </button>
              )}
            </div>
          </div>

          {leaveTypes.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
              <CalendarDays className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">No leave types synced yet. Click "Fetch from VT" to load them.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Leave Type</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">VT Color</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Category</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Active</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {leaveTypes.map((lt) => (
                    <tr key={lt.id} className="hover:bg-gray-50/50">
                      <td className="px-4 py-2.5 font-medium text-gray-900">{lt.vtLeaveTypeName}</td>
                      <td className="px-4 py-2.5">
                        {lt.color && (
                          <div className="flex items-center gap-2">
                            <div className="w-4 h-4 rounded-full border border-gray-200" style={{ backgroundColor: lt.color }} />
                            <span className="text-gray-500 text-xs">{lt.color}</span>
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={lt.category}
                          onChange={(e) => {
                            setLeaveTypes(prev => prev.map(item =>
                              item.id === lt.id ? { ...item, category: e.target.value } : item,
                            ));
                            setLeaveTypeDirty(true);
                          }}
                          className="px-2 py-1 border border-gray-300 rounded text-xs font-medium focus:ring-2 focus:ring-amber-500"
                        >
                          {CATEGORIES.map(c => (
                            <option key={c.value} value={c.value}>{c.label} - {c.desc}</option>
                          ))}
                        </select>
                      </td>
                      <td className="px-4 py-2.5">
                        <span className={`inline-block w-2 h-2 rounded-full ${lt.isActive ? 'bg-emerald-500' : 'bg-gray-300'}`} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* User Matching Tab */}
      {tab === 'user-matching' && (
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-600">
              Match Vacation Tracker users to Ticket Pulse technicians.
              <span className="ml-2 text-xs text-gray-400">
                {matched} matched, {unmatched} unmatched of {userMappings.length} users
              </span>
            </p>
            <button
              onClick={handleSyncUsers}
              disabled={isSyncingUsers}
              className="flex items-center gap-1.5 px-3 py-1.5 bg-gray-100 hover:bg-gray-200 disabled:bg-gray-50 text-gray-700 text-xs font-medium rounded-lg border border-gray-300 transition-colors"
            >
              {isSyncingUsers ? <Loader className="w-3 h-3 animate-spin" /> : <RefreshCw className="w-3 h-3" />}
              Sync & Auto-Match
            </button>
          </div>

          {userMappings.length === 0 ? (
            <div className="bg-gray-50 border border-gray-200 rounded-lg p-8 text-center">
              <Users className="w-10 h-10 text-gray-300 mx-auto mb-3" />
              <p className="text-gray-500 text-sm">No users synced yet. Click "Sync & Auto-Match" to fetch VT users and auto-match by email.</p>
            </div>
          ) : (
            <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
              <table className="w-full text-sm">
                <thead>
                  <tr className="bg-gray-50 border-b border-gray-200">
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">VT User</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Email</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Status</th>
                    <th className="text-left px-4 py-2.5 font-medium text-gray-600">Matched Technician</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100">
                  {userMappings.map((m) => (
                    <tr key={m.id} className={`hover:bg-gray-50/50 ${m.matchStatus === 'unmatched' ? 'bg-amber-50/30' : ''}`}>
                      <td className="px-4 py-2.5 font-medium text-gray-900">{m.vtUserName}</td>
                      <td className="px-4 py-2.5 text-gray-500 text-xs">{m.vtUserEmail}</td>
                      <td className="px-4 py-2.5">
                        {m.matchStatus === 'unmatched' ? (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-red-100 text-red-700 border border-red-300 rounded">
                            <Unlink className="w-3 h-3" /> Unmatched
                          </span>
                        ) : (
                          <span className="inline-flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium bg-emerald-100 text-emerald-700 border border-emerald-300 rounded">
                            <Link2 className="w-3 h-3" /> {m.matchStatus === 'auto_matched' ? 'Auto' : 'Manual'}
                          </span>
                        )}
                      </td>
                      <td className="px-4 py-2.5">
                        <select
                          value={m.technicianId || ''}
                          onChange={(e) => handleMatchUser(m.id, e.target.value ? parseInt(e.target.value, 10) : null)}
                          className={`px-2 py-1 border rounded text-xs font-medium focus:ring-2 focus:ring-amber-500 ${
                            m.matchStatus === 'unmatched' ? 'border-red-300 bg-red-50' : 'border-gray-300'
                          }`}
                        >
                          <option value="">-- Select technician --</option>
                          {technicians.map(t => (
                            <option key={t.id} value={t.id}>{t.name}</option>
                          ))}
                        </select>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
