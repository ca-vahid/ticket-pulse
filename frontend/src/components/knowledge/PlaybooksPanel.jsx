import { useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, BookMarked, Eye, Lock, Plus, Trash2 } from 'lucide-react';
import { knowledgeAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { Switch } from '../ui';
import { timeAgo } from '../tickets/ticketUi';
import PlaybookTestBox from './PlaybookTestBox';
import {
  ConfirmDialog, EmptyState, GuardedLink, Loading, SectionTitle, inputClass, labelClass, textareaClass, useUnsavedGuard,
} from './knowledgeUi';
import { categoryLabel } from './knowledgeFormat';

const NEW_PLAYBOOK = {
  name: '',
  enabled: false,
  categoryId: null,
  subcategoryIds: [],
  match: { keywords: [], excludeKeywords: [] },
  instructions: '',
  instructionsAreSource: false,
  allowedTools: ['search_knowledge', 'get_article', 'get_ticket_details'],
  kbScope: { mode: 'all', tags: [], includeVerifiedSolutions: true },
  minConfidence: 0.8,
  followUp: null,
  priority: 100,
};

// Same wording as the server default (autoHelpPlaybookService.DEFAULT_NUDGE_TEXT);
// {{days}} is filled from "Close after".
export const FALLBACK_NUDGE_TEXT = "Hope that sorted it out. If we don't hear back, we'll close this ticket in {{days}} — just reply if you still need a hand.";

const INSTRUCTIONS_HINT = 'Say when this playbook should answer, what a good answer looks like, and when it must stay quiet. The model only answers from these instructions and the knowledge it finds — it never guesses.';

function words(list) {
  return (list || []).join(', ');
}
function splitWords(text) {
  return String(text || '').split(/[\n,]/).map((w) => w.trim()).filter(Boolean);
}

function PlaybookList({ categories, canManage }) {
  const navigate = useNavigate();
  const [items, setItems] = useState(null);
  const [error, setError] = useState(null);
  const [busyId, setBusyId] = useState(null);

  useEffect(() => {
    let cancelled = false;
    knowledgeAPI.listPlaybooks()
      .then((res) => { if (!cancelled) setItems(res?.data || []); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load playbooks'); });
    return () => { cancelled = true; };
  }, []);

  const toggle = async (pb, enabled) => {
    setBusyId(pb.id);
    setError(null);
    try {
      const res = await knowledgeAPI.updatePlaybook(pb.id, { enabled });
      setItems((list) => list.map((x) => (x.id === pb.id ? { ...x, ...res.data } : x)));
    } catch (err) {
      setError(err?.message || 'Could not switch the playbook');
    } finally {
      setBusyId(null);
    }
  };

  if (!items && !error) return <Loading label="Loading playbooks…" />;

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <p className="min-w-0 flex-1 text-xs text-muted-foreground">
          A playbook answers one kind of request. When two fit a ticket, the higher priority runs.
        </p>
        {canManage && (
          <button
            type="button"
            onClick={() => navigate('/knowledge/playbooks/new')}
            className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg bg-primary px-3 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <Plus className="h-4 w-4" aria-hidden="true" /> New playbook
          </button>
        )}
      </div>
      {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
      {items && items.length === 0 ? (
        <div className="tp-card">
          <EmptyState icon={BookMarked} title="No playbooks yet">
            Start with the requests your team answers the same way every time — software installs, password resets, travel roaming.
          </EmptyState>
        </div>
      ) : items && (
        <ul className="tp-card divide-y divide-border/70 overflow-hidden" data-testid="playbooks-list">
          {items.map((pb) => (
            <li key={pb.id} className="flex items-center gap-3 px-4 py-3 transition-colors hover:bg-muted/40">
              <Link to={`/knowledge/playbooks/${pb.id}`} className="tp-focus-ring min-w-0 flex-1 rounded">
                <p className="truncate text-sm font-medium text-foreground">{pb.name}</p>
                <p className="mt-0.5 truncate text-xs text-muted-foreground">{categoryLabel(categories, pb.categoryId, pb.subcategoryIds)}</p>
                <p className="mt-1 flex flex-wrap items-center gap-x-3 text-[11px] text-muted-foreground/75">
                  <span className="inline-flex items-center gap-1"><Eye className="h-3 w-3" aria-hidden="true" />Shadow</span>
                  <span>priority {pb.priority}</span>
                  <span>{pb.lastRunAt ? `last run ${timeAgo(pb.lastRunAt)} · ${pb.runCount} run${pb.runCount === 1 ? '' : 's'}` : 'never run'}</span>
                </p>
              </Link>
              {canManage ? (
                <Switch
                  checked={pb.enabled}
                  disabled={busyId === pb.id || (!pb.enabled && !pb.categoryId)}
                  onCheckedChange={(v) => toggle(pb, v)}
                  aria-label={`${pb.enabled ? 'Switch off' : 'Switch on'} ${pb.name}`}
                  title={!pb.categoryId ? 'Pick a category first' : undefined}
                />
              ) : (
                <span className={`text-xs font-medium ${pb.enabled ? 'text-emerald-700 dark:text-emerald-300' : 'text-muted-foreground'}`}>{pb.enabled ? 'On' : 'Off'}</span>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function Field({ label, htmlFor, hint, children }) {
  return (
    <div>
      {htmlFor ? <label htmlFor={htmlFor} className={labelClass}>{label}</label> : <span className={labelClass}>{label}</span>}
      {children}
      {hint && <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground/75">{hint}</p>}
    </div>
  );
}

function PlaybookEditor({ playbookId, categories, canManage, tools, defaults = null }) {
  const navigate = useNavigate();
  const isNew = playbookId === 'new';
  const [form, setForm] = useState(isNew ? NEW_PLAYBOOK : null);
  const [text, setText] = useState({ keywords: '', exclude: '', tags: '' });
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  useUnsavedGuard(canManage && dirty);

  const adopt = (pb) => {
    setForm(pb);
    setText({ keywords: words(pb.match?.keywords), exclude: words(pb.match?.excludeKeywords), tags: words(pb.kbScope?.tags) });
    setDirty(false);
  };

  useEffect(() => {
    if (isNew) { adopt(NEW_PLAYBOOK); return undefined; }
    let cancelled = false;
    setForm(null);
    knowledgeAPI.getPlaybook(playbookId)
      .then((res) => { if (!cancelled) adopt(res.data); })
      .catch((err) => { if (!cancelled) setError(err?.message || 'Could not load the playbook'); });
    return () => { cancelled = true; };
  }, [playbookId, isNew]);

  const top = useMemo(() => categories.find((c) => c.id === Number(form?.categoryId)), [categories, form?.categoryId]);

  if (error && !form) return <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>;
  if (!form) return <Loading label="Loading playbook…" />;

  const set = (patch) => { setForm((f) => ({ ...f, ...patch })); setDirty(true); };
  const setFollow = (patch) => set({ followUp: { ...(form.followUp || {}), ...patch } });
  const defaultNudge = defaults?.followUp?.nudgeText || FALLBACK_NUDGE_TEXT;
  const fu = {
    nudgeAfterBusinessDays: 2, closeAfterBusinessDays: 2, onSilence: 'resolve', ...(form.followUp || {}),
  };
  // The default wording is shown (and editable), never an empty box.
  if (!String(fu.nudgeText || '').trim()) fu.nudgeText = defaultNudge;
  const nudgePreview = fu.nudgeText.replace(/\{\{\s*days\s*\}\}/gi, `${fu.closeAfterBusinessDays} business day${Number(fu.closeAfterBusinessDays) === 1 ? '' : 's'}`);
  const readOnly = !canManage;

  const toggleSub = (id) => {
    const cur = new Set(form.subcategoryIds || []);
    if (cur.has(id)) cur.delete(id); else cur.add(id);
    set({ subcategoryIds: [...cur] });
  };
  const toggleTool = (name) => {
    const cur = new Set(form.allowedTools || []);
    if (cur.has(name)) cur.delete(name); else cur.add(name);
    set({ allowedTools: [...cur] });
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    const payload = {
      name: form.name,
      enabled: form.enabled,
      categoryId: form.categoryId || null,
      subcategoryIds: form.subcategoryIds || [],
      match: { keywords: splitWords(text.keywords), excludeKeywords: splitWords(text.exclude) },
      instructions: form.instructions,
      instructionsAreSource: form.instructionsAreSource === true,
      allowedTools: form.allowedTools || [],
      kbScope: { mode: form.kbScope?.mode || 'all', tags: splitWords(text.tags), includeVerifiedSolutions: form.kbScope?.includeVerifiedSolutions !== false },
      minConfidence: Number(form.minConfidence),
      followUp: form.followUp || undefined,
      priority: Number(form.priority),
    };
    try {
      const res = isNew ? await knowledgeAPI.createPlaybook(payload) : await knowledgeAPI.updatePlaybook(playbookId, payload);
      setSavedAt(new Date());
      setDirty(false);
      if (isNew) navigate(`/knowledge/playbooks/${res.data.id}`, { replace: true });
      else adopt(res.data);
    } catch (err) {
      setError(err?.message || 'Could not save');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setConfirmDelete(false);
    try {
      await knowledgeAPI.deletePlaybook(playbookId);
      setDirty(false);
      navigate('/knowledge/playbooks');
    } catch (err) {
      setError(err?.message || 'Could not delete');
    }
  };

  return (
    <div className="space-y-4 animate-fadeIn">
      <GuardedLink to="/knowledge/playbooks" className="tp-focus-ring inline-flex items-center gap-1 rounded text-xs font-medium text-muted-foreground hover:text-foreground">
        <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> All playbooks
      </GuardedLink>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)]">
        <fieldset disabled={readOnly} className="tp-card min-w-0 space-y-6 p-4 sm:p-5" aria-label="Playbook editor">
          {/* Basics */}
          <div className="space-y-3">
            <Field label="Name" htmlFor="pb-name">
              <input id="pb-name" value={form.name} onChange={(e) => set({ name: e.target.value })} maxLength={200} placeholder="e.g. Software installs (Company Portal)" className={`${inputClass} h-10 text-[15px] font-medium`} />
            </Field>
            <div className="flex flex-wrap items-center gap-x-6 gap-y-2 text-xs text-muted-foreground">
              <span className="inline-flex items-center gap-1.5"><Lock className="h-3.5 w-3.5" aria-hidden="true" />Mode: <span className="font-medium text-foreground/85">Shadow</span> — answers are drafted and recorded, never sent</span>
              {!isNew && <span>version {form.version}</span>}
            </div>
          </div>

          {/* Which tickets */}
          <div className="space-y-3 border-t border-border/70 pt-5">
            <SectionTitle hint="The playbook only looks at tickets in this category. Tick subcategories to narrow it; none ticked covers the whole category.">Which tickets</SectionTitle>
            <Field label="Category">
              <FancySelect
                value={form.categoryId || ''}
                onChange={(v) => set({ categoryId: v ? Number(v) : null, subcategoryIds: [] })}
                options={[{ value: '', label: 'Pick a category' }, ...categories.map((c) => ({ value: c.id, label: c.name }))]}
                aria-label="Category"
                disabled={readOnly}
              />
            </Field>
            {top && (top.subcategories || []).length > 0 && (
              <div role="group" aria-label="Subcategories" className="settings-scrollbar grid max-h-48 gap-x-4 gap-y-1 overflow-auto sm:grid-cols-2">
                {top.subcategories.map((s) => (
                  <label key={s.id} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-foreground/85 hover:bg-muted/50">
                    <input type="checkbox" checked={(form.subcategoryIds || []).includes(s.id)} onChange={() => toggleSub(s.id)} className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
                    {s.name}
                  </label>
                ))}
              </div>
            )}
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Only when it mentions any of" htmlFor="pb-kw" hint="Comma separated. Empty = any wording.">
                <textarea id="pb-kw" rows={2} value={text.keywords} onChange={(e) => { setText((t) => ({ ...t, keywords: e.target.value })); setDirty(true); }} placeholder="install, download, company portal" className={textareaClass} />
              </Field>
              <Field label="Never when it mentions" htmlFor="pb-ex" hint="Any of these words keeps the playbook quiet.">
                <textarea id="pb-ex" rows={2} value={text.exclude} onChange={(e) => { setText((t) => ({ ...t, exclude: e.target.value })); setDirty(true); }} placeholder="licence, purchase, error" className={textareaClass} />
              </Field>
            </div>
          </div>

          {/* Instructions */}
          <div className="space-y-2 border-t border-border/70 pt-5">
            <SectionTitle hint={INSTRUCTIONS_HINT}>Instructions</SectionTitle>
            <textarea
              aria-label="Instructions"
              rows={10}
              value={form.instructions}
              onChange={(e) => set({ instructions: e.target.value })}
              placeholder={'Use this playbook when…\n\nA good answer:\n- …\n\nStay quiet when:\n- …'}
              className={`${textareaClass} font-[inherit]`}
            />
            <label className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-muted/50">
              <input
                type="checkbox"
                checked={form.instructionsAreSource === true}
                onChange={(e) => set({ instructionsAreSource: e.target.checked })}
                className="mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]"
              />
              <span>
                <span className="block text-sm text-foreground">Let the answer quote these instructions (e.g. a standard how-to)</span>
                <span className="block text-[11px] leading-snug text-muted-foreground">
                  Off: every answer must cite an article or a verified solution. On: the instructions count as a source too — answers grounded only in them are marked and never sent on their own.
                </span>
              </span>
            </label>
          </div>

          {/* Tools + knowledge */}
          <div className="grid gap-5 border-t border-border/70 pt-5 md:grid-cols-2">
            <div>
              <SectionTitle hint="Read-only. The playbook can only use what you tick.">Tools it may use</SectionTitle>
              <div className="space-y-1.5" role="group" aria-label="Allowed tools">
                {(tools || []).map((t) => (
                  <label key={t.name} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 hover:bg-muted/50">
                    <input type="checkbox" checked={(form.allowedTools || []).includes(t.name)} onChange={() => toggleTool(t.name)} className="mt-0.5 h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
                    <span>
                      <span className="block text-sm text-foreground">{t.label}</span>
                      <span className="block text-[11px] leading-snug text-muted-foreground">{t.summary}</span>
                    </span>
                  </label>
                ))}
              </div>
            </div>
            <div>
              <SectionTitle hint="What the playbook may quote.">Knowledge</SectionTitle>
              <div className="space-y-1.5" role="radiogroup" aria-label="Knowledge scope">
                {[['all', 'All published articles in this workspace'], ['tags', 'Only articles with these tags']].map(([mode, label]) => (
                  <label key={mode} className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-foreground hover:bg-muted/50">
                    <input type="radio" name="pb-scope" checked={(form.kbScope?.mode || 'all') === mode} onChange={() => set({ kbScope: { ...(form.kbScope || {}), mode } })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                    {label}
                  </label>
                ))}
                {(form.kbScope?.mode || 'all') === 'tags' && (
                  <input aria-label="Article tags" value={text.tags} onChange={(e) => { setText((t) => ({ ...t, tags: e.target.value })); setDirty(true); }} placeholder="company portal, software" className={`${inputClass} ml-6 w-[calc(100%-1.5rem)]`} />
                )}
                <label className="flex cursor-pointer items-center gap-2 rounded px-1 py-1 text-sm text-foreground hover:bg-muted/50">
                  <input type="checkbox" checked={form.kbScope?.includeVerifiedSolutions !== false} onChange={(e) => set({ kbScope: { ...(form.kbScope || {}), includeVerifiedSolutions: e.target.checked } })} className="h-4 w-4 rounded border-input accent-[hsl(var(--primary))]" />
                  Include verified solutions from resolved tickets
                </label>
              </div>
            </div>
          </div>

          {/* Confidence + priority */}
          <div className="grid gap-5 border-t border-border/70 pt-5 sm:grid-cols-2">
            <Field label={`Minimum confidence — ${Math.round(Number(form.minConfidence) * 100)}%`} htmlFor="pb-conf" hint="Answers below this are marked in Activity; once sending exists they will never go out on their own.">
              <input id="pb-conf" type="range" min="0.5" max="1" step="0.05" value={form.minConfidence} onChange={(e) => set({ minConfidence: Number(e.target.value) })} className="tp-focus-ring w-full accent-[hsl(var(--primary))]" />
            </Field>
            <Field label="Priority" htmlFor="pb-prio" hint="Higher runs first when two playbooks fit the same ticket.">
              <input id="pb-prio" type="number" min="0" max="1000" value={form.priority} onChange={(e) => set({ priority: e.target.value })} className={`${inputClass} w-28`} />
            </Field>
          </div>

          {/* Follow-up */}
          <div className="space-y-3 border-t border-border/70 pt-5">
            <SectionTitle hint="Used when sending is switched on (next phase). The requester can always reply to reach a person.">Follow-up</SectionTitle>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Check in after (business days)" htmlFor="pb-nudge">
                <input id="pb-nudge" type="number" min="1" max="30" value={fu.nudgeAfterBusinessDays} onChange={(e) => setFollow({ nudgeAfterBusinessDays: Number(e.target.value) })} className={`${inputClass} w-24`} />
              </Field>
              <Field label="Close after a further (business days)" htmlFor="pb-close">
                <input id="pb-close" type="number" min="1" max="30" value={fu.closeAfterBusinessDays} onChange={(e) => setFollow({ closeAfterBusinessDays: Number(e.target.value) })} className={`${inputClass} w-24`} />
              </Field>
            </div>
            <Field label="Check-in message" htmlFor="pb-nudge-text" hint={`{{days}} becomes the close-after days. Reads: “${nudgePreview}”`}>
              <textarea id="pb-nudge-text" rows={2} value={fu.nudgeText} onChange={(e) => setFollow({ nudgeText: e.target.value })} className={textareaClass} />
            </Field>
            <div role="radiogroup" aria-label="When nobody replies" className="flex flex-wrap gap-x-5 gap-y-1">
              <span className="w-full text-xs font-medium text-foreground/85">When nobody replies</span>
              {[['resolve', 'Resolve the ticket'], ['leave_open', 'Leave it open for a person']].map(([v, label]) => (
                <label key={v} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                  <input type="radio" name="pb-silence" checked={fu.onSilence === v} onChange={() => setFollow({ onSilence: v })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                  {label}
                </label>
              ))}
            </div>
          </div>

          {canManage && (
            <div className="flex flex-wrap items-center gap-2 border-t border-border/70 pt-4">
              <label className="mr-2 inline-flex items-center gap-2 text-sm text-foreground">
                <Switch checked={form.enabled} onCheckedChange={(v) => set({ enabled: v })} disabled={!form.categoryId} aria-label="Playbook on" />
                {form.enabled ? 'On' : 'Off'}
              </label>
              <button type="button" onClick={save} disabled={saving || !form.name.trim()} className="tp-focus-ring inline-flex h-9 items-center rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50">
                {saving ? 'Saving…' : isNew ? 'Create playbook' : 'Save'}
              </button>
              <GuardedLink to="/knowledge/playbooks" className="tp-focus-ring inline-flex h-9 items-center rounded-lg px-3 text-sm text-muted-foreground hover:bg-muted">Cancel</GuardedLink>
              {dirty ? <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span> : savedAt && <span className="text-xs text-muted-foreground">Saved {timeAgo(savedAt)}</span>}
              {!isNew && (
                <button type="button" onClick={() => setConfirmDelete(true)} className="tp-focus-ring ml-auto inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm text-red-700 hover:bg-red-50 dark:text-red-300 dark:hover:bg-red-500/15">
                  <Trash2 className="h-4 w-4" aria-hidden="true" /> Delete
                </button>
              )}
            </div>
          )}
          {error && <p className="text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
          <ConfirmDialog
            open={confirmDelete}
            title="Delete this playbook?"
            confirmLabel="Delete playbook"
            destructive
            onCancel={() => setConfirmDelete(false)}
            onConfirm={remove}
          >
            Its past runs stay in Activity.
          </ConfirmDialog>
        </fieldset>

        <aside className="tp-card h-fit p-4 sm:p-5 lg:sticky lg:top-20">
          {canManage ? (
            <PlaybookTestBox playbookId={isNew ? null : Number(playbookId)} dirty={dirty} />
          ) : (
            <p className="text-xs text-muted-foreground">Workspace admins can test playbooks on real tickets.</p>
          )}
        </aside>
      </div>
    </div>
  );
}

export default function PlaybooksPanel({ itemId, categories = [], canManage = false, tools = [], defaults = null }) {
  if (itemId) return <PlaybookEditor playbookId={itemId} categories={categories} canManage={canManage} tools={tools} defaults={defaults} />;
  return <PlaybookList categories={categories} canManage={canManage} />;
}
