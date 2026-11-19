import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Globe } from 'lucide-react';
import { assignmentTimezoneFitAPI } from '../../services/api';
import ModeSwitchSection, { NotAppliedMark, ResultsHeading, ShadowMark } from './ModeSwitchSection';

/**
 * Assignment Review → Level match → Time-zone fit (QA 11-17 item 1). For
 * remote work, a closer time zone decides between people whose skill is
 * close. Sits beside Level match's mode because both reorder the AI's list.
 * Renders nothing when the API is not there (older server).
 *
 * 18 Nov 2026: same frame as Level match (ModeSwitchSection) — one switch,
 * one muted status line, then the recent results.
 */
const MODE_NOTES = {
  off: 'the AI’s pick stands.',
  shadow: 'writes who would go first on each run; nobody’s tickets change.',
  live: 'automatic assignments go to the closer person.',
};

export default function TimezoneFitSetting({ workspaceTimezone = 'America/Vancouver', className = '' }) {
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
  const days = data.days || 14;

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

  const showResults = settings.mode !== 'off' || tally.total > 0;

  return (
    <ModeSwitchSection
      id="timezone-fit"
      icon={Globe}
      title="Time zone fit"
      help="For remote work, when the AI’s pick is 3 hours or more from the requester, someone it listed with close skill who is at least 2 hours closer goes first."
      mode={settings.mode}
      notes={MODE_NOTES}
      onChange={choose}
      canManage={data.canManage}
      saving={saving}
      saveError={saveError}
      updatedAt={settings.updatedAt}
      updatedBy={settings.updatedBy}
      workspaceTimezone={workspaceTimezone}
      className={className}
      testId="timezone-fit-setting"
    >
      {showResults ? (
        <div aria-labelledby="timezone-fit-results" role="region">
          <ResultsHeading id="timezone-fit-results">Last {days} days</ResultsHeading>
          <p className="text-xs text-foreground/85" data-testid="timezone-fit-tally">
            {live ? `${tally.applied ?? 0} of ${tally.total} tickets moved.` : `${tally.moved} of ${tally.total} tickets would have moved.`}
          </p>
        </div>
      ) : null}
      {recentMoves.length ? (
        <div aria-labelledby="timezone-fit-runs" role="region">
          <ResultsHeading id="timezone-fit-runs">Tickets</ResultsHeading>
          <ul className="space-y-1 text-xs">
            {recentMoves.map((m) => (
              <li key={m.runId} className="text-foreground/85">
                <Link to={`/tickets/${m.ticketId}`} className="tp-focus-ring rounded text-primary hover:underline">{m.ref}</Link>
                {' '}
                {m.sentence || m.subject}
                {m.mode === 'shadow' ? <ShadowMark /> : null}
                {m.mode === 'live' && !m.applied && m.notAppliedReason ? <NotAppliedMark reason={m.notAppliedReason} /> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </ModeSwitchSection>
  );
}
