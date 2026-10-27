import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, Gauge, RefreshCw } from 'lucide-react';
import { assignmentLevelMatchAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

/**
 * Assignment Review → Level match (26 Oct 2026). The AI judges the level a
 * request needs; among the people it listed who meet that level, the one with
 * the lightest day gets it — extra skill gives no edge. Shadow only records.
 * Results are counts and a plain list of tickets — never a ranking of people.
 */
const PERIODS = [7, 14, 30];
const MODES = [
  { id: 'off', label: 'Off', note: 'The AI’s own pick stands. The level is not asked for.' },
  { id: 'shadow', label: 'Shadow', note: 'The level is judged and who the rule would pick is recorded below. Nobody’s tickets change.' },
  { id: 'live', label: 'Live', note: 'Automatic assignments go to the qualified person with the lightest day.' },
];
const OUTCOME_WORDS = { moved: 'Would move', kept: 'Kept', no_level: 'No level judged', no_skill: 'Nobody listed holds the skill' };
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
    <div className="space-y-6" data-testid="level-match-tab">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Gauge className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Level match
          </h3>
          <p className="max-w-2xl text-xs text-muted-foreground">
            The AI judges the skill level each request needs. Everyone it listed who holds the skill at that level or above
            qualifies, and among them the person with the fewest tickets today gets it — a higher level than needed is not a reason to give
            someone the ticket. Hard requests still go only to the people skilled enough for them.
          </p>
        </div>
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
      </div>

      <section aria-labelledby="level-match-mode">
        <h4 id="level-match-mode" className="mb-1 text-xs font-medium text-muted-foreground">Mode</h4>
        <div className="divide-y divide-border border-y border-border" role="radiogroup" aria-label="Level match mode">
          {MODES.map((m) => (
            <label key={m.id} className="flex cursor-pointer items-start gap-2.5 py-2">
              <input
                type="radio"
                name="level-match-mode"
                value={m.id}
                checked={settings.mode === m.id}
                disabled={!data.canManage || saving}
                onChange={() => choose(m.id)}
                className="tp-focus-ring mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]"
              />
              <span className="min-w-0 text-sm">
                <span className="font-medium text-foreground">{m.label}</span>
                <span className="block text-xs leading-6 text-muted-foreground">{m.note}</span>
              </span>
            </label>
          ))}
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {data.canManage ? null : <span>Only an admin can change this.</span>}
          {saving ? <span role="status">Saving…</span> : null}
          {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
          {settings.updatedAt
            ? <span>Last changed {formatDateTimeInTimezone(settings.updatedAt, workspaceTimezone)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ''}.</span>
            : <span>Never changed: {settings.mode === 'shadow' ? 'IT starts in Shadow.' : 'starts off.'}</span>}
          <span>It never overrides an urgent ticket, an escalation, a share, or a person on leave, off shift, or with a routing note.</span>
        </div>
      </section>

      <section aria-labelledby="level-match-results">
        <h4 id="level-match-results" className="mb-2 text-xs font-medium text-muted-foreground">Last {days} days</h4>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Tickets judged" value={tally.total} note={levelMix || 'none yet'} />
          <Fact label={live ? 'Moved' : 'Would move'} value={tally.moved} note="to a qualified person with a lighter day" />
          <Fact label="Kept" value={tally.kept} note="the AI’s pick was already right" />
          <Fact label="Not judged" value={tally.noLevel + tally.noSkill} note={`${tally.noLevel} no level, ${tally.noSkill} no skill listed`} />
        </dl>
      </section>

      <section aria-labelledby="level-match-runs">
        <div className="mb-1 flex flex-wrap items-center gap-3">
          <h4 id="level-match-runs" className="mr-auto text-xs font-medium text-muted-foreground">Tickets</h4>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <input type="checkbox" checked={onlyMoves} onChange={(e) => setOnlyMoves(e.target.checked)} className="tp-focus-ring h-3.5 w-3.5 accent-[hsl(var(--primary))]" />
            Only where the person changes
          </label>
        </div>
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
                  <tr key={r.runId} className="border-b border-border/60 align-top" title={r.sentence || undefined}>
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
                    <td className="whitespace-nowrap py-1 text-foreground/85">
                      {r.outcome === 'moved' ? (r.to?.techName || '—') : <span className="text-muted-foreground">{OUTCOME_WORDS[r.outcome] || r.outcome}</span>}
                      {r.outcome === 'moved' && !r.applied ? <span className="text-muted-foreground"> (shadow)</span> : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
