import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw, Users } from 'lucide-react';
import { assignmentSpreadAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';

/**
 * Assignment Review → Spread (QA 10-13 item 17). The rules that stop one
 * person getting several tickets within minutes, and how they have worked.
 * Everything here is a setting per workspace; nothing is fixed in the code.
 * Results are counts per rule and per day — team balance, never a ranking of
 * people. The only names are in the plain list of recent changes.
 */
const PERIODS = [7, 14, 30];
const RULE_WORDS = {
  cap: 'Cap',
  cap_gave_way: 'Cap gave way',
  new_hire_set: 'New hire set',
};
const FIELD_WORDS = {
  enabled: 'Rules',
  countRecent: 'Count what was just assigned',
  recentWindowMinutes: 'Recent window (minutes)',
  capEnabled: 'Cap',
  capCount: 'Cap (tickets)',
  capWindowMinutes: 'Cap window (minutes)',
  keepNewHireSet: 'Keep a new hire’s set together',
  staggerEnabled: 'Gradual release',
  staggerCount: 'Release (tickets)',
  staggerMinutes: 'Release interval (minutes)',
};
const FIELDS = Object.keys(FIELD_WORDS);
const word = (value) => (typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value));
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

function NumberField({ value, onChange, limits, disabled, label }) {
  return (
    <input
      type="number"
      inputMode="numeric"
      value={value}
      min={limits?.min}
      max={limits?.max}
      disabled={disabled}
      aria-label={label}
      onChange={(e) => onChange(e.target.value === '' ? '' : Number(e.target.value))}
      className="tp-focus-ring mx-1 h-7 w-14 rounded-md border border-input bg-card px-1.5 text-center text-sm tabular-nums text-foreground disabled:opacity-60"
    />
  );
}

function Rule({ id, checked, onToggle, disabled, title, children }) {
  return (
    <div className="flex items-start gap-2.5 py-2">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onToggle(e.target.checked)}
        className="tp-focus-ring mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
      />
      <div className="min-w-0 text-sm">
        <label htmlFor={id} className="font-medium text-foreground">{title}</label>
        <div className="mt-0.5 text-xs leading-6 text-muted-foreground">{children}</div>
      </div>
    </div>
  );
}

function Fact({ label, value, note }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-lg font-semibold tabular-nums text-foreground">{value}</dd>
      {note ? <dd className="text-xs text-muted-foreground">{note}</dd> : null}
    </div>
  );
}

export default function SpreadTab({ workspaceTimezone = 'America/Vancouver' }) {
  const [days, setDays] = useState(30);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await assignmentSpreadAPI.get(days);
      setData(res?.data || null);
      setDraft((current) => current || (res?.data?.settings ? Object.fromEntries(FIELDS.map((f) => [f, res.data.settings[f]])) : null));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load the spread rules');
    }
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const settings = data?.settings || null;
  const canManage = data?.canManage === true;
  const limits = data?.limits || {};
  const changed = useMemo(() => Boolean(settings && draft && FIELDS.some((f) => draft[f] !== settings[f])), [settings, draft]);
  const set = (field) => (value) => { setSaved(false); setDraft((d) => ({ ...d, [field]: value })); };
  const locked = !canManage || saving;
  const off = locked || !draft?.enabled;

  const save = async () => {
    if (!changed) return;
    setSaving(true); setSaveError(null);
    try {
      const patch = Object.fromEntries(FIELDS.filter((f) => draft[f] !== settings[f]).map((f) => [f, draft[f]]));
      const res = await assignmentSpreadAPI.saveSettings(patch);
      const next = res?.data?.settings;
      if (next) {
        setData((d) => ({ ...d, settings: next }));
        setDraft(Object.fromEntries(FIELDS.map((f) => [f, next[f]])));
      }
      setSaved(true);
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not save');
    }
    setSaving(false);
  };

  if (!data && loading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  }
  if (!data) {
    return <p className="py-10 text-sm text-destructive" role="alert">{error || 'Could not load the spread rules'}</p>;
  }

  const { totals, before, after, perDay = [], events = [], capCount, windowMinutes } = data;
  const activeDays = perDay.filter((d) => d.assignments > 0 || d.released > 0).slice().reverse();
  const biggest = Math.max(capCount || 3, ...perDay.map((d) => d.largestBurst || 0));
  const verdict = settings.enabled
    ? (after.days > 0
      ? `On. Since the rules started, the most one person got in ${windowMinutes} minutes is ${after.largestBurst}${before.days > 0 ? ` (it was ${before.largestBurst} before)` : ''}.`
      : 'On. No automatic assignment has been made under the rules yet.')
    : 'Off for this workspace. Tickets are assigned one by one, without looking at what was just assigned.';

  return (
    <div className="space-y-6" data-testid="spread-tab">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <Users className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Spread
          </h3>
          <p className="text-xs text-muted-foreground">Stops one person getting several tickets within minutes. {verdict}</p>
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

      <section aria-labelledby="spread-rules">
        <h4 id="spread-rules" className="mb-1 text-xs font-medium text-muted-foreground">The rules</h4>
        <div className="divide-y divide-border border-y border-border">
          <Rule id="spread-enabled" checked={draft.enabled} onToggle={set('enabled')} disabled={locked} title="Spread automatic assignments">
            The main switch. Off: the four rules below do nothing. Assigning a ticket by hand is never limited and never counted.
          </Rule>
          <Rule id="spread-recent" checked={draft.countRecent} onToggle={set('countRecent')} disabled={off} title="Count what was just assigned">
            Tickets automation gave a person in the last
            <NumberField value={draft.recentWindowMinutes} onChange={set('recentWindowMinutes')} limits={limits.recentWindowMinutes} disabled={off || !draft.countRecent} label="Recent window in minutes" />
            minutes count as load for the next decision, also the ones still being saved. A ticket handed back does not count.
          </Rule>
          <Rule id="spread-cap" checked={draft.capEnabled} onToggle={set('capEnabled')} disabled={off} title="Cap">
            No more than
            <NumberField value={draft.capCount} onChange={set('capCount')} limits={limits.capCount} disabled={off || !draft.capEnabled} label="Cap in tickets" />
            automatic assignments to one person in
            <NumberField value={draft.capWindowMinutes} onChange={set('capWindowMinutes')} limits={limits.capWindowMinutes} disabled={off || !draft.capEnabled} label="Cap window in minutes" />
            minutes. The next ticket goes to the next-best person. When nobody else qualified is at work, the cap gives way and the run says so.
          </Rule>
          <Rule id="spread-set" checked={draft.keepNewHireSet} onToggle={set('keepNewHireSet')} disabled={off} title="Keep a new hire’s set together">
            The Workstation and Laptop/Desktop tickets of one new hire go to one person and count once. Nothing else is kept together.
          </Rule>
          <Rule id="spread-stagger" checked={draft.staggerEnabled} onToggle={set('staggerEnabled')} disabled={off} title="Release the overnight queue gradually">
            Release
            <NumberField value={draft.staggerCount} onChange={set('staggerCount')} limits={limits.staggerCount} disabled={off || !draft.staggerEnabled} label="Tickets per release" />
            tickets every
            <NumberField value={draft.staggerMinutes} onChange={set('staggerMinutes')} limits={limits.staggerMinutes} disabled={off || !draft.staggerEnabled} label="Minutes between releases" />
            minutes, most urgent and oldest first, one decision after another. The queue is checked every 2 minutes.
          </Rule>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {canManage ? (
            <button
              type="button"
              onClick={save}
              disabled={!changed || saving}
              className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          ) : <span>Only an admin can change these.</span>}
          {saved && !changed ? <span role="status">Saved. It applies to the next ticket.</span> : null}
          {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
          {settings.updatedAt ? (
            <span>Last changed {formatDateTimeInTimezone(settings.updatedAt, workspaceTimezone)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ''}.</span>
          ) : <span>Never changed: these are the starting values.</span>}
        </div>
        {settings.history?.length ? (
          <details className="mt-2 text-xs text-muted-foreground">
            <summary className="tp-focus-ring cursor-pointer rounded">Earlier changes ({settings.history.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {settings.history.map((h) => (
                <li key={h.at}>
                  {formatDateTimeInTimezone(h.at, workspaceTimezone)}{h.by ? `, ${h.by}` : ''}: {h.changes.map((c) => `${FIELD_WORDS[c.field] || c.field} ${word(c.from)} → ${word(c.to)}`).join('; ')}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="spread-results">
        <h4 id="spread-results" className="mb-2 text-xs font-medium text-muted-foreground">How it has worked, last {days} days</h4>
        <dl className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-4">
          <Fact label="Automatic assignments" value={totals.assignments} note={totals.guarded ? `${totals.guarded} under the rules` : 'none under the rules yet'} />
          <Fact label="Moved by the cap" value={totals.moved} note="went to the next-best person" />
          <Fact label="New hire sets kept together" value={totals.keptTogether} />
          <Fact label="Cap gave way" value={totals.gaveWay} note="nobody else qualified was at work" />
        </dl>
        <div className="mt-4 grid gap-x-6 gap-y-2 text-sm text-foreground/85 sm:grid-cols-2">
          <p>
            <span className="block text-xs text-muted-foreground">Most to one person in {windowMinutes} minutes</span>
            Before the rules: <strong className="tabular-nums">{before.days ? before.largestBurst : '—'}</strong>
            {before.days ? ` (${plural(before.daysOverCap, 'day')} of ${before.days} over ${capCount})` : ''}.
            {' '}Under the rules: <strong className="tabular-nums">{after.days ? after.largestBurst : '—'}</strong>
            {after.days ? ` (${plural(after.daysOverCap, 'day')} of ${after.days} over ${capCount})` : ''}.
          </p>
          <p>
            <span className="block text-xs text-muted-foreground">Overnight release</span>
            Before: {before.release.days ? `${plural(before.release.tickets, 'ticket')} on ${plural(before.release.days, 'morning')}, about ${plural(before.release.averageMinutes, 'minute')} each` : '—'}.
            {' '}Under the rules: {after.release.days ? `${plural(after.release.tickets, 'ticket')} on ${plural(after.release.days, 'morning')}, about ${plural(after.release.averageMinutes, 'minute')} each (longest ${after.release.longestMinutes})` : '—'}.
          </p>
        </div>
      </section>

      <section aria-labelledby="spread-days">
        <h4 id="spread-days" className="mb-1 text-xs font-medium text-muted-foreground">Day by day</h4>
        {activeDays.length === 0 ? (
          <p className="text-xs text-muted-foreground/75">No automatic assignments in this period.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">Day</th>
                  <th className="py-1 pr-3 text-right font-medium">Assigned</th>
                  <th className="py-1 pr-3 font-medium">Most to one person in {windowMinutes} min</th>
                  <th className="py-1 pr-3 text-right font-medium">Moved</th>
                  <th className="py-1 pr-3 text-right font-medium">Kept together</th>
                  <th className="py-1 pr-3 text-right font-medium">Gave way</th>
                  <th className="py-1 font-medium">Overnight release</th>
                </tr>
              </thead>
              <tbody>
                {activeDays.map((d) => {
                  const over = d.largestBurst > capCount;
                  return (
                    <tr key={d.day} className="border-b border-border/60">
                      <td className="py-1 pr-3 tabular-nums text-foreground/85">
                        {d.day}{d.rulesOn ? '' : <span className="text-muted-foreground/75"> · before</span>}
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums text-foreground/85">{d.assignments}</td>
                      <td className="py-1 pr-3">
                        <span className="flex items-center gap-2">
                          <span className="h-1.5 w-32 rounded-full bg-muted" aria-hidden="true">
                            <span
                              className={`block h-full rounded-full ${over ? 'bg-load-heavy' : 'bg-primary/60'}`}
                              style={{ width: `${Math.round((d.largestBurst / biggest) * 100)}%` }}
                            />
                          </span>
                          <span className={`tabular-nums ${over ? 'font-semibold text-foreground' : 'text-muted-foreground'}`}>
                            {d.largestBurst}{over ? ` — over ${capCount}` : ''}
                          </span>
                        </span>
                      </td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{d.moved || ''}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{d.keptTogether || ''}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{d.gaveWay || ''}</td>
                      <td className="py-1 tabular-nums text-muted-foreground">
                        {d.released > 0 ? `${plural(d.released, 'ticket')}, ${plural(d.releaseMinutes, 'minute')}` : ''}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="spread-events">
        <h4 id="spread-events" className="mb-1 text-xs font-medium text-muted-foreground">Recent changes made by a rule</h4>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground/75">Nothing yet. Every time a rule changes who gets a ticket, it is listed here.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Ticket</th>
                  <th className="py-1 pr-3 font-medium">Rule</th>
                  <th className="py-1 pr-3 font-medium">Would have gone to</th>
                  <th className="py-1 font-medium">Went to</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.runId} className="border-b border-border/60 align-top" title={e.why || undefined}>
                    <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-muted-foreground">{formatDateTimeInTimezone(e.at, workspaceTimezone)}</td>
                    <td className="max-w-[22rem] truncate py-1 pr-3">
                      <Link to={`/tickets/${e.ticket.id}`} className="tp-focus-ring rounded text-primary hover:underline">{e.ticket.displayRef || `Ticket ${e.ticket.id}`}</Link>
                      {e.ticket.subject ? <span className="text-foreground/85"> {e.ticket.subject}</span> : null}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 text-foreground/85">{RULE_WORDS[e.rule] || e.rule}</td>
                    <td className="whitespace-nowrap py-1 pr-3 text-foreground/85">{e.wouldHaveGoneTo || '—'}</td>
                    <td className="whitespace-nowrap py-1 text-foreground/85">{e.rule === 'cap_gave_way' ? `${e.wentTo || '—'} (unchanged)` : (e.wentTo || '—')}</td>
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
