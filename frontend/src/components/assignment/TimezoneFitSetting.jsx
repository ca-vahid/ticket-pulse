import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { assignmentTimezoneFitAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { Segmented } from '../availability/teamViews';

/**
 * Assignment Review → Level match → Time-zone fit (QA 11-17 item 1). For
 * remote work, a closer time zone decides between people whose skill is
 * close. Sits beside Level match's mode because both reorder the AI's list.
 * Renders nothing when the API is not there (older server).
 */
const MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'live', label: 'Live' },
];
const MODE_NOTES = {
  off: 'The AI’s pick stands.',
  shadow: 'Who would go first is written on the run. Nobody’s tickets change.',
  live: 'Automatic assignments go to the closer person.',
};

export default function TimezoneFitSetting({ workspaceTimezone = 'America/Vancouver' }) {
  const [data, setData] = useState(null);
  const [missing, setMissing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);

  const load = useCallback(async () => {
    try {
      const res = await assignmentTimezoneFitAPI.get(14);
      setData(res?.data || null);
      if (!res?.data) setMissing(true);
    } catch {
      setMissing(true);
    }
  }, []);
  useEffect(() => { load(); }, [load]);

  if (missing || !data?.settings) return null;

  const { settings, tally = { total: 0, moved: 0 }, recentMoves = [] } = data;
  const live = settings.mode === 'live';

  const choose = async (mode) => {
    if (!data.canManage || saving || settings.mode === mode) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await assignmentTimezoneFitAPI.saveSettings({ mode });
      const next = res?.data?.settings;
      if (next) setData((d) => ({ ...d, settings: next }));
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not save');
    }
    setSaving(false);
  };

  return (
    <section aria-labelledby="timezone-fit-title" data-testid="timezone-fit-setting">
      <div className="flex flex-wrap items-center gap-3">
        <h4 id="timezone-fit-title" className="mr-auto flex items-center gap-1.5 text-xs font-medium text-muted-foreground">
          <Globe className="h-3.5 w-3.5" aria-hidden="true" /> Time zone fit
        </h4>
        <Segmented
          label="Time zone fit mode"
          value={settings.mode}
          onChange={choose}
          options={MODE_OPTIONS}
          disabled={!data.canManage || saving}
        />
      </div>
      <p className="mt-1 max-w-2xl text-xs text-muted-foreground">
        For remote work, when the AI’s pick is 3 hours or more from the requester, someone it listed with close skill who is at least
        2 hours closer goes first. {MODE_NOTES[settings.mode] || ''}
      </p>
      <div className="mt-1 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
        {data.canManage ? null : <span>Only an admin can change this.</span>}
        {saving ? <span role="status">Saving…</span> : null}
        {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
        {settings.updatedAt
          ? <span>Last changed {formatDateTimeInTimezone(settings.updatedAt, workspaceTimezone)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ''}.</span>
          : null}
        {settings.mode !== 'off' || tally.total > 0
          ? (
            <span data-testid="timezone-fit-tally">
              Last {data.days || 14} days: {live ? `${tally.applied ?? 0} of ${tally.total} tickets moved` : `${tally.moved} of ${tally.total} tickets would have moved`}.
            </span>
          )
          : null}
      </div>
      {recentMoves.length ? (
        <ul className="mt-2 space-y-1 text-xs">
          {recentMoves.map((m) => (
            <li key={m.runId} className="text-foreground/85">
              <Link to={`/tickets/${m.ticketId}`} className="tp-focus-ring rounded text-primary hover:underline">{m.ref}</Link>
              {' '}
              {m.sentence || m.subject}
              {m.mode === 'shadow' ? <span className="text-muted-foreground"> (shadow)</span> : null}
              {m.mode === 'live' && !m.applied && m.notAppliedReason
                ? <span className="text-muted-foreground"> (not applied: {m.notAppliedReason})</span>
                : null}
            </li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
