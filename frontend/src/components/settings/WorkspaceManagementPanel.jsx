import { useState, useCallback } from 'react';
import { Timer } from 'lucide-react';
import { workspaceAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import {
  Search, CheckCircle, XCircle, Plus, Loader, Globe,
  Zap, Clock, RefreshCw, Power, PowerOff, Ticket,
} from 'lucide-react';

const STATUS_BADGE = {
  active: 'bg-emerald-100 dark:bg-emerald-500/20 text-emerald-800 dark:text-emerald-200 border-emerald-300 dark:border-emerald-500/40',
  inactive: 'bg-muted text-muted-foreground border-input',
  new: 'bg-blue-100 dark:bg-blue-500/20 text-blue-800 dark:text-blue-200 border-blue-300 dark:border-blue-500/40',
};

const STATUS_LABEL = {
  active: 'Active',
  inactive: 'Inactive',
  new: 'Not onboarded',
};

export default function WorkspaceManagementPanel() {
  const { refreshWorkspaces } = useWorkspace();
  const [workspaces, setWorkspaces] = useState(null);
  const [isDiscovering, setIsDiscovering] = useState(false);
  const [activating, setActivating] = useState(null);
  const [deactivating, setDeactivating] = useState(null);
  const [togglingTicketing, setTogglingTicketing] = useState(null);
  // v3.8.91: per-workspace sync cadence (full sync + assignment fast sync).
  const [cadenceFor, setCadenceFor] = useState(null); // dbWorkspace id being edited
  const [cadence, setCadence] = useState({ syncIntervalMinutes: 5, fastSyncIntervalMinutes: 1 });
  const [savingCadence, setSavingCadence] = useState(false);
  const [error, setError] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  const discover = useCallback(async () => {
    setIsDiscovering(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const res = await workspaceAPI.discover();
      setWorkspaces(res.data || []);
    } catch (err) {
      setError(err.message || 'Failed to discover workspaces');
    } finally {
      setIsDiscovering(false);
    }
  }, []);

  const activate = useCallback(async (fsWs) => {
    setActivating(fsWs.freshserviceId);
    setError(null);
    setSuccessMsg(null);
    try {
      await workspaceAPI.activate({
        freshserviceWorkspaceId: fsWs.freshserviceId,
        name: fsWs.name,
      });
      setSuccessMsg(`"${fsWs.name}" activated! Go to the Backfill tab to import historical data.`);
      await refreshWorkspaces();
      await discover();
    } catch (err) {
      setError(err.message || 'Failed to activate workspace');
    } finally {
      setActivating(null);
    }
  }, [discover]);

  const toggleNativeTicketing = useCallback(async (ws) => {
    const dbWs = ws.dbWorkspace;
    if (!dbWs) return;
    const enabling = !dbWs.nativeTicketingEnabled;
    setTogglingTicketing(dbWs.id);
    setError(null);
    setSuccessMsg(null);
    try {
      await workspaceAPI.update(dbWs.id, { nativeTicketingEnabled: enabling });
      setSuccessMsg(
        enabling
          ? `Native ticketing enabled for "${ws.name}" — tickets can now be created inside Ticket Pulse.`
          : `Native ticketing disabled for "${ws.name}".`,
      );
      await refreshWorkspaces();
      await discover();
    } catch (err) {
      setError(err.message || 'Failed to update native ticketing');
    } finally {
      setTogglingTicketing(null);
    }
  }, [discover, refreshWorkspaces]);

  const saveCadence = useCallback(async (ws) => {
    const dbWs = ws.dbWorkspace;
    if (!dbWs) return;
    setSavingCadence(true);
    setError(null);
    setSuccessMsg(null);
    try {
      const full = Math.max(1, Math.min(1440, Math.trunc(Number(cadence.syncIntervalMinutes) || 5)));
      const fast = Math.max(1, Math.min(30, Math.trunc(Number(cadence.fastSyncIntervalMinutes) || 1)));
      await workspaceAPI.update(dbWs.id, { syncIntervalMinutes: full, fastSyncIntervalMinutes: fast });
      setSuccessMsg(`"${ws.name}" now syncs every ${full}m (full) and refreshes assignments every ${fast}m — schedules restarted.`);
      setCadenceFor(null);
      await refreshWorkspaces();
      await discover();
    } catch (err) {
      setError(err.message || 'Failed to update the sync cadence');
    } finally {
      setSavingCadence(false);
    }
  }, [cadence, discover, refreshWorkspaces]);

  const deactivate = useCallback(async (ws) => {
    const dbWs = ws.dbWorkspace;
    if (!dbWs) return;
    setDeactivating(dbWs.id);
    setError(null);
    setSuccessMsg(null);
    try {
      await workspaceAPI.update(dbWs.id, { isActive: false });
      setSuccessMsg(`"${ws.name}" deactivated. Sync stopped.`);
      await refreshWorkspaces();
      await discover();
    } catch (err) {
      setError(err.message || 'Failed to deactivate workspace');
    } finally {
      setDeactivating(null);
    }
  }, [discover]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 mb-2">
        <div className="p-2 bg-purple-100 dark:bg-purple-500/20 rounded-lg">
          <Globe className="w-5 h-5 text-purple-600 dark:text-purple-300" />
        </div>
        <div>
          <h3 className="text-lg font-semibold text-foreground">Workspace Management</h3>
          <p className="text-sm text-muted-foreground">
            Discover, activate, and manage FreshService workspaces. New workspaces are auto-detected from your FreshService account.
          </p>
        </div>
      </div>

      {/* Discover button */}
      <button
        onClick={discover}
        disabled={isDiscovering}
        className="flex items-center gap-2 px-4 py-2.5 bg-purple-600 hover:bg-purple-700 disabled:bg-purple-400 text-white font-medium rounded-lg transition-colors shadow-sm"
      >
        {isDiscovering ? <Loader className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
        {isDiscovering ? 'Discovering...' : workspaces ? 'Refresh Workspaces' : 'Discover Workspaces'}
      </button>

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg">
          <XCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
        </div>
      )}

      {successMsg && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg">
          <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-emerald-800 dark:text-emerald-200">{successMsg}</span>
        </div>
      )}

      {/* Workspace list */}
      {workspaces && (
        <div className="bg-card border border-border rounded-lg overflow-hidden">
          <div className="px-4 py-3 bg-muted/50 border-b border-border flex items-center justify-between">
            <span className="text-sm font-medium text-foreground/85">
              {workspaces.length} workspace{workspaces.length !== 1 ? 's' : ''} found in FreshService
            </span>
            <div className="flex items-center gap-3 text-xs text-muted-foreground">
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-emerald-500" /> Active: {workspaces.filter(w => w.status === 'active').length}
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-blue-500" /> New: {workspaces.filter(w => w.status === 'new').length}
              </span>
              <span className="flex items-center gap-1">
                <div className="w-2 h-2 rounded-full bg-muted-foreground/60" /> Inactive: {workspaces.filter(w => w.status === 'inactive').length}
              </span>
            </div>
          </div>

          <div className="divide-y divide-border/60">
            {workspaces.map((ws) => (
              <div key={ws.freshserviceId} className="px-4 py-3 flex items-center gap-4">
                {/* Status icon */}
                <div className="flex-shrink-0">
                  {ws.status === 'active' ? (
                    <Zap className="w-5 h-5 text-emerald-500" />
                  ) : ws.status === 'new' ? (
                    <Plus className="w-5 h-5 text-blue-500" />
                  ) : (
                    <PowerOff className="w-5 h-5 text-muted-foreground/75" />
                  )}
                </div>

                {/* Workspace info */}
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-foreground">{ws.name}</span>
                    {ws.primary && (
                      <span className="px-1.5 py-0.5 text-[10px] font-medium bg-amber-100 dark:bg-amber-500/20 text-amber-700 dark:text-amber-200 border border-amber-300 dark:border-amber-500/40 rounded">
                        Primary
                      </span>
                    )}
                    <span className={`px-1.5 py-0.5 text-[10px] font-medium border rounded ${STATUS_BADGE[ws.status]}`}>
                      {STATUS_LABEL[ws.status]}
                    </span>
                  </div>
                  <div className="text-xs text-muted-foreground mt-0.5 flex items-center gap-3">
                    <span>FS ID: {String(ws.freshserviceId)}</span>
                    {ws.dbWorkspace && (
                      <>
                        <button
                          type="button"
                          onClick={() => { setCadenceFor(ws.dbWorkspace.id); setCadence({ syncIntervalMinutes: ws.dbWorkspace.syncIntervalMinutes || 5, fastSyncIntervalMinutes: ws.dbWorkspace.fastSyncIntervalMinutes || 1 }); }}
                          title="Change how often this workspace syncs"
                          className="tp-focus-ring flex items-center gap-1 rounded hover:text-foreground"
                        >
                          <Clock className="w-3 h-3" />
                          Sync every {ws.dbWorkspace.syncIntervalMinutes}m
                          <span className="text-muted-foreground/60">·</span>
                          <Timer className="w-3 h-3" />
                          fast sync every {ws.dbWorkspace.fastSyncIntervalMinutes || 1}m
                        </button>
                        <span>Slug: {ws.dbWorkspace.slug}</span>
                      </>
                    )}
                    {ws.description && <span className="truncate max-w-[200px]">{ws.description}</span>}
                  </div>
                  {ws.dbWorkspace && cadenceFor === ws.dbWorkspace.id && (
                    <form
                      onSubmit={(e) => { e.preventDefault(); saveCadence(ws); }}
                      className="mt-2 flex flex-wrap items-end gap-3 rounded-lg border border-border bg-muted/40 px-3 py-2.5"
                      aria-label={`Sync cadence for ${ws.name}`}
                    >
                      <label className="text-[11px] font-semibold text-muted-foreground">
                        Full sync (min)
                        <input type="number" min={1} max={1440} value={cadence.syncIntervalMinutes} onChange={(e) => setCadence((c) => ({ ...c, syncIntervalMinutes: e.target.value }))} className="tp-focus-ring mt-1 block w-24 rounded-lg border border-input bg-card px-2 py-1.5 text-sm font-normal text-foreground" />
                      </label>
                      <label className="text-[11px] font-semibold text-muted-foreground">
                        Assignment fast sync (min, 1–30)
                        <input type="number" min={1} max={30} value={cadence.fastSyncIntervalMinutes} onChange={(e) => setCadence((c) => ({ ...c, fastSyncIntervalMinutes: e.target.value }))} className="tp-focus-ring mt-1 block w-24 rounded-lg border border-input bg-card px-2 py-1.5 text-sm font-normal text-foreground" />
                      </label>
                      <div className="flex items-center gap-1.5">
                        <button type="submit" disabled={savingCadence} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
                          {savingCadence ? <Loader className="w-3 h-3 animate-spin" /> : <CheckCircle className="w-3 h-3" />} Save
                        </button>
                        <button type="button" onClick={() => setCadenceFor(null)} className="tp-focus-ring rounded-lg px-2.5 py-1.5 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                      </div>
                      <p className="basis-full text-[11px] text-muted-foreground">Fast sync refreshes FreshService status/assignee changes and feeds the AI assignment lane. Every minute is the default; a quieter workspace can take 5–10.</p>
                    </form>
                  )}
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 flex-shrink-0">
                  {ws.status === 'active' && ws.dbWorkspace && (
                    <button
                      onClick={() => toggleNativeTicketing(ws)}
                      disabled={togglingTicketing === ws.dbWorkspace.id}
                      title={ws.dbWorkspace.nativeTicketingEnabled
                        ? 'Native ticketing is ON — tickets can be created inside Ticket Pulse. Click to disable.'
                        : 'Native ticketing is OFF — tickets only sync in from FreshService. Click to enable.'}
                      className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors ${
                        ws.dbWorkspace.nativeTicketingEnabled
                          ? 'bg-indigo-50 dark:bg-indigo-500/15 text-indigo-700 dark:text-indigo-200 border-indigo-200 dark:border-indigo-500/30 hover:bg-indigo-100 dark:hover:bg-indigo-500/20'
                          : 'bg-muted text-muted-foreground border-border hover:bg-secondary'
                      }`}
                    >
                      {togglingTicketing === ws.dbWorkspace.id ? (
                        <Loader className="w-3 h-3 animate-spin" />
                      ) : (
                        <Ticket className="w-3 h-3" />
                      )}
                      Native ticketing {ws.dbWorkspace.nativeTicketingEnabled ? 'on' : 'off'}
                    </button>
                  )}
                  {ws.status === 'new' && (
                    <button
                      onClick={() => activate(ws)}
                      disabled={activating === ws.freshserviceId}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-blue-600 hover:bg-blue-700 disabled:bg-blue-400 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {activating === ws.freshserviceId ? (
                        <Loader className="w-3 h-3 animate-spin" />
                      ) : (
                        <Power className="w-3 h-3" />
                      )}
                      Activate
                    </button>
                  )}
                  {ws.status === 'inactive' && (
                    <button
                      onClick={() => activate(ws)}
                      disabled={activating === ws.freshserviceId}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 disabled:bg-emerald-400 text-white text-xs font-medium rounded-lg transition-colors"
                    >
                      {activating === ws.freshserviceId ? (
                        <Loader className="w-3 h-3 animate-spin" />
                      ) : (
                        <RefreshCw className="w-3 h-3" />
                      )}
                      Re-activate
                    </button>
                  )}
                  {ws.status === 'active' && (
                    <button
                      onClick={() => deactivate(ws)}
                      disabled={deactivating === ws.dbWorkspace?.id}
                      className="flex items-center gap-1.5 px-3 py-1.5 bg-muted hover:bg-red-50 dark:hover:bg-red-500/15 text-muted-foreground hover:text-red-600 dark:hover:text-red-300 text-xs font-medium rounded-lg border border-border hover:border-red-200 dark:hover:border-red-500/30 transition-colors"
                    >
                      {deactivating === ws.dbWorkspace?.id ? (
                        <Loader className="w-3 h-3 animate-spin" />
                      ) : (
                        <PowerOff className="w-3 h-3" />
                      )}
                      Deactivate
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {!workspaces && !isDiscovering && (
        <div className="bg-muted/50 border border-border rounded-lg p-8 text-center">
          <Globe className="w-10 h-10 text-muted-foreground/50 mx-auto mb-3" />
          <p className="text-muted-foreground text-sm">Click &quot;Discover Workspaces&quot; to fetch all workspaces from your FreshService account.</p>
          <p className="text-muted-foreground/75 text-xs mt-1">New workspaces can be activated with one click. Use the Backfill tab to import historical data.</p>
        </div>
      )}
    </div>
  );
}
