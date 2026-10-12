import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ChevronDown, ChevronRight, Lock, Moon, Sun } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { Switch } from '../ui';
import { Loading, textareaClass } from './knowledgeUi';
import { StayQuietList } from './StayQuietEditor';
import { levelLabel, levelOptions, progressWords, readinessState } from './answeringFormat';
import { calibrationWords } from './coverageFormat';

/**
 * Knowledge → Answering (plans/KNOWLEDGE_SIMPLIFY_PLAN.md section 5): one
 * dial per category. What Auto-help may do with an answer there, during
 * business hours and after hours:
 *
 *   Off · Draft only · Suggest to agent · Send when sure
 *
 * A row left alone follows the row above it (subcategory → category →
 * "Everything else"). "Send when sure" opens only once the category has
 * earned it on its own reviewed answers, and never for a category that is
 * always checked by a person. Each answer's own confidence can only move it
 * down a level, never up.
 */

const DOT = { ready: 'bg-emerald-500', progress: 'bg-amber-500', none: 'bg-muted-foreground/40', locked: 'bg-muted-foreground/60' };

function LevelSelect({ label, value, inherited, parentName, canSend, sendLockedWhy, disabled, onChange, testId }) {
  const options = useMemo(() => levelOptions({ inherited, parentName, canSend, sendLockedWhy }), [inherited, parentName, canSend, sendLockedWhy]);
  return (
    <FancySelect
      value={value ?? ''}
      onChange={(v) => onChange(v === '' ? null : v)}
      options={options}
      disabled={disabled}
      aria-label={label}
      data-testid={testId}
      className="w-full min-w-[10.5rem]"
      renderValue={(opt) => (
        <span className={value ? 'text-foreground' : 'text-muted-foreground'}>{value ? opt?.label : levelLabel(inherited)}</span>
      )}
    />
  );
}

function Evidence({ category }) {
  const state = readinessState(category);
  return (
    <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground" data-testid={`answering-evidence-${category.id}`}>
      <span className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${DOT[state.tone]}`} aria-hidden="true" />
      {state.tone === 'locked' && <Lock className="h-3 w-3 flex-shrink-0" aria-hidden="true" />}
      <span>{state.words}</span>
    </span>
  );
}

function RowDetails({ entry, isDefault, canManage, busy, onSave }) {
  const own = entry.own || {};
  const [notes, setNotes] = useState(own.notes || '');
  const [bar, setBar] = useState(own.bar ? String(Math.round(own.bar * 100)) : '');
  useEffect(() => { setNotes(own.notes || ''); setBar(own.bar ? String(Math.round(own.bar * 100)) : ''); }, [own.notes, own.bar]);
  const notesDirty = (own.notes || '') !== notes;
  const barValue = bar === '' ? null : Number(bar) / 100;
  const barDirty = (own.bar ?? null) !== barValue;
  const barValid = bar === '' || (Number.isFinite(Number(bar)) && Number(bar) >= 50 && Number(bar) <= 99);
  const id = `answering-${entry.id ?? 0}`;
  return (
    <div className="grid gap-5 border-t border-border bg-muted/30 px-4 py-4 sm:px-5 lg:grid-cols-2" data-testid={`answering-details-${entry.id ?? 0}`}>
      <div className="space-y-4">
        {!isDefault && (
          <div className="flex items-start gap-3">
            <Switch
              id={`${id}-checked`}
              checked={entry.resolved.alwaysChecked}
              disabled={busy || !canManage}
              onCheckedChange={(v) => onSave({ alwaysChecked: v })}
              aria-label="Always checked by a person"
            />
            <label htmlFor={`${id}-checked`} className="min-w-0 flex-1 cursor-pointer">
              <span className="block text-sm font-medium text-foreground">Always checked by a person</span>
              <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                For passwords, access and security. Answers here go as far as “Suggest to agent” and never send by themselves.
              </span>
            </label>
          </div>
        )}
        <div>
          <label htmlFor={`${id}-bar`} className="block text-sm font-medium text-foreground">How sure an answer must be</label>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            The answer’s own confidence has to reach this before it is suggested or sent. Empty follows the row above ({Math.round(entry.resolved.bar * 100)} %).
          </p>
          <div className="mt-2 flex items-center gap-2">
            <input
              id={`${id}-bar`}
              inputMode="numeric"
              value={bar}
              onChange={(e) => setBar(e.target.value.replace(/[^\d]/g, '').slice(0, 2))}
              disabled={busy || !canManage}
              placeholder={String(Math.round(entry.resolved.bar * 100))}
              className="tp-focus-ring h-9 w-20 rounded-lg border border-input bg-card px-3 text-sm tabular-nums text-foreground placeholder:text-muted-foreground/75"
            />
            <span className="text-sm text-muted-foreground">%</span>
            {canManage && barDirty && (
              <button
                type="button"
                disabled={busy || !barValid}
                onClick={() => onSave({ bar: barValue })}
                className="tp-focus-ring h-9 rounded-lg border border-border bg-card px-3 text-sm font-medium text-foreground hover:bg-muted disabled:opacity-50"
              >
                Save
              </button>
            )}
            {!barValid && <span className="text-xs text-red-600 dark:text-red-300">Between 50 and 99</span>}
          </div>
        </div>
      </div>
      <div className="space-y-4">
        <div>
          <label htmlFor={`${id}-notes`} className="block text-sm font-medium text-foreground">Notes for answers here</label>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
            How to answer, in plain words: tone, what to mention, what never to quote. Facts belong in articles, not here.
          </p>
          <textarea
            id={`${id}-notes`}
            rows={3}
            value={notes}
            maxLength={4000}
            onChange={(e) => setNotes(e.target.value)}
            disabled={busy || !canManage}
            placeholder="For example: use app names exactly as Company Portal spells them. Never quote prices."
            className={`${textareaClass} mt-2`}
          />
          {canManage && notesDirty && (
            <div className="mt-2 flex gap-2">
              <button type="button" disabled={busy} onClick={() => onSave({ notes })} className="tp-focus-ring h-8 rounded-lg bg-primary px-3 text-sm font-medium text-primary-foreground hover:opacity-90 disabled:opacity-50">Save notes</button>
              <button type="button" disabled={busy} onClick={() => setNotes(own.notes || '')} className="tp-focus-ring h-8 rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</button>
            </div>
          )}
        </div>
        <div>
          <p className="text-sm font-medium text-foreground">Stay quiet when</p>
          <p className="mb-2 mt-0.5 text-xs leading-relaxed text-muted-foreground">Extra hard stops for answers here. The workspace list in Settings always applies too.</p>
          <StayQuietList
            values={own.stayQuietWhen || []}
            onChange={(list) => onSave({ stayQuietWhen: list })}
            readOnly={busy || !canManage}
            label={`Stay quiet rules for ${entry.name || 'everything else'}`}
            emptyText="None here."
            testId={`answering-quiet-${entry.id ?? 0}`}
          />
        </div>
      </div>
    </div>
  );
}

function DialRow({ entry, isDefault = false, isSub = false, parentName = null, ready = false, canManage, busyId, open, onToggle, onSave, children = null }) {
  const id = entry.id ?? 0;
  const busy = busyId === id;
  const own = entry.own || {};
  const sendLockedWhy = isDefault
    ? 'Set per category, once that category has earned it'
    : entry.resolved.alwaysChecked ? 'Always checked by a person' : !ready ? 'Not earned yet' : null;
  return (
    <div className={isSub ? '' : 'border-t border-border first:border-t-0'} data-testid={`answering-row-${id}`}>
      <div className={`grid items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:px-5 md:grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] ${isSub ? 'bg-muted/20 py-2.5' : ''}`}>
        <div className="flex min-w-0 items-center gap-2">
          {onToggle ? (
            <button
              type="button"
              onClick={onToggle}
              aria-expanded={open}
              aria-label={`${open ? 'Hide' : 'Show'} details for ${entry.name || 'everything else'}`}
              className="tp-focus-ring -ml-1 inline-flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted"
            >
              {open ? <ChevronDown className="h-4 w-4" aria-hidden="true" /> : <ChevronRight className="h-4 w-4" aria-hidden="true" />}
            </button>
          ) : <span className="w-6 flex-shrink-0" aria-hidden="true" />}
          <div className="min-w-0">
            <p className={`truncate ${isSub ? 'text-[13px] text-foreground/90' : 'text-sm font-medium text-foreground'}`}>{isDefault ? 'Everything else' : entry.name}</p>
            {!isSub && (
              <p className="truncate text-xs text-muted-foreground">
                {isDefault
                  ? 'Categories with no setting of their own'
                  : `${entry.articles === 1 ? '1 article' : `${entry.articles} articles`}${entry.runs30?.total ? ` · ${entry.runs30.answered} of ${entry.runs30.total} answered in 30 days` : ''}`}
              </p>
            )}
          </div>
        </div>
        <div className="flex items-center gap-2 md:block">
          <span className="w-28 flex-shrink-0 text-xs text-muted-foreground md:hidden">Business hours</span>
          <LevelSelect
            label={`Business hours: ${entry.name || 'everything else'}`}
            value={own.dayLevel ?? null}
            inherited={entry.resolved.dayLevel}
            parentName={parentName}
            canSend={!sendLockedWhy}
            sendLockedWhy={sendLockedWhy}
            disabled={busy || !canManage}
            onChange={(v) => onSave({ dayLevel: v })}
            testId={`answering-day-${id}`}
          />
        </div>
        <div className="flex items-center gap-2 md:block">
          <span className="w-28 flex-shrink-0 text-xs text-muted-foreground md:hidden">After hours</span>
          <LevelSelect
            label={`After hours: ${entry.name || 'everything else'}`}
            value={own.nightLevel ?? null}
            inherited={entry.resolved.nightLevel}
            parentName={parentName}
            canSend={!sendLockedWhy}
            sendLockedWhy={sendLockedWhy}
            disabled={busy || !canManage}
            onChange={(v) => onSave({ nightLevel: v })}
            testId={`answering-night-${id}`}
          />
        </div>
        <div className="min-w-0 pl-8 md:pl-0">
          {!isDefault && !isSub && <Evidence category={entry} />}
          {!isDefault && !isSub && entry.readiness && !entry.resolved.alwaysChecked && !entry.readiness.met && readinessState(entry).tone === 'progress' && (
            <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{progressWords(entry.readiness)}</p>
          )}
          {!isDefault && !isSub && calibrationWords(entry.calibration) && (
            <p className={`mt-0.5 text-[11px] ${entry.highReliable === false ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground/80'}`} data-testid={`answering-calibration-${id}`}>
              {entry.highReliable === false ? 'Paused one level down: ' : ''}{calibrationWords(entry.calibration)}
            </p>
          )}
        </div>
      </div>
      {children}
    </div>
  );
}

export default function AnsweringPanel({ canManage = false, onSettingsChange = null }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [open, setOpen] = useState(() => new Set());
  const [switching, setSwitching] = useState(false);
  const [playbooks, setPlaybooks] = useState([]);

  const load = useCallback(() => knowledgeAPI.answering()
    .then((res) => { setData(res?.data || null); setError(null); })
    .catch((err) => setError(err?.message || 'Could not load the answering settings')), []);
  useEffect(() => { load(); }, [load]);
  // Special handling (the playbooks that are left): optional, so a failed read shows none.
  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => knowledgeAPI.listPlaybooks())
      .then((res) => { if (!cancelled) setPlaybooks(Array.isArray(res?.data) ? res.data : []); })
      .catch(() => { if (!cancelled) setPlaybooks([]); });
    return () => { cancelled = true; };
  }, []);

  const save = async (categoryId, patch) => {
    setBusyId(categoryId);
    setError(null);
    try {
      const res = await knowledgeAPI.updateAnswering(categoryId, patch);
      setData((prev) => ({ ...(prev || {}), ...(res?.data || {}) }));
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setBusyId(null);
    }
  };

  const toggleOrder = async (v) => {
    setSwitching(true);
    setError(null);
    try {
      const res = await knowledgeAPI.updateSettings({ knowledgeFirst: v });
      setData((prev) => ({ ...(prev || {}), knowledgeFirst: res?.data?.knowledgeFirst === true }));
      onSettingsChange?.(res?.data || null);
    } catch (err) {
      setError(err?.message || 'Could not change the answering order');
    } finally {
      setSwitching(false);
    }
  };

  if (!data && !error) return <Loading label="Loading answering…" />;
  const manage = canManage && data?.canManage !== false;
  const toggle = (id) => setOpen((prev) => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });

  return (
    <div className="space-y-4" data-testid="answering-panel">
      {error && <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-700 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200" role="alert">{error}</div>}

      {data && (
        <>
          <section className="tp-card px-4 py-4 sm:px-5" aria-labelledby="answering-order-title">
            <div className="flex items-start gap-3">
              <Switch id="answering-order" checked={data.knowledgeFirst} disabled={switching || !manage} onCheckedChange={toggleOrder} aria-label="Answer from Knowledge first" />
              <label htmlFor="answering-order" className="min-w-0 flex-1 cursor-pointer">
                <span id="answering-order-title" className="block text-sm font-semibold text-foreground">Answer from Knowledge first</span>
                <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">
                  {data.knowledgeFirst
                    ? 'On. Every new ticket that passes the safety rules is checked against the articles. A playbook is only needed for special handling. The table below decides what happens to each answer.'
                    : 'Off. A ticket is only answered when a playbook fits it, and the table below is not used yet. Switch this on to answer from the articles in every category.'}
                </span>
                {!data.enabled && <span className="mt-1 block text-xs text-amber-700 dark:text-amber-300">Auto-help is switched off for this workspace (Settings), so nothing is drafted either way.</span>}
              </label>
            </div>
          </section>

          <section className="tp-card overflow-hidden" aria-label="What Auto-help may do, by category">
            <div className="hidden grid-cols-[minmax(0,1.5fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1.1fr)] gap-x-4 border-b border-border px-5 py-2.5 text-xs font-medium text-muted-foreground md:grid">
              <span className="pl-8">Category</span>
              <span className="inline-flex items-center gap-1.5"><Sun className="h-3.5 w-3.5" aria-hidden="true" /> Business hours{data.afterHoursNow === false ? ' · now' : ''}</span>
              <span className="inline-flex items-center gap-1.5"><Moon className="h-3.5 w-3.5" aria-hidden="true" /> After hours{data.afterHoursNow === true ? ' · now' : ''}</span>
              <span>Toward “Send when sure”</span>
            </div>
            <DialRow
              entry={{ id: 0, name: null, ...data.default }}
              isDefault
              canManage={manage}
              busyId={busyId}
              open={open.has(0)}
              onToggle={() => toggle(0)}
              onSave={(patch) => save(0, patch)}
            >
              {open.has(0) && <RowDetails entry={{ id: 0, name: null, ...data.default }} isDefault canManage={manage} busy={busyId === 0} onSave={(patch) => save(0, patch)} />}
            </DialRow>
            {(data.categories || []).map((cat) => (
              <DialRow
                key={cat.id}
                entry={cat}
                parentName="Everything else"
                ready={cat.readiness?.met === true}
                canManage={manage}
                busyId={busyId}
                open={open.has(cat.id)}
                onToggle={() => toggle(cat.id)}
                onSave={(patch) => save(cat.id, patch)}
              >
                {open.has(cat.id) && (
                  <>
                    <RowDetails entry={cat} canManage={manage} busy={busyId === cat.id} onSave={(patch) => save(cat.id, patch)} />
                    {(cat.subcategories || []).length > 0 && (
                      <div className="border-t border-border" data-testid={`answering-subs-${cat.id}`}>
                        <p className="bg-muted/20 px-4 pb-1 pt-3 text-xs font-medium text-muted-foreground sm:px-5">Subcategories follow {cat.name} unless set here</p>
                        {cat.subcategories.map((sub) => (
                          <DialRow
                            key={sub.id}
                            entry={sub}
                            isSub
                            parentName={cat.name}
                            ready={cat.readiness?.met === true}
                            canManage={manage}
                            busyId={busyId}
                            onSave={(patch) => save(sub.id, patch)}
                          />
                        ))}
                      </div>
                    )}
                  </>
                )}
              </DialRow>
            ))}
          </section>

          <section className="tp-card px-4 py-4 sm:px-5" aria-labelledby="answering-special-title" data-testid="answering-special">
            <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <h2 id="answering-special-title" className="text-sm font-semibold text-foreground">Special handling</h2>
              <Link to="/knowledge/playbooks" className="tp-focus-ring rounded text-xs font-medium text-primary hover:underline">Manage</Link>
            </div>
            <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
              Most tickets are answered from the articles alone. A few kinds of request need their own instructions, tools or questions; each of those has a playbook.
            </p>
            {(() => {
              const special = playbooks.filter((pb) => !pb.isDefault);
              const base = playbooks.find((pb) => pb.isDefault);
              return (
                <ul className="mt-3 divide-y divide-border/60">
                  {special.length === 0 && <li className="py-2 text-[13px] text-muted-foreground">None. Every ticket is answered from the articles.</li>}
                  {special.map((pb) => (
                    <li key={pb.id} className="flex flex-wrap items-center gap-x-3 gap-y-0.5 py-2">
                      <Link to={`/knowledge/playbooks/${pb.id}`} className="tp-focus-ring min-w-0 truncate rounded text-[13px] font-medium text-foreground hover:underline">{pb.name}</Link>
                      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
                        <span className={`h-1.5 w-1.5 rounded-full ${pb.enabled ? 'bg-emerald-500' : 'bg-muted-foreground/40'}`} aria-hidden="true" />
                        {pb.enabled ? 'On' : 'Off'}
                      </span>
                      {pb.match?.whenToHelp && <span className="min-w-0 flex-1 basis-full truncate text-xs text-muted-foreground sm:basis-0">{pb.match.whenToHelp}</span>}
                    </li>
                  ))}
                  {base && (
                    <li className="flex flex-wrap items-center gap-x-3 py-2">
                      <Link to={`/knowledge/playbooks/${base.id}`} className="tp-focus-ring rounded text-[13px] font-medium text-foreground hover:underline">Everything else</Link>
                      <span className="text-xs text-muted-foreground">Follow-up, tools and wording for answers that have no special handling</span>
                    </li>
                  )}
                </ul>
              );
            })()}
          </section>

          <p className="px-1 text-xs leading-relaxed text-muted-foreground">
            Each answer is also judged on how sure it is. A sure answer gets the level set here; a less sure one drops a level; a doubtful one is only recorded.
            “Send when sure” opens for a category after {data.readinessBar?.minReviewed ?? 30} reviewed answers with at least {data.readinessBar?.minGoodPct ?? 85} % good.
          </p>
        </>
      )}
    </div>
  );
}
