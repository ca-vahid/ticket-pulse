import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, PieChart, RefreshCw, X } from 'lucide-react';
import { assignmentSharesAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { draftProblems, sharesTotal as total } from '../../utils/assignmentShares';

/**
 * Assignment Review → Shares (QA 10-16 item 4, proof of concept). An admin
 * gives people a whole-percent share of the tickets in some categories; the
 * rule picks whoever is furthest below their share. Off · Shadow · Live.
 *
 * Team balance, never a ranking: every list of people is ordered by share,
 * never by how many tickets someone got.
 */
const REPORT_DAYS = [7, 14, 30];
const MODE_WORDS = {
  off: { label: 'Off', note: 'The rule does nothing. Tickets are suggested and assigned as before.' },
  shadow: { label: 'Shadow', note: 'Each ticket in these categories records who the rule would have picked. Nothing changes. Watch the report below for a week or two before going Live.' },
  live: { label: 'Live', note: 'The rule’s pick is suggested first and the AI’s own pick second. Where the AI assigns by itself, the rule’s pick is assigned. Spread’s cap does not apply to these tickets.' },
};
const PERIOD_WORDS = { week: 'Week', month: 'Month' };
const FIELD_WORDS = { mode: 'Mode', period: 'Counting period', categoryIds: 'Categories', members: 'People and shares' };

const pickSettings = (s) => ({
  mode: s?.mode || 'off',
  period: s?.period || 'week',
  categoryIds: [...(s?.categoryIds || [])],
  members: (s?.members || []).map((m) => ({ techId: m.techId, pct: m.pct })),
});
const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

function Choice({ name, options, value, onChange, disabled, label }) {
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap items-center gap-3 text-sm">
      {options.map(([id, text]) => (
        <label key={id} className={`flex items-center gap-1.5 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
          <input
            type="radio"
            name={name}
            value={id}
            checked={value === id}
            disabled={disabled}
            onChange={() => onChange(id)}
            className="tp-focus-ring h-3.5 w-3.5 accent-[hsl(var(--primary))]"
          />
          <span className={value === id ? 'font-medium text-foreground' : 'text-muted-foreground'}>{text}</span>
        </label>
      ))}
    </div>
  );
}

function CategoryPicker({ categories, selected, onChange, disabled }) {
  const set = new Set(selected);
  const toggle = (id, on, subIds = []) => {
    const next = new Set(set);
    if (on) {
      next.add(id);
      // A top category covers its subcategories: no need to keep them ticked too.
      subIds.forEach((s) => next.delete(s));
    } else next.delete(id);
    onChange([...next]);
  };
  if (!categories.length) return <p className="text-xs text-muted-foreground/75">This workspace has no categories yet.</p>;
  return (
    <ul className="grid gap-x-6 gap-y-1 sm:grid-cols-2" aria-label="Categories it applies to">
      {categories.map((c) => {
        const topOn = set.has(c.id);
        const subIds = c.subcategories.map((s) => s.id);
        return (
          <li key={c.id} className="text-sm">
            <label className={`flex items-center gap-2 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={topOn}
                disabled={disabled}
                onChange={(e) => toggle(c.id, e.target.checked, subIds)}
                className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
              />
              <span className="text-foreground">{c.name}</span>
              {topOn && subIds.length ? <span className="text-xs text-muted-foreground">all {plural(subIds.length, 'subcategory', 'subcategories')}</span> : null}
            </label>
            {c.subcategories.length ? (
              <ul className="ml-6 mt-0.5 space-y-0.5">
                {c.subcategories.map((s) => (
                  <li key={s.id}>
                    <label className={`flex items-center gap-2 text-xs ${disabled || topOn ? 'opacity-60' : 'cursor-pointer'}`}>
                      <input
                        type="checkbox"
                        checked={topOn || set.has(s.id)}
                        disabled={disabled || topOn}
                        onChange={(e) => toggle(s.id, e.target.checked)}
                        aria-label={`${c.name} › ${s.name}`}
                        className="tp-focus-ring h-3.5 w-3.5 rounded border-input accent-[hsl(var(--primary))]"
                      />
                      <span className="text-foreground/85">{s.name}</span>
                    </label>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

export default function SharesTab({ workspaceTimezone = 'America/Vancouver' }) {
  const [days, setDays] = useState(14);
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [draftPreview, setDraftPreview] = useState(null);
  const [adding, setAdding] = useState('');
  const previewSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await assignmentSharesAPI.get(days);
      setData(res?.data || null);
      setDraft((current) => current || pickSettings(res?.data?.settings));
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load the shares');
    }
    setLoading(false);
  }, [days]);
  useEffect(() => { load(); }, [load]);

  const settings = data?.settings || null;
  const canManage = data?.canManage === true;
  const people = useMemo(() => data?.people || [], [data]);
  const nameOf = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const savedDraft = useMemo(() => pickSettings(settings), [settings]);
  const changed = Boolean(draft && settings && !sameDraft(draft, savedDraft));
  const problems = draft ? draftProblems(draft) : [];
  const locked = !canManage || saving;

  // The preview follows the draft: the saved one comes with the page, an
  // unsaved one is asked for (a moment after the last change).
  const previewKey = draft ? JSON.stringify({ period: draft.period, categoryIds: draft.categoryIds, members: draft.members }) : '';
  const savedKey = JSON.stringify({ period: savedDraft.period, categoryIds: savedDraft.categoryIds, members: savedDraft.members });
  useEffect(() => {
    if (!draft || previewKey === savedKey) { setDraftPreview(null); return undefined; }
    const ready = draft.members.length && draft.categoryIds.length && total(draft.members) === 100;
    if (!ready) { setDraftPreview({ ready: false, picks: [], out: [], counts: [] }); return undefined; }
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    const timer = setTimeout(async () => {
      try {
        const res = await assignmentSharesAPI.preview({ period: draft.period, categoryIds: draft.categoryIds, members: draft.members });
        if (previewSeq.current === seq) setDraftPreview(res?.data || null);
      } catch {
        if (previewSeq.current === seq) setDraftPreview(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey is the draft's preview fields, serialised
  }, [previewKey, savedKey]);
  const preview = draftPreview || (previewKey === savedKey ? data?.preview : null);

  const update = (patch) => { setSaved(false); setSaveError(null); setDraft((d) => ({ ...d, ...patch })); };
  const setPct = (techId, value) => update({ members: draft.members.map((m) => (m.techId === techId ? { ...m, pct: value === '' ? '' : Number(value) } : m)) });
  const remove = (techId) => update({ members: draft.members.filter((m) => m.techId !== techId) });
  const add = (techId) => {
    const id = Number(techId);
    if (!id || draft.members.some((m) => m.techId === id)) return;
    const left = Math.max(1, 100 - total(draft.members));
    update({ members: [...draft.members, { techId: id, pct: Math.min(100, left) }] });
    setAdding('');
  };
  const splitEvenly = () => {
    const n = draft.members.length;
    if (!n) return;
    const base = Math.floor(100 / n);
    let rest = 100 - base * n;
    update({ members: draft.members.map((m) => { const extra = rest > 0 ? 1 : 0; rest -= extra; return { ...m, pct: base + extra }; }) });
  };

  const save = async () => {
    if (!changed || problems.length) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await assignmentSharesAPI.saveSettings(draft);
      const next = res?.data?.settings;
      if (next) {
        setData((d) => ({ ...d, settings: next }));
        setDraft(pickSettings(next));
      }
      setSaved(true);
      load();
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not save');
    }
    setSaving(false);
  };

  if (!data && loading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  }
  if (!data || !draft) {
    return <p className="py-10 text-sm text-destructive" role="alert">{error || 'Could not load the shares'}</p>;
  }

  const sum = total(draft.members);
  const available = people.filter((p) => !draft.members.some((m) => m.techId === p.id));
  const verdict = {
    off: 'Off for this workspace.',
    shadow: 'Shadow: recording who the rule would pick. Nothing changes.',
    live: 'Live: the rule picks the person for tickets in the chosen categories.',
  }[settings.mode] || '';
  const { rows = [], totals = null, events = [] } = data;

  return (
    <div className="space-y-6" data-testid="shares-tab">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <PieChart className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Shares
          </h3>
          <p className="text-xs text-muted-foreground">
            Tickets in the categories you pick go to people by the shares you set, best effort, so nobody ends up with far more than their part. {verdict}
          </p>
        </div>
        <button type="button" onClick={load} className="tp-focus-ring shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      <section aria-labelledby="shares-setup" className="space-y-4">
        <h4 id="shares-setup" className="text-xs font-medium text-muted-foreground">Set up</h4>

        <div className="space-y-1">
          <Choice name="shares-mode" label="Mode" value={draft.mode} disabled={locked} onChange={(mode) => update({ mode })}
            options={Object.entries(MODE_WORDS).map(([id, w]) => [id, w.label])} />
          <p className="text-xs leading-5 text-muted-foreground">{MODE_WORDS[draft.mode]?.note}</p>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Applies to</div>
          <p className="text-xs text-muted-foreground">Only tickets in these categories. A top category includes all its subcategories. Every other ticket is suggested and assigned as before.</p>
          <CategoryPicker categories={data.categories || []} selected={draft.categoryIds} disabled={locked} onChange={(categoryIds) => update({ categoryIds })} />
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Count tickets per</div>
          <Choice name="shares-period" label="Count tickets per" value={draft.period} disabled={locked} onChange={(period) => update({ period })}
            options={Object.entries(PERIOD_WORDS)} />
          <p className="text-xs text-muted-foreground">
            {draft.period === 'month' ? 'A month starts on the 1st at 00:00, workspace time.' : 'A week starts Monday 00:00, workspace time.'} The counts start again each {draft.period === 'month' ? 'month' : 'week'}.
          </p>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">People and shares</div>
          {draft.members.length === 0 ? (
            <p className="text-xs text-muted-foreground/75">Nobody yet. Add the people who share these tickets.</p>
          ) : (
            <ul className="max-w-lg divide-y divide-border border-y border-border" aria-label="People and shares">
              {draft.members.map((m) => {
                const name = nameOf.get(m.techId) || `Technician ${m.techId}`;
                return (
                  <li key={m.techId} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                    <span className="flex items-center gap-1 text-muted-foreground">
                      <input
                        type="number"
                        inputMode="numeric"
                        min={1}
                        max={100}
                        step={1}
                        value={m.pct}
                        disabled={locked}
                        aria-label={`Share for ${name}, percent`}
                        onChange={(e) => setPct(m.techId, e.target.value)}
                        className="tp-focus-ring h-7 w-16 rounded-md border border-input bg-card px-1.5 text-right text-sm tabular-nums text-foreground disabled:opacity-60"
                      />
                      %
                    </span>
                    {canManage ? (
                      <button type="button" onClick={() => remove(m.techId)} disabled={locked} aria-label={`Remove ${name}`}
                        className="tp-focus-ring rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
                        <X className="h-3.5 w-3.5" aria-hidden="true" />
                      </button>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            <span className={`tabular-nums ${draft.members.length && sum !== 100 ? 'font-medium text-destructive' : 'text-muted-foreground'}`} data-testid="shares-total">
              {draft.members.length ? (sum === 100 ? 'Total 100%' : sum < 100 ? `Total ${sum}% — add ${100 - sum}% to save` : `Total ${sum}% — take off ${sum - 100}% to save`) : 'Total 0%'}
            </span>
            {canManage ? (
              <>
                <label className="flex items-center gap-1.5 text-muted-foreground">
                  <span className="sr-only">Add person</span>
                  <select
                    value={adding}
                    disabled={locked || !available.length}
                    onChange={(e) => add(e.target.value)}
                    aria-label="Add person"
                    className="tp-focus-ring h-7 rounded-md border border-input bg-card px-1.5 text-xs text-foreground disabled:opacity-60"
                  >
                    <option value="">Add person…</option>
                    {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                  </select>
                </label>
                <button type="button" onClick={splitEvenly} disabled={locked || !draft.members.length}
                  className="tp-focus-ring rounded px-1 py-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50">
                  Split evenly
                </button>
              </>
            ) : null}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {canManage ? (
            <button
              type="button"
              onClick={save}
              disabled={!changed || saving || problems.length > 0}
              className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          ) : <span>Only an admin can change these.</span>}
          {changed && problems.length ? <span className="text-destructive" role="alert">{problems.join(' ')}</span> : null}
          {saved && !changed ? <span role="status">Saved. It applies to the next ticket.</span> : null}
          {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
          {settings.updatedAt ? (
            <span>Last changed {formatDateTimeInTimezone(settings.updatedAt, workspaceTimezone)}{settings.updatedBy ? ` by ${settings.updatedBy}` : ''}.</span>
          ) : <span>Never set up.</span>}
        </div>
        {settings.history?.length ? (
          <details className="text-xs text-muted-foreground">
            <summary className="tp-focus-ring cursor-pointer rounded">Earlier changes ({settings.history.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {settings.history.map((h) => (
                <li key={h.at}>
                  {formatDateTimeInTimezone(h.at, workspaceTimezone)}{h.by ? `, ${h.by}` : ''}: {h.changes.map((c) => FIELD_WORDS[c.field] || c.field).join(', ')} changed
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      <section aria-labelledby="shares-preview">
        <h4 id="shares-preview" className="mb-1 text-xs font-medium text-muted-foreground">Preview{changed ? ' (not saved yet)' : ''}</h4>
        {!preview || !preview.ready ? (
          <p className="text-xs text-muted-foreground/75">Pick categories and people with shares that total 100% to see who the next tickets would go to.</p>
        ) : (
          <div className="space-y-2 text-sm text-foreground/85" data-testid="shares-preview">
            <p>
              <span className="text-muted-foreground">The next {preview.picks.length} tickets would go to: </span>
              {preview.picks.map((p) => p.name).join(', ') || 'nobody (everyone on the list is out)'}.
            </p>
            {preview.out?.length ? (
              <p className="text-xs text-muted-foreground">Out now: {preview.out.map((o) => `${o.name} (${o.why})`).join(', ')}.</p>
            ) : null}
            {preview.counts?.length ? (
              <p className="text-xs text-muted-foreground">
                {preview.period?.kind === 'month' ? 'This month' : 'This week'} so far, with about what each share comes to: {[...preview.counts].sort((a, b) => b.pct - a.pct).map((c) => `${c.name} ${c.count} of about ${c.target} (${c.pct}%)`).join(' · ')}.
              </p>
            ) : null}
          </div>
        )}
      </section>

      <section aria-labelledby="shares-report">
        <div className="mb-2 flex flex-wrap items-center gap-3">
          <h4 id="shares-report" className="mr-auto text-xs font-medium text-muted-foreground">How the split worked out, last {days} days</h4>
          <div className="flex items-center gap-3 text-xs" role="group" aria-label="Report period">
            {REPORT_DAYS.map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => setDays(d)}
                aria-pressed={days === d}
                className={`tp-focus-ring rounded px-1 py-0.5 ${days === d ? 'font-medium text-foreground underline underline-offset-4' : 'text-muted-foreground hover:text-foreground'}`}
              >
                {d} days
              </button>
            ))}
          </div>
        </div>
        {!totals ? (
          <p className="text-xs text-muted-foreground/75">Set up the categories and people first.</p>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-foreground/85" data-testid="shares-agreement">
              {totals.compared
                ? `The rule’s pick matched who really got the ticket on ${totals.agreed} of ${plural(totals.compared, 'ticket')} (${percent(totals.agreed, totals.compared)}%).${totals.aiCompared ? ` The AI’s first suggestion matched on ${totals.aiAgreed} of ${totals.aiCompared}.` : ''}`
                : 'No ticket has a rule pick to compare yet. In Shadow, each new ticket in these categories records one.'}
            </p>
            <div className="overflow-x-auto">
              <table className="w-full min-w-[560px] text-xs">
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Person</th>
                    <th className="py-1 pr-3 text-right font-medium">Share</th>
                    <th className="py-1 pr-3 text-right font-medium">Tickets they got</th>
                    <th className="py-1 pr-3 font-medium">Part of the split</th>
                    <th className="py-1 font-medium">When the rule picked them, they got it</th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.techId} className="border-b border-border/60">
                      <td className="py-1 pr-3 text-foreground/85">{r.name}</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-foreground/85">{r.pct}%</td>
                      <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{r.got}</td>
                      <td className="py-1 pr-3">
                        <span className="flex items-center gap-2">
                          <span className="relative h-1.5 w-32 rounded-full bg-muted" aria-hidden="true">
                            <span className="absolute inset-y-0 left-0 rounded-full bg-primary/60" style={{ width: `${Math.min(100, r.gotPct ?? 0)}%` }} />
                            <span className="absolute -top-0.5 h-2.5 w-px bg-foreground/60" style={{ left: `${Math.min(100, r.pct)}%` }} />
                          </span>
                          <span className="tabular-nums text-muted-foreground">{r.gotPct === null ? '—' : `${r.gotPct}%`}</span>
                        </span>
                      </td>
                      <td className="py-1 tabular-nums text-muted-foreground">{r.rulePicked ? `${r.ruleMatched} of ${r.rulePicked}` : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {plural(totals.tickets, 'ticket')} in these categories. The bar is the part each person got; the mark is their share.
              {totals.outside ? ` ${totals.outside} went to people not on the list.` : ''}
              {totals.unassigned ? ` ${totals.unassigned} not assigned yet.` : ''}
            </p>
            {/* QA 10-20 #4: say who really decided these tickets. */}
            {Number.isFinite(totals.selfPicked) && totals.selfPicked > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="shares-self-picked">
                {`${totals.selfPicked} of ${plural(totals.toMembers + totals.outside, 'assigned ticket')} were taken by the person themselves, from the queue. Neither the rule nor the AI decides those, so the split follows who picks them up.`}
                {settings?.mode === 'shadow' ? ' The rule is in Shadow: it writes down its pick and changes nothing.' : ''}
              </p>
            )}
          </div>
        )}
      </section>

      <section aria-labelledby="shares-events">
        <h4 id="shares-events" className="mb-1 text-xs font-medium text-muted-foreground">Recent rule picks</h4>
        {events.length === 0 ? (
          <p className="text-xs text-muted-foreground/75">Nothing yet. Every ticket the rule looks at is listed here, with who it would pick and who really got it.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-xs">
              <thead>
                <tr className="border-b border-border text-left text-muted-foreground">
                  <th className="py-1 pr-3 font-medium">When</th>
                  <th className="py-1 pr-3 font-medium">Ticket</th>
                  <th className="py-1 pr-3 font-medium">Rule would pick</th>
                  <th className="py-1 pr-3 font-medium">AI suggested</th>
                  <th className="py-1 font-medium">Went to</th>
                </tr>
              </thead>
              <tbody>
                {events.map((e) => (
                  <tr key={e.runId} className="border-b border-border/60 align-top">
                    <td className="whitespace-nowrap py-1 pr-3 tabular-nums text-muted-foreground">{formatDateTimeInTimezone(e.at, workspaceTimezone)}</td>
                    <td className="max-w-[22rem] truncate py-1 pr-3">
                      <Link to={`/tickets/${e.ticket.id}`} className="tp-focus-ring rounded text-primary hover:underline">{e.ticket.displayRef || `Ticket ${e.ticket.id}`}</Link>
                      {e.ticket.subject ? <span className="text-foreground/85"> {e.ticket.subject}</span> : null}
                    </td>
                    <td className="whitespace-nowrap py-1 pr-3 text-foreground/85">{e.rulePick || 'nobody in'}</td>
                    <td className="whitespace-nowrap py-1 pr-3 text-foreground/85">{e.aiPick || '—'}</td>
                    <td className="whitespace-nowrap py-1 text-foreground/85">
                      {e.wentTo ? (
                        <span className="flex items-center gap-1.5">
                          <span className={`h-1.5 w-1.5 rounded-full ${e.agreed ? 'bg-load-light' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                          {e.wentTo}<span className="sr-only">{e.agreed ? ' (same as the rule)' : ''}</span>
                        </span>
                      ) : 'not assigned yet'}
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
