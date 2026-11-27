import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, AlertTriangle, PieChart, Plus, RefreshCw, X } from 'lucide-react';
import { assignmentSharesAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import {
  categoryOwners, draftProblems, eachPct, explicitPct, hasShares, restOn, restPct, ruleLabel, ruleSummary, sharesTotal as total,
} from '../../utils/assignmentShares';

/**
 * Assignment Review → Shares (QA 10-16 item 4; rules per category with
 * internal groups QA 11-26 #3–6). An admin sets up rules: each covers some
 * categories and says who takes those tickets — internal groups with a share
 * (split evenly across the group's members), people with a share, and
 * optionally the rest split evenly. The rule picks whoever is furthest below
 * their share. Each rule is Off, Shadow or Live on its own.
 *
 * Team balance, never a ranking: every list of people is ordered by share
 * (or by name inside a group), never by how many tickets someone got.
 */
const NEW = 'new';
const REPORT_DAYS = [7, 14, 30];
const MODE_WORDS = {
  off: { label: 'Off', note: 'The rule does nothing. Tickets are suggested and assigned as before.' },
  shadow: { label: 'Shadow', note: 'Each ticket in these categories records who the rule would have picked. Nothing changes. Watch the report below for a week or two before going Live.' },
  live: { label: 'Live', note: 'The rule’s pick is suggested first and the AI’s own pick second. Where the AI assigns by itself, the rule’s pick is assigned. Spread’s cap does not apply to these tickets.' },
};
const MODE_DOT = { off: 'bg-muted-foreground/40', shadow: 'bg-amber-500', live: 'bg-load-light' };
const PERIOD_WORDS = { week: 'Week', month: 'Month' };
const FIELD_WORDS = {
  name: 'Name', mode: 'Mode', period: 'Counting period', categoryIds: 'Categories', members: 'People and shares', groups: 'Groups', rest: 'The rest',
};

const emptyRule = () => ({ id: null, name: '', mode: 'off', period: 'week', categoryIds: [], members: [], groups: [], rest: { evenly: false, techIds: [] } });
const pickRule = (r) => (r ? {
  id: r.id || null,
  name: r.name || '',
  mode: r.mode || 'off',
  period: r.period || 'week',
  categoryIds: [...(r.categoryIds || [])],
  members: (r.members || []).map((m) => ({ techId: m.techId, pct: m.pct })),
  groups: (r.groups || []).map((g) => ({ groupId: g.groupId, pct: g.pct })),
  rest: { evenly: r.rest?.evenly === true, techIds: [...(r.rest?.techIds || [])] },
} : emptyRule());
const sameDraft = (a, b) => JSON.stringify(a) === JSON.stringify(b);
const shareFields = (d) => JSON.stringify({ period: d.period, categoryIds: d.categoryIds, members: d.members, groups: d.groups, rest: d.rest });
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const percent = (part, whole) => (whole ? Math.round((part / whole) * 100) : 0);

// QA 11-06 #4: days away per person ('yyyy-MM-dd' working days from the server).
const dayCount = (n) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const shortDate = (d, weekday = false) => new Date(`${d}T12:00:00Z`).toLocaleDateString('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', ...(weekday ? { weekday: 'short' } : {}),
});
const dateList = (dates) => dates.map((d) => `${shortDate(d.date, true)}${d.half ? ' (half)' : ''}`).join(', ');
const FLAG = 'font-medium text-amber-700 dark:text-amber-300';
const INPUT = 'tp-focus-ring h-7 rounded-md border border-input bg-card px-1.5 text-xs text-foreground disabled:opacity-60';
const TEXT_BUTTON = 'tp-focus-ring rounded px-1 py-0.5 text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50';

function AwayCell({ away, pastDays, aheadDays }) {
  const past = away?.past;
  const ahead = away?.ahead;
  if (!past?.days && !ahead?.days) return <span className="text-muted-foreground/75">—<span className="sr-only">no days away</span></span>;
  const title = [
    past?.days ? `Away in the last ${pastDays} days: ${dateList(past.dates)}.` : `No days away in the last ${pastDays} days.`,
    ahead?.days ? `Coming up in the next ${aheadDays} days: ${dateList(ahead.dates)}.` : '',
    past?.heavy || ahead?.heavy ? 'Away for a large part of the time, so their part of the split runs below their share.' : '',
  ].filter(Boolean).join(' ');
  return (
    <span className="inline-flex items-center gap-1 whitespace-nowrap tabular-nums" title={title}>
      {past?.heavy || ahead?.heavy ? <AlertTriangle className="h-3 w-3 shrink-0 text-amber-700 dark:text-amber-300" aria-hidden="true" /> : null}
      {past?.days ? (
        <span className={past.heavy ? FLAG : 'text-foreground/85'}>{dayCount(past.days)} {past.days === 1 ? 'day' : 'days'} away (last {pastDays})</span>
      ) : null}
      {past?.days && ahead?.days ? <span className="text-muted-foreground" aria-hidden="true">·</span> : null}
      {ahead?.days ? (
        <span className={ahead.heavy ? FLAG : 'text-muted-foreground'}>{dayCount(ahead.days)} coming up (from {shortDate(ahead.from || ahead.dates[0].date)})</span>
      ) : null}
      {past?.heavy || ahead?.heavy ? <span className="sr-only"> — away for a large part of the time</span> : null}
    </span>
  );
}

function awayNote(availability, rows) {
  if (!availability) return '';
  const anyPast = rows.some((r) => r.away?.past?.days > 0);
  const gap = availability.belowShareWithAway || 0;
  const soon = availability.awaySoon || 0;
  const parts = [];
  if (gap) parts.push(`Away days explain part of the gap for ${plural(gap, 'person', 'people')}: the rule counts a share only on days someone is in.`);
  else if (anyPast) parts.push('Days away in this window left nobody below their share.');
  if (soon) parts.push(`${plural(soon, 'person', 'people')} ${soon === 1 ? 'is' : 'are'} away in the next ${availability.ahead?.days || 14} days. The rule skips people while they are out, so the others take their part.`);
  return parts.join(' ');
}

function Warnings({ items, testId }) {
  if (!items?.length) return null;
  return (
    <ul className="space-y-0.5 text-xs text-amber-700 dark:text-amber-300" data-testid={testId}>
      {items.map((w) => (
        <li key={w} className="flex items-start gap-1.5">
          <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0" aria-hidden="true" />
          <span>{w}</span>
        </li>
      ))}
    </ul>
  );
}

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

/** Categories for one rule. A category another rule holds is shown, but cannot be ticked (no overlaps). */
function CategoryPicker({ categories, selected, onChange, disabled, owners = new Map() }) {
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
        const topOwner = owners.get(c.id) || null;
        const subOwner = subIds.map((s) => owners.get(s)).find(Boolean) || null;
        const topLocked = disabled || Boolean(topOwner || subOwner);
        return (
          <li key={c.id} className="text-sm">
            <label className={`flex items-center gap-2 ${topLocked ? 'opacity-60' : 'cursor-pointer'}`}>
              <input
                type="checkbox"
                checked={topOn}
                disabled={topLocked}
                onChange={(e) => toggle(c.id, e.target.checked, subIds)}
                className="tp-focus-ring h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
              />
              <span className="text-foreground">{c.name}</span>
              {topOn && subIds.length ? <span className="text-xs text-muted-foreground">all {plural(subIds.length, 'subcategory', 'subcategories')}</span> : null}
              {topOwner || subOwner ? <span className="text-xs text-muted-foreground">in “{topOwner || subOwner}”</span> : null}
            </label>
            {c.subcategories.length ? (
              <ul className="ml-6 mt-0.5 space-y-0.5">
                {c.subcategories.map((s) => {
                  const owner = owners.get(s.id) || topOwner;
                  const locked = disabled || topOn || Boolean(owner);
                  return (
                    <li key={s.id}>
                      <label className={`flex items-center gap-2 text-xs ${locked ? 'opacity-60' : 'cursor-pointer'}`}>
                        <input
                          type="checkbox"
                          checked={topOn || set.has(s.id)}
                          disabled={locked}
                          onChange={(e) => toggle(s.id, e.target.checked)}
                          aria-label={`${c.name} › ${s.name}`}
                          className="tp-focus-ring h-3.5 w-3.5 rounded border-input accent-[hsl(var(--primary))]"
                        />
                        <span className="text-foreground/85">{s.name}</span>
                        {owners.get(s.id) ? <span className="text-muted-foreground">in “{owners.get(s.id)}”</span> : null}
                      </label>
                    </li>
                  );
                })}
              </ul>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function PctInput({ value, label, disabled, onChange }) {
  return (
    <span className="flex items-center gap-1 text-muted-foreground">
      <input
        type="number"
        inputMode="numeric"
        min={1}
        max={100}
        step={1}
        value={value}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => onChange(e.target.value)}
        className="tp-focus-ring h-7 w-16 rounded-md border border-input bg-card px-1.5 text-right text-sm tabular-nums text-foreground disabled:opacity-60"
      />
      %
    </span>
  );
}

function RemoveButton({ label, onClick, disabled }) {
  return (
    <button type="button" onClick={onClick} disabled={disabled} aria-label={label}
      className="tp-focus-ring rounded p-1 text-muted-foreground hover:text-foreground disabled:opacity-50">
      <X className="h-3.5 w-3.5" aria-hidden="true" />
    </button>
  );
}

/** One row of the report: a person, or a group/rest subtotal (`subtotal`, with an optional `note`). */
function ReportRow({ r, name, subtotal = false, note = null, indent = false, availability, days, testId }) {
  const pct = r.pct ?? 0;
  return (
    <tr className={`border-b border-border/60 ${subtotal ? 'bg-muted/40' : ''}`} data-testid={testId}>
      <td className={`py-1 pr-3 ${indent ? 'pl-4' : ''} ${subtotal ? 'font-medium text-foreground' : 'text-foreground/85'}`}>
        {name}{note ? <span className="ml-1.5 text-[11px] font-normal text-muted-foreground">{note}</span> : null}
      </td>
      <td className="py-1 pr-3 text-right tabular-nums text-foreground/85">{pct}%</td>
      <td className="py-1 pr-3 text-right tabular-nums text-muted-foreground">{r.got ?? 0}</td>
      <td className="py-1 pr-3">
        <span className="flex items-center gap-2">
          <span className="relative h-1.5 w-32 rounded-full bg-muted" aria-hidden="true">
            <span className="absolute inset-y-0 left-0 rounded-full bg-primary/60" style={{ width: `${Math.min(100, r.gotPct ?? 0)}%` }} />
            <span className="absolute -top-0.5 h-2.5 w-px bg-foreground/60" style={{ left: `${Math.min(100, pct)}%` }} />
          </span>
          <span className="tabular-nums text-muted-foreground">{r.gotPct === null || r.gotPct === undefined ? '—' : `${r.gotPct}%`}</span>
        </span>
      </td>
      <td className={`py-1 tabular-nums text-muted-foreground ${availability ? 'pr-3' : ''}`}>{r.rulePicked ? `${r.ruleMatched} of ${r.rulePicked}` : '—'}</td>
      {availability ? (
        <td className="py-1" data-testid={subtotal ? undefined : `shares-away-${r.techId}`}>
          {subtotal ? null : <AwayCell away={r.away} pastDays={availability.past?.days || days} aheadDays={availability.ahead?.days || 14} />}
        </td>
      ) : null}
    </tr>
  );
}

export default function SharesTab({ workspaceTimezone = 'America/Vancouver' }) {
  const [days, setDays] = useState(14);
  const [selected, setSelected] = useState(null); // a rule id, NEW, or null = the server's first rule
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [draft, setDraft] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [draftPreview, setDraftPreview] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState(null);
  const previewSeq = useRef(0);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const res = await assignmentSharesAPI.get(days, selected || undefined);
      const next = res?.data || null;
      setData(next);
      setDraft((current) => {
        if (current) return current;
        if (selected === NEW) return emptyRule();
        const id = selected || next?.ruleId || null;
        return pickRule((next?.settings?.rules || []).find((r) => r.id === id) || null);
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load the shares');
    }
    setLoading(false);
  }, [days, selected]);
  useEffect(() => { load(); }, [load]);

  const settings = data?.settings || null;
  const rules = useMemo(() => settings?.rules || [], [settings]);
  const activeId = selected || data?.ruleId || null;
  const isNew = activeId === NEW;
  const savedRule = isNew ? null : rules.find((r) => r.id === activeId) || null;
  const canManage = data?.canManage === true;
  const people = useMemo(() => data?.people || [], [data]);
  const nameOf = useMemo(() => {
    const map = new Map(people.map((p) => [p.id, p.name]));
    return (id) => map.get(Number(id)) || `Technician ${id}`;
  }, [people]);
  const groupsById = useMemo(() => new Map((data?.groups || []).map((g) => [g.id, g])), [data]);
  const categoryNames = useMemo(() => new Map((data?.categories || []).flatMap((c) => [[c.id, c.name], ...c.subcategories.map((s) => [s.id, s.name])])), [data]);
  const savedDraft = useMemo(() => pickRule(savedRule), [savedRule]);
  const changed = Boolean(draft && data && !sameDraft(draft, savedDraft));
  const ctx = { groupsById, nameOf };
  const problems = draft ? draftProblems(draft, ctx) : [];
  const locked = !canManage || saving;
  const owners = useMemo(() => categoryOwners(rules, activeId, categoryNames), [rules, activeId, categoryNames]);

  // The preview follows the draft: the saved one comes with the page, an
  // unsaved one is asked for (a moment after the last change).
  const previewKey = draft ? shareFields(draft) : '';
  const savedKey = shareFields(savedDraft);
  const useSavedPreview = !isNew && previewKey === savedKey;
  useEffect(() => {
    if (!draft || useSavedPreview) { setDraftPreview(null); return undefined; }
    const ready = draft.categoryIds.length && hasShares(draft) && !draftProblems({ ...draft, mode: 'off' }, ctx).length;
    if (!ready) { setDraftPreview({ ready: false, picks: [], out: [], counts: [] }); return undefined; }
    const seq = previewSeq.current + 1;
    previewSeq.current = seq;
    const timer = setTimeout(async () => {
      try {
        const res = await assignmentSharesAPI.preview({
          ruleId: activeId || NEW, period: draft.period, categoryIds: draft.categoryIds, members: draft.members, groups: draft.groups, rest: draft.rest,
        });
        if (previewSeq.current === seq) setDraftPreview(res?.data || null);
      } catch {
        if (previewSeq.current === seq) setDraftPreview(null);
      }
    }, 400);
    return () => clearTimeout(timer);
  // eslint-disable-next-line react-hooks/exhaustive-deps -- previewKey is the draft's preview fields, serialised
  }, [previewKey, savedKey, useSavedPreview, activeId]);
  // The page's data is for one rule; until a switch has loaded, it is the previous rule's.
  const loadedForActive = Boolean(data) && (isNew ? !data.ruleId : data.ruleId === activeId);
  const preview = draftPreview || (useSavedPreview && loadedForActive ? data?.preview : null);

  const update = (patch) => { setSaved(false); setSaveError(null); setConfirmDelete(false); setDraft((d) => ({ ...d, ...patch })); };

  const switchTo = (id) => {
    setSelected(id);
    setDraft(id === NEW ? emptyRule() : pickRule(rules.find((r) => r.id === id) || null));
    setDraftPreview(null);
    setSaved(false); setSaveError(null); setConfirmDelete(false); setPendingSwitch(null);
  };
  const askSwitch = (id) => {
    if (id === activeId) return;
    if (changed) setPendingSwitch(id);
    else switchTo(id);
  };

  const save = async () => {
    if (!changed || problems.length) return;
    setSaving(true); setSaveError(null);
    try {
      const res = await assignmentSharesAPI.saveSettings({ rule: { ...draft, id: isNew ? undefined : draft.id } });
      const next = res?.data?.settings;
      const id = res?.data?.ruleId || activeId;
      if (next) {
        setData((d) => ({ ...d, settings: next }));
        setDraft(pickRule((next.rules || []).find((r) => r.id === id) || null));
      }
      setSaved(true);
      if (id !== selected) setSelected(id); else load();
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not save');
    }
    setSaving(false);
  };

  const remove = async () => {
    if (!savedRule) { switchTo(rules[0]?.id || null); return; }
    setSaving(true); setSaveError(null);
    try {
      const res = await assignmentSharesAPI.saveSettings({ removeRuleId: savedRule.id });
      const next = res?.data?.settings;
      if (next) setData((d) => ({ ...d, settings: next }));
      const first = next?.rules?.[0]?.id || null;
      setDraft(first ? pickRule(next.rules[0]) : null);
      setConfirmDelete(false);
      setSelected(first);
      if (first === selected) load();
    } catch (err) {
      setSaveError(err.response?.data?.message || err.message || 'Could not delete');
    }
    setSaving(false);
  };

  if (!data && loading) {
    return <div className="flex items-center gap-2 py-10 text-sm text-muted-foreground"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading…</div>;
  }
  if (!data) {
    return <p className="py-10 text-sm text-destructive" role="alert">{error || 'Could not load the shares'}</p>;
  }

  // ---- the header ------------------------------------------------------------
  const on = rules.filter((r) => r.mode !== 'off');
  const live = rules.filter((r) => r.mode === 'live').length;
  const shadow = rules.filter((r) => r.mode === 'shadow').length;
  let verdict = 'No rules yet.';
  if (rules.length === 1) {
    verdict = {
      off: 'Off for this workspace.',
      shadow: 'Shadow: recording who the rule would pick. Nothing changes.',
      live: 'Live: the rule picks the person for tickets in the chosen categories.',
    }[rules[0].mode] || '';
  } else if (rules.length && !on.length) verdict = 'Off for this workspace.';
  else if (rules.length) verdict = `${plural(rules.length, 'rule')}: ${[live ? `${live} Live` : '', shadow ? `${shadow} in Shadow` : '', rules.length - on.length ? `${rules.length - on.length} off` : ''].filter(Boolean).join(', ')}.`;

  const ruleName = (r) => ruleLabel(r, categoryNames);

  return (
    <div className="space-y-6" data-testid="shares-tab">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <PieChart className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Shares
          </h3>
          <p className="text-xs text-muted-foreground">
            Tickets in the categories a rule covers go to people by the shares you set, best effort, so nobody ends up with far more than their part. Each category can be in one rule. {verdict}
          </p>
        </div>
        <button type="button" onClick={load} className="tp-focus-ring shrink-0 rounded p-1 text-muted-foreground hover:text-foreground" aria-label="Refresh">
          <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
        </button>
      </div>

      {/* ---- the rules ---- */}
      <section aria-labelledby="shares-rules" className="space-y-1">
        <h4 id="shares-rules" className="text-xs font-medium text-muted-foreground">Rules</h4>
        {rules.length === 0 && !isNew ? (
          <p className="text-xs text-muted-foreground/75">No rules yet. A rule picks some categories and says who takes those tickets.</p>
        ) : (
          <ul className="max-w-2xl divide-y divide-border border-y border-border" aria-label="Rules" data-testid="shares-rules">
            {rules.map((r) => {
              const current = r.id === activeId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => askSwitch(r.id)}
                    aria-current={current ? 'true' : undefined}
                    className={`tp-focus-ring flex w-full items-center gap-3 px-2 py-2 text-left text-sm hover:bg-muted/60 ${current ? 'bg-muted' : ''}`}
                  >
                    <span className="min-w-0 flex-1">
                      <span className={`block truncate ${current ? 'font-medium text-foreground' : 'text-foreground'}`}>{ruleName(r)}</span>
                      <span className="block truncate text-xs text-muted-foreground">{ruleSummary(r, ctx)}</span>
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                      <span className={`h-1.5 w-1.5 rounded-full ${MODE_DOT[r.mode] || MODE_DOT.off}`} aria-hidden="true" />
                      {MODE_WORDS[r.mode]?.label || 'Off'}
                    </span>
                  </button>
                </li>
              );
            })}
            {isNew ? (
              <li>
                <div aria-current="true" className="flex items-center gap-3 bg-muted px-2 py-2 text-sm">
                  <span className="min-w-0 flex-1 font-medium text-foreground">{draft?.name || 'New rule'}<span className="ml-1.5 text-xs font-normal text-muted-foreground">not saved yet</span></span>
                </div>
              </li>
            ) : null}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
          {canManage && !isNew ? (
            <button type="button" onClick={() => askSwitch(NEW)} disabled={saving}
              className="tp-focus-ring inline-flex items-center gap-1 rounded px-1 py-0.5 font-medium text-primary hover:underline disabled:opacity-50">
              <Plus className="h-3.5 w-3.5" aria-hidden="true" /> Add a rule
            </button>
          ) : null}
          {!canManage ? <span className="text-muted-foreground">Only an admin can change these.</span> : null}
        </div>
        {pendingSwitch ? (
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs text-foreground/85" role="alert">
            <span>“{draft?.name || (savedRule ? ruleName(savedRule) : 'New rule')}” has changes that are not saved.</span>
            <button type="button" onClick={() => switchTo(pendingSwitch)} className={TEXT_BUTTON}>Discard them</button>
            <button type="button" onClick={() => setPendingSwitch(null)} className={TEXT_BUTTON}>Keep editing</button>
          </div>
        ) : null}
        {settings?.history?.length ? (
          <details className="pt-1 text-xs text-muted-foreground">
            <summary className="tp-focus-ring cursor-pointer rounded">Earlier changes ({settings.history.length})</summary>
            <ul className="mt-1 space-y-0.5">
              {settings.history.map((h) => (
                <li key={`${h.at}-${h.ruleId || ''}`}>
                  {formatDateTimeInTimezone(h.at, workspaceTimezone)}{h.by ? `, ${h.by}` : ''}: {h.rule ? `${h.rule}: ` : ''}
                  {(h.changes || []).map((c) => (c.field === 'rule' ? (c.to === 'removed' ? 'rule deleted' : 'rule added') : `${FIELD_WORDS[c.field] || c.field} changed`)).join(', ')}
                </li>
              ))}
            </ul>
          </details>
        ) : null}
      </section>

      {draft && (isNew || savedRule) ? (
        <RuleEditor
          key={activeId}
          draft={draft}
          savedRule={savedRule}
          isNew={isNew}
          data={data}
          people={people}
          nameOf={nameOf}
          groupsById={groupsById}
          owners={owners}
          locked={locked}
          canManage={canManage}
          changed={changed}
          problems={problems}
          saving={saving}
          saved={saved}
          saveError={saveError}
          confirmDelete={confirmDelete}
          setConfirmDelete={setConfirmDelete}
          update={update}
          onSave={save}
          onDelete={remove}
          ruleName={ruleName}
          workspaceTimezone={workspaceTimezone}
          preview={preview}
          days={days}
          setDays={setDays}
          loadedForActive={loadedForActive}
        />
      ) : null}
    </div>
  );
}

function RuleEditor({
  draft, savedRule, isNew, data, people, nameOf, groupsById, owners, locked, canManage, changed, problems, saving, saved, saveError,
  confirmDelete, setConfirmDelete, update, onSave, onDelete, ruleName, workspaceTimezone, preview, days, setDays, loadedForActive,
}) {
  const [addingPerson, setAddingPerson] = useState('');
  const [addingGroup, setAddingGroup] = useState('');
  const [addingRest, setAddingRest] = useState('');

  const placed = new Set([
    ...draft.members.map((m) => m.techId),
    ...draft.groups.flatMap((g) => groupsById.get(g.groupId)?.memberIds || []),
    ...(restOn(draft) ? draft.rest.techIds : []),
  ]);
  const available = people.filter((p) => !placed.has(p.id));
  const availableGroups = (data.groups || []).filter((g) => !draft.groups.some((x) => x.groupId === g.id));
  const named = explicitPct(draft);
  const rest = restPct(draft);
  const restCount = draft.rest.techIds.length;
  const anyShares = draft.members.length || draft.groups.length || restOn(draft);

  const setMemberPct = (techId, value) => update({ members: draft.members.map((m) => (m.techId === techId ? { ...m, pct: value === '' ? '' : Number(value) } : m)) });
  const setGroupPct = (groupId, value) => update({ groups: draft.groups.map((g) => (g.groupId === groupId ? { ...g, pct: value === '' ? '' : Number(value) } : g)) });
  const left = () => Math.max(1, Math.min(100, 100 - named));
  const addPerson = (techId) => {
    const id = Number(techId);
    if (!id || placed.has(id)) return;
    update({ members: [...draft.members, { techId: id, pct: left() }] });
    setAddingPerson('');
  };
  const addGroup = (groupId) => {
    const id = Number(groupId);
    if (!id || draft.groups.some((g) => g.groupId === id)) return;
    update({ groups: [...draft.groups, { groupId: id, pct: left() }] });
    setAddingGroup('');
  };
  const addRest = (techId) => {
    const id = Number(techId);
    if (!id || placed.has(id)) return;
    update({ rest: { evenly: true, techIds: [...draft.rest.techIds, id] } });
    setAddingRest('');
  };
  // "Split evenly" (the people named on their own): what the groups leave, shared out in whole percents.
  const splitEvenly = () => {
    const n = draft.members.length;
    if (!n) return;
    const pot = Math.max(n, 100 - total(draft.groups));
    const base = Math.floor(pot / n);
    let extra = pot - base * n;
    update({ members: draft.members.map((m) => { const add = extra > 0 ? 1 : 0; extra -= add; return { ...m, pct: base + add }; }) });
  };

  let totalText;
  let totalBad = false;
  if (restOn(draft) && restCount) {
    totalBad = named >= 100;
    totalText = totalBad ? `Named shares make ${named}% — nothing is left for the rest` : `Total 100% — the rest gets ${rest}%, ${eachPct(rest, restCount)}% each`;
  } else if (anyShares) {
    totalBad = named !== 100;
    totalText = named === 100 ? 'Total 100%' : named < 100 ? `Total ${named}% — add ${100 - named}% to save` : `Total ${named}% — take off ${named - 100}% to save`;
  } else totalText = 'Total 0%';

  const report = loadedForActive ? data : null;
  const { rows = [], sections = [], totals = null, events = [] } = report || {};
  const availability = report?.availability || null;
  const awayText = awayNote(availability, rows);
  const calendarWords = availability?.calendar === 'business hours' ? 'Settings → Business Hours, holidays left out' : 'Monday to Friday';
  const reportSections = sections.length ? sections : [{ kind: 'people', rows }];
  const label = isNew ? (draft.name || 'New rule') : ruleName(savedRule);

  return (
    <div className="space-y-6 border-t border-border pt-4" data-testid="shares-editor">
      <section aria-labelledby="shares-setup" className="space-y-4">
        <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
          <h4 id="shares-setup" className="text-sm font-semibold text-foreground">{label}</h4>
          <label className="flex items-center gap-1.5 text-xs text-muted-foreground">
            Name
            <input
              type="text"
              value={draft.name}
              maxLength={80}
              disabled={locked}
              placeholder={ruleName({ ...draft, name: '' })}
              onChange={(e) => update({ name: e.target.value })}
              className={`${INPUT} w-56`}
            />
          </label>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">1. Categories</div>
          <p className="text-xs text-muted-foreground">Only tickets in these categories. A top category includes all its subcategories. A category another rule covers is greyed out. Every other ticket is suggested and assigned as before.</p>
          <CategoryPicker categories={data.categories || []} selected={draft.categoryIds} disabled={locked} owners={owners} onChange={(categoryIds) => update({ categoryIds })} />
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">2. Who takes them</div>
          <p className="text-xs text-muted-foreground">A group’s share is split evenly across the people in it, and follows the group as people join or leave. Each person can be in one place only.</p>
          {!anyShares ? (
            <p className="text-xs text-muted-foreground/75">Nobody yet. Add a group or the people who share these tickets.</p>
          ) : (
            <ul className="max-w-xl divide-y divide-border border-y border-border" aria-label="Who takes them">
              {draft.groups.map((g) => {
                const info = groupsById.get(g.groupId) || null;
                const gname = info?.name || 'A group that is no longer active';
                const memberIds = info?.memberIds || [];
                return (
                  <li key={`g${g.groupId}`} className="py-1.5 text-sm" data-testid={`shares-group-row-${g.groupId}`}>
                    <div className="flex items-center gap-3">
                      <span className="min-w-0 flex-1 truncate text-foreground">{gname}<span className="ml-1.5 text-xs text-muted-foreground">group</span></span>
                      <PctInput value={g.pct} label={`Share for ${gname}, percent`} disabled={locked} onChange={(v) => setGroupPct(g.groupId, v)} />
                      {canManage ? <RemoveButton label={`Remove ${gname}`} disabled={locked} onClick={() => update({ groups: draft.groups.filter((x) => x.groupId !== g.groupId) })} /> : null}
                    </div>
                    {memberIds.length ? (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {memberIds.map(nameOf).join(', ')}
                        {Number(g.pct) > 0 ? <span className="tabular-nums"> — about {eachPct(Number(g.pct), memberIds.length)}% each</span> : null}
                      </p>
                    ) : (
                      <p className="mt-0.5 flex items-center gap-1 text-xs text-amber-700 dark:text-amber-300">
                        <AlertTriangle className="h-3 w-3 shrink-0" aria-hidden="true" />
                        {info ? 'Nobody in this group yet. Its share goes to the others until someone joins.' : 'Its share goes to the others. Remove it or pick another group.'}
                      </p>
                    )}
                  </li>
                );
              })}
              {draft.members.map((m) => {
                const name = nameOf(m.techId);
                return (
                  <li key={`p${m.techId}`} className="flex items-center gap-3 py-1.5 text-sm">
                    <span className="min-w-0 flex-1 truncate text-foreground">{name}</span>
                    <PctInput value={m.pct} label={`Share for ${name}, percent`} disabled={locked} onChange={(v) => setMemberPct(m.techId, v)} />
                    {canManage ? <RemoveButton label={`Remove ${name}`} disabled={locked} onClick={() => update({ members: draft.members.filter((x) => x.techId !== m.techId) })} /> : null}
                  </li>
                );
              })}
              {restOn(draft) ? (
                <li className="py-1.5 text-sm" data-testid="shares-rest-row">
                  <div className="flex items-center gap-3">
                    <span className="min-w-0 flex-1 text-foreground">The rest, split evenly</span>
                    <span className="tabular-nums text-muted-foreground">{rest}%</span>
                    {canManage ? <RemoveButton label="Stop splitting the rest" disabled={locked} onClick={() => update({ rest: { evenly: false, techIds: [] } })} /> : null}
                  </div>
                  {restCount ? (
                    <ul className="mt-0.5 space-y-0.5 pl-3" aria-label="People who split the rest">
                      {draft.rest.techIds.map((id) => (
                        <li key={id} className="flex items-center gap-2 text-xs text-muted-foreground">
                          <span className="min-w-0 flex-1 truncate text-foreground/85">{nameOf(id)}</span>
                          <span className="tabular-nums">{eachPct(rest, restCount)}%</span>
                          {canManage ? <RemoveButton label={`Remove ${nameOf(id)} from the rest`} disabled={locked} onClick={() => update({ rest: { evenly: true, techIds: draft.rest.techIds.filter((x) => x !== id) } })} /> : null}
                        </li>
                      ))}
                    </ul>
                  ) : <p className="mt-0.5 pl-3 text-xs text-muted-foreground/75">Pick the people who split the rest.</p>}
                  {canManage ? (
                    <div className="mt-1 pl-3">
                      <select value={addingRest} disabled={locked || !available.length} onChange={(e) => addRest(e.target.value)} aria-label="Add person to the rest" className={INPUT}>
                        <option value="">Add person to the rest…</option>
                        {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                      </select>
                    </div>
                  ) : null}
                </li>
              ) : null}
            </ul>
          )}
          <div className="flex flex-wrap items-center gap-3 pt-1 text-xs">
            <span className={`tabular-nums ${anyShares && totalBad ? 'font-medium text-destructive' : 'text-muted-foreground'}`} data-testid="shares-total">{totalText}</span>
            {canManage ? (
              <>
                <select value={addingGroup} disabled={locked || !availableGroups.length} onChange={(e) => addGroup(e.target.value)} aria-label="Add group" className={INPUT}
                  title={data.groups?.length ? undefined : 'This workspace has no internal groups'}>
                  <option value="">Add group…</option>
                  {availableGroups.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                </select>
                <select value={addingPerson} disabled={locked || !available.length} onChange={(e) => addPerson(e.target.value)} aria-label="Add person" className={INPUT}>
                  <option value="">Add person…</option>
                  {available.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
                {!restOn(draft) ? (
                  <button type="button" onClick={() => update({ rest: { evenly: true, techIds: [] } })} disabled={locked} className={TEXT_BUTTON}>
                    Split the rest evenly among…
                  </button>
                ) : null}
                {!restOn(draft) ? (
                  <button type="button" onClick={splitEvenly} disabled={locked || !draft.members.length} className={TEXT_BUTTON}>Split evenly</button>
                ) : null}
              </>
            ) : null}
          </div>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">3. Mode</div>
          <Choice name="shares-mode" label="Mode" value={draft.mode} disabled={locked} onChange={(mode) => update({ mode })}
            options={Object.entries(MODE_WORDS).map(([id, w]) => [id, w.label])} />
          <p className="text-xs leading-5 text-muted-foreground">{MODE_WORDS[draft.mode]?.note} Each rule has its own mode, so a new rule can run in Shadow while another is Live.</p>
        </div>

        <div className="space-y-1">
          <div className="text-sm font-medium text-foreground">Count tickets per</div>
          <Choice name="shares-period" label="Count tickets per" value={draft.period} disabled={locked} onChange={(period) => update({ period })}
            options={Object.entries(PERIOD_WORDS)} />
          <p className="text-xs text-muted-foreground">
            {draft.period === 'month' ? 'A month starts on the 1st at 00:00, workspace time.' : 'A week starts Monday 00:00, workspace time.'} The counts start again each {draft.period === 'month' ? 'month' : 'week'}.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground">
          {canManage ? (
            <button
              type="button"
              onClick={onSave}
              disabled={!changed || saving || problems.length > 0}
              className="tp-focus-ring rounded-lg bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          ) : null}
          {changed && problems.length ? <span className="text-destructive" role="alert">{problems.join(' ')}</span> : null}
          {saved && !changed ? <span role="status">Saved. It applies to the next ticket.</span> : null}
          {saveError ? <span className="text-destructive" role="alert">{saveError}</span> : null}
          {savedRule?.updatedAt ? (
            <span>Last changed {formatDateTimeInTimezone(savedRule.updatedAt, workspaceTimezone)}{savedRule.updatedBy ? ` by ${savedRule.updatedBy}` : ''}.</span>
          ) : <span>{isNew ? 'Not saved yet.' : 'Never set up.'}</span>}
          {canManage && !confirmDelete ? (
            <button type="button" onClick={() => (isNew ? onDelete() : setConfirmDelete(true))} disabled={saving} className={`${TEXT_BUTTON} ml-auto`}>
              {isNew ? 'Discard this rule' : 'Delete rule'}
            </button>
          ) : null}
        </div>
        {confirmDelete ? (
          <div className="flex flex-wrap items-center gap-3 text-xs text-foreground/85" role="alert" data-testid="shares-delete-confirm">
            <span>Delete “{label}”? Tickets in its categories go back to the AI’s pick. Its history line stays.</span>
            <button type="button" onClick={onDelete} disabled={saving} className="tp-focus-ring rounded-lg bg-destructive px-3 py-1.5 font-medium text-destructive-foreground disabled:opacity-50">Delete</button>
            <button type="button" onClick={() => setConfirmDelete(false)} className={TEXT_BUTTON}>Keep it</button>
          </div>
        ) : null}
      </section>

      <section aria-labelledby="shares-preview">
        <h4 id="shares-preview" className="mb-1 text-xs font-medium text-muted-foreground">Preview{changed ? ' (not saved yet)' : ''}</h4>
        {!preview || !preview.ready ? (
          <p className="text-xs text-muted-foreground/75">Pick categories and shares that total 100% to see who the next tickets would go to.</p>
        ) : (
          <div className="space-y-2 text-sm text-foreground/85" data-testid="shares-preview">
            <p>
              <span className="text-muted-foreground">The next {preview.picks.length} tickets would go to: </span>
              {preview.picks.map((p) => p.name).join(', ') || 'nobody (everyone on the list is out)'}.
            </p>
            {preview.out?.length ? (
              <p className="text-xs text-muted-foreground">Out now: {preview.out.map((o) => `${o.name} (${o.why})`).join(', ')}.</p>
            ) : null}
            <Warnings items={preview.warnings} testId="shares-preview-warnings" />
            {preview.sections?.length ? (
              <div className="text-xs text-muted-foreground" data-testid="shares-preview-counts">
                <p>{preview.period?.kind === 'month' ? 'This month' : 'This week'} so far, with about what each share comes to:</p>
                <ul className="mt-0.5 space-y-0.5">
                  {preview.sections.map((s) => (s.kind === 'people' ? (
                    <li key="people">{s.rows.map((c) => `${c.name} ${c.count} of about ${c.target} (${c.pct}%)`).join(' · ')}</li>
                  ) : (
                    <li key={`${s.kind}${s.id ?? ''}`}>
                      <span className="font-medium text-foreground/85">{s.name}</span> {s.count ?? 0} of about {s.target ?? 0} ({s.pct}%){s.empty ? ' — nobody in it now' : ''}
                      {s.rows.length ? <div className="pl-3">{s.rows.map((c) => `${c.name} ${c.count} of about ${c.target} (${c.pct}%)`).join(' · ')}</div> : null}
                    </li>
                  )))}
                </ul>
              </div>
            ) : preview.counts?.length ? (
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
        {isNew ? (
          <p className="text-xs text-muted-foreground/75">Save the rule to see how its split works out.</p>
        ) : !report ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground"><Activity className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Loading…</p>
        ) : !totals ? (
          <div className="space-y-1">
            <p className="text-xs text-muted-foreground/75">Set up the categories and people first.</p>
            <Warnings items={report.warnings} testId="shares-report-warnings" />
          </div>
        ) : (
          <div className="space-y-3">
            <p className="text-sm text-foreground/85" data-testid="shares-agreement">
              {totals.compared
                ? `The rule’s pick matched who really got the ticket on ${totals.agreed} of ${plural(totals.compared, 'ticket')} (${percent(totals.agreed, totals.compared)}%).${totals.aiCompared ? ` The AI’s first suggestion matched on ${totals.aiAgreed} of ${totals.aiCompared}.` : ''}`
                : 'No ticket has a rule pick to compare yet. In Shadow, each new ticket in these categories records one.'}
            </p>
            <Warnings items={report.warnings} testId="shares-report-warnings" />
            <div className="overflow-x-auto">
              <table className={`w-full text-xs ${availability ? 'min-w-[760px]' : 'min-w-[560px]'}`}>
                <thead>
                  <tr className="border-b border-border text-left text-muted-foreground">
                    <th className="py-1 pr-3 font-medium">Person</th>
                    <th className="py-1 pr-3 text-right font-medium">Share</th>
                    <th className="py-1 pr-3 text-right font-medium">Tickets they got</th>
                    <th className="py-1 pr-3 font-medium">Part of the split</th>
                    <th className={`py-1 font-medium ${availability ? 'pr-3' : ''}`}>When the rule picked them, they got it</th>
                    {availability ? (
                      <th
                        className="py-1 font-medium"
                        title={`Working days on approved leave (${calendarWords}), in the last ${availability.past?.days || days} days and the next ${availability.ahead?.days || 14}. Working from home does not count; a half day counts as half.`}
                      >
                        Away
                      </th>
                    ) : null}
                  </tr>
                </thead>
                <tbody>
                  {reportSections.flatMap((s) => {
                    if (s.kind === 'people') {
                      return s.rows.map((r) => <ReportRow key={r.techId} r={r} name={r.name} availability={availability} days={days} />);
                    }
                    const head = (
                      <ReportRow
                        key={`${s.kind}${s.id ?? ''}`}
                        r={s}
                        name={s.name}
                        subtotal
                        note={s.kind === 'group' ? (s.empty ? 'group, nobody in it now' : 'group') : (s.empty ? 'nobody in it now' : null)}
                        availability={availability}
                        days={days}
                        testId={s.kind === 'group' ? `shares-group-${s.id}` : 'shares-rest'}
                      />
                    );
                    return [head, ...s.rows.map((r) => <ReportRow key={r.techId} r={r} name={r.name} indent availability={availability} days={days} />)];
                  })}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-muted-foreground">
              {plural(totals.tickets, 'ticket')} in these categories. The bar is the part each person (or group) got; the mark is their share.
              {totals.outside ? ` ${totals.outside} went to people not on the rule.` : ''}
              {totals.unassigned ? ` ${totals.unassigned} not assigned yet.` : ''}
            </p>
            {/* QA 11-06 #4: days away, so the admin can tell leave from an uneven split. */}
            {awayText ? (
              <p className="text-xs text-muted-foreground" data-testid="shares-away-note">{awayText}</p>
            ) : null}
            {/* QA 10-20 #4: say who really decided these tickets. */}
            {Number.isFinite(totals.selfPicked) && totals.selfPicked > 0 && (
              <p className="text-xs text-muted-foreground" data-testid="shares-self-picked">
                {`${totals.selfPicked} of ${plural(totals.toMembers + totals.outside, 'assigned ticket')} were taken by the person themselves, from the queue. Neither the rule nor the AI decides those, so the split follows who picks them up.`}
                {savedRule?.mode === 'shadow' ? ' The rule is in Shadow: it writes down its pick and changes nothing.' : ''}
              </p>
            )}
          </div>
        )}
      </section>

      {isNew ? null : (
        <section aria-labelledby="shares-events">
          <h4 id="shares-events" className="mb-1 text-xs font-medium text-muted-foreground">Recent rule picks</h4>
          {!report || events.length === 0 ? (
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
      )}
    </div>
  );
}
