import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Gauge, RefreshCw } from 'lucide-react';
import { assignmentLevelMatchAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import TimezoneFitSetting from './TimezoneFitSetting';
import ModeSwitchSection, { ResultsHeading, ShadowMark } from './ModeSwitchSection';

/**
 * Assignment Review → Level match (26 Oct 2026). The AI judges the level a
 * request needs; among the people it listed who meet that level, the one with
 * the lightest day gets it — extra skill gives no edge. Shadow only records.
 * Results are counts and a plain list of tickets — never a ranking of people.
 *
 * 18 Nov 2026 (QA: "unify the look"): Level match and Time zone fit share
 * one frame (ModeSwitchSection) — the same Off / Shadow / Live switch, a
 * one-line muted status, then the recent results.
 */
const PERIODS = [7, 14, 30];
const MODE_NOTES = {
  off: 'the AI’s own pick stands; the level is not asked for.',
  shadow: 'judges the level and writes who it would choose on each run; nobody’s tickets change.',
  live: 'automatic assignments go to the qualified person with the lightest day.',
};
const OUTCOME_WORDS = { moved: 'Would have moved', kept: 'Kept', no_level: 'No level judged', no_skill: 'Nobody listed holds the skill' };
const LEVEL_ORDER = ['basic', 'intermediate', 'advanced', 'expert'];

function Fact({ label, value, note }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

export default function LevelMatchTab({ workspaceTimezone = 'America/Vancouver' }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [onlyMoves, setOnlyMoves] = useState(true);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await assignmentLevelMatchAPI.get(days);
      setData(res?.data || null);
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load Level match');
    }
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const choose = async (mode) => {
    if (!data?.canManage || saving || data.settings?.mode === mode) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await assignmentLevelMatchAPI.saveSettings({ mode });
      const next = res?.data?.settings;
      if (next) setData((d) => ({ ...d, settings: next }));
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not save');
    }
    setSaving(false);
  };

  if (!data && loading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  }
  if (!data) {
    return <p className="py-10 text-sm text-destructive" role="alert">{error || 'Could not load Level match'}</p>;
  }

  const { settings, tally, runs = [] } = data;
  const live = settings.mode === 'live';
  const shown = onlyMoves ? runs.filter((r) => r.outcome === 'moved') : runs;
  const levelMix = LEVEL_ORDER.filter((l) => tally.byLevel?.[l]).map((l) => `${tally.byLevel[l]} ${l}`).join(', ');

  return (
    <div className="divide-y divide-border" data-testid="level-match-tab">
      <ModeSwitchSection
        id="level-match"
        icon={Gauge}
        title="Level match"
        help="The AI judges the skill level a request needs; among the people it listed who have that level or above, the one with the fewest tickets today gets it. Extra skill gives no edge."
        mode={settings.mode}
        notes={MODE_NOTES}
        onChange={choose}
        canManage={data.canManage}
        saving={saving}
        saveError={saveError}
        updatedAt={settings.updatedAt}
        updatedBy={settings.updatedBy}
        neverChanged={`Never changed: ${settings.mode === 'shadow' ? 'IT starts in Shadow.' : 'starts off.'}`}
        footnote="It never overrides an urgent ticket, an escalation, a share, or a person on leave, off shift, or with a routing note."
        workspaceTimezone={workspaceTimezone}
        className="pb-6"
      >
        <div aria-labelledby="level-match-results" role="region">
          <ResultsHeading
            id="level-match-results"
            right={(
              <div className="flex items-center gap-3 text-xs" role="group" aria-label="Period">
                {PERIODS.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => setDays(p)}
                    aria-pressed={days === p}
                    className={`tp-focus-ring rounded px-1 py-0.5 ${days === p ? 'font-semibold text-foreground underline underline-offset-4' : 'text-muted-foreground hover:text-foreground'}`}
                  >
                    {p} days
                  </button>
                ))}
                <button type="button" onClick={load} className="tp-focus-ring rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Refresh">
                  <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
                </button>
              </div>
            )}
          >
            Last {days} days
          </ResultsHeading>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
            <Fact label="Tickets judged" value={tally.total} note={levelMix || 'none yet'} />
            <Fact label={live ? 'Moved' : 'Would have moved'} value={tally.moved} note="to a qualified person with a lighter day" />
            <Fact label="Kept" value={tally.kept} note="the AI’s pick was already right" />
            <Fact label="Not judged" value={tally.noLevel + tally.noSkill} note={`${tally.noLevel} no level, ${tally.noSkill} no skill listed`} />
          </dl>
        </div>

        <div aria-labelledby="level-match-runs" role="region">
          <ResultsHeading
            id="level-match-runs"
            right={(
              <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
                <input type="checkbox" checked={onlyMoves} onChange={(e) => setOnlyMoves(e.target.checked)} className="tp-focus-ring h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
                {live ? 'Only tickets that moved' : 'Only tickets that would have moved'}
              </label>
            )}
          >
            Tickets
          </ResultsHeading>
          {shown.length === 0 ? (
            <p className="text-xs text-muted-foreground/75">
              {settings.mode === 'off' ? 'Level match is off.' : 'Nothing yet. Every automatic assignment the rule looks at is listed here.'}
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[720px] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">When</th>
                    <th className="py-1 pr-3 font-medium">Ticket</th>
                    <th className="py-1 pr-3 font-medium">Needs</th>
                    <th className="py-1 pr-3 font-medium">AI pick</th>
                    <th className="py-1 font-medium">Level match</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map((r) => (
                    <tr key={r.runId} className="border-b border-border/60 align-top">
                      <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-muted-foreground">{formatDateTimeInTimezone(r.at, workspaceTimezone)}</td>
                      <td className="max-w-[20rem] truncate py-1 pr-3">
                        <Link to={`/tickets/${r.ticketId}`} className="tp-focus-ring rounded text-primary hover:underline">{r.ref}</Link>
                        {r.subject ? <span className="text-foreground/85"> {r.subject}</span> : null}
                      </td>
                      <td className="max-w-[16rem] py-1 pr-3 text-foreground/85">
                        {r.requiredLevel || '—'}
                        {r.requiredLevelReason ? <span className="block truncate text-muted-foreground" title={r.requiredLevelReason}>{r.requiredLevelReason}</span> : null}
                      </td>
                      <td className="whitespace-nowrap py-1 pr-3 text-foreground/85">{r.from?.techName || '—'}</td>
                      <td className="max-w-[26rem] py-1 text-foreground/85">
                        <span className="whitespace-nowrap">
                          {r.outcome === 'moved' ? (r.to?.techName || '—') : <span className="text-muted-foreground">{OUTCOME_WORDS[r.outcome] || r.outcome}</span>}
                          {r.outcome === 'moved' && !r.applied ? <ShadowMark /> : null}
                        </span>
                        {/* QA 11-23: the rule's own sentence, readable in the row (it was only a tooltip). */}
                        {r.sentence ? <span className="mt-0.5 block whitespace-normal break-words text-muted-foreground" data-testid="level-match-sentence">{r.sentence}</span> : null}
                        {r.outcome === 'kept' && r.skipReason && !String(r.sentence || '').includes(String(r.skipReason).replace(/^kept:\s*/i, ''))
                          ? <span className="mt-0.5 block whitespace-normal break-words text-muted-foreground" data-testid="level-match-skip-reason">{r.skipReason.replace(/^kept:\s*/i, 'Kept: ')}</span>
                          : null}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </ModeSwitchSection>

      <TimezoneFitSetting workspaceTimezone={workspaceTimezone} className="pt-6" />
    </div>
  );
}
