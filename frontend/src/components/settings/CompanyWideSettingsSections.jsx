import { CheckCircle, Lock, RefreshCw, Save, XCircle } from 'lucide-react';

/**
 * Company-wide settings (22 Nov 2026): the generic settings writers
 * (PUT /api/settings, PUT /api/settings/:key) refuse every global key to
 * anyone but a super admin. The Settings page shows those fields read-only to
 * workspace admins, with the same sentence the server answers, instead of
 * letting a save fail. "Super admin" is the global `admin` role
 * (user.role === 'admin'), the flag the super-admin-only sections use.
 */
export const COMPANY_WIDE_SETTINGS_MESSAGE = 'Only a super admin can change company-wide settings.';

export function CompanyWideReadOnlyNote({ id }) {
  return (
    <p id={id} className="flex items-center gap-1.5 text-xs text-muted-foreground" data-testid="company-wide-readonly">
      <Lock className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      {COMPANY_WIDE_SETTINGS_MESSAGE}
    </p>
  );
}

const FIELD = 'w-full px-4 py-2 border border-input bg-card text-foreground rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-transparent disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground';

function SaveStatus({ status }) {
  if (!status) return null;
  return (
    <div role="status" className={`flex items-center gap-2 p-4 rounded-lg ${status.success ? 'bg-green-50 dark:bg-green-500/15 text-green-800 dark:text-green-200' : 'bg-red-50 dark:bg-red-500/15 text-red-800 dark:text-red-200'}`}>
      {status.success ? <CheckCircle className="w-5 h-5" aria-hidden="true" /> : <XCircle className="w-5 h-5" aria-hidden="true" />}
      <span>{status.message}</span>
    </div>
  );
}

function SaveButton({ isSaving }) {
  return (
    <button
      type="submit"
      disabled={isSaving}
      className="tp-focus-ring flex items-center gap-2 bg-primary hover:bg-blue-700 text-primary-foreground px-4 py-2 rounded-lg font-semibold disabled:opacity-50"
    >
      <Save className="w-4 h-4" aria-hidden="true" />
      {isSaving ? 'Saving...' : 'Save Settings'}
    </button>
  );
}

/** Settings → Sync Settings: interval and default time zone (global keys). */
export function SyncSettingsSection({
  formData, onChange, onSubmit, canEdit, isSaving = false, saveStatus = null, syncStatus = null, onTriggerSync,
}) {
  const noteId = canEdit ? undefined : 'sync-company-wide-note';
  return (
    <form onSubmit={onSubmit} className="p-6 space-y-4">
      <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
        <h2 className="text-base font-semibold mb-4 text-foreground">Sync Configuration</h2>

        <div className="space-y-4">
          {!canEdit && <CompanyWideReadOnlyNote id={noteId} />}
          <div>
            <label htmlFor="sync_interval_minutes" className="block text-sm font-medium text-foreground/85 mb-2">
              Sync Interval (minutes)
            </label>
            <input
              id="sync_interval_minutes"
              type="number"
              name="sync_interval_minutes"
              value={formData.sync_interval_minutes}
              onChange={onChange}
              min="1"
              max="60"
              disabled={!canEdit}
              aria-describedby={noteId}
              className={FIELD}
            />
            <p className="text-xs text-muted-foreground mt-1">How often to sync with FreshService (1-60 minutes)</p>
          </div>

          <div>
            <label htmlFor="default_timezone" className="block text-sm font-medium text-foreground/85 mb-2">
              Default Timezone
            </label>
            <select
              id="default_timezone"
              name="default_timezone"
              value={formData.default_timezone}
              onChange={onChange}
              disabled={!canEdit}
              aria-describedby={noteId}
              className={FIELD}
            >
              <option value="America/Vancouver">Pacific (Vancouver)</option>
              <option value="America/Edmonton">Mountain (Edmonton)</option>
              <option value="America/Toronto">Eastern (Toronto)</option>
              <option value="America/Halifax">Atlantic (Halifax)</option>
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

          <div className="flex flex-wrap items-center gap-2">
            {canEdit && <SaveButton isSaving={isSaving} />}
            <button
              type="button"
              onClick={onTriggerSync}
              className="tp-focus-ring flex items-center gap-2 bg-green-600 hover:bg-green-700 text-white px-4 py-2 rounded-lg"
            >
              <RefreshCw className="w-4 h-4" aria-hidden="true" />
              Trigger Manual Sync
            </button>
          </div>
        </div>
      </div>
      <SaveStatus status={saveStatus} />
    </form>
  );
}

/** Settings → Dashboard: the refresh interval (a global key). */
export function DashboardSettingsSection({ formData, onChange, onSubmit, canEdit, isSaving = false, saveStatus = null }) {
  const noteId = canEdit ? undefined : 'dashboard-company-wide-note';
  return (
    <form onSubmit={onSubmit} className="p-6 space-y-4">
      <div className="bg-card rounded-lg shadow-sm p-5 border border-border">
        <h2 className="text-base font-semibold mb-4 text-foreground">Dashboard Configuration</h2>

        <div className="space-y-4">
          {!canEdit && <CompanyWideReadOnlyNote id={noteId} />}
          <div>
            <label htmlFor="dashboard_refresh_seconds" className="block text-sm font-medium text-foreground/85 mb-2">
              Dashboard Refresh Interval (seconds)
            </label>
            <input
              id="dashboard_refresh_seconds"
              type="number"
              name="dashboard_refresh_seconds"
              value={formData.dashboard_refresh_seconds}
              onChange={onChange}
              min="10"
              max="300"
              disabled={!canEdit}
              aria-describedby={noteId}
              className={FIELD}
            />
            <p className="text-xs text-muted-foreground mt-1">How often the dashboard polls for updates (10-300 seconds)</p>
          </div>
          {canEdit && <SaveButton isSaving={isSaving} />}
        </div>
      </div>
      <SaveStatus status={saveStatus} />
    </form>
  );
}
