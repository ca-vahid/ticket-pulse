import { useEffect, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  AppWindow, ArrowLeft, BookMarked, ChevronDown, BookOpen, Copy, Eye, FileSearch, FolderTree, History, Layers, ListChecks, Lock,
  Power, Save, Search, Send, Settings2, ShieldCheck, Ticket, Trash2, Undo2, UserRound, Wand2,
} from 'lucide-react';
import { knowledgeAPI, ticketsAPI } from '../../services/api';
import FancySelect from '../common/FancySelect';
import { timeAgo } from '../tickets/ticketUi';
import PlaybookSidePanel from './PlaybookSidePanel';
import { StayQuietPanel } from './StayQuietEditor';
import { findStayQuietBlock, mergeConditions } from './stayQuietFormat';
import {
  ConfirmDialog, GuardedLink, Loading, PersonLine, inputClass, textareaClass, useUnsavedGuard,
} from './knowledgeUi';
import {
  HelpPopover, IconTile, InfoTip, Menu, MetaRow, NumberedSection, SplitButton, StatusBadge, TabActions, TitleField, TokenInput,
  fieldHint, fieldLabel,
} from './builderUi';

/**
 * The playbook builder (Knowledge redesign, 26 Sep 2026 — an outside
 * artist's mockup, adapted). A header card (name, status, mode, version, last
 * update, ⋮), six numbered configuration sections on the left and a sticky
 * test / preview / backtest panel on the right. Page actions (All playbooks,
 * the Save split button, ⋮) sit in the tab row. Nothing here sends anything.
 */
export const NEW_PLAYBOOK = {
  name: '',
  enabled: false,
  categoryId: null,
  subcategoryIds: [],
  match: { keywords: [], excludeKeywords: [] },
  instructions: '',
  instructionsAreSource: false,
  stayQuietWhen: [],
  allowedTools: ['search_knowledge', 'get_article', 'get_ticket_details'],
  kbScope: { mode: 'all', tags: [], includeVerifiedSolutions: true },
  minConfidence: 0.8,
  followUp: null,
  priority: 100,
  mode: 'shadow',
  sensitive: false,
  onHelp: 'assign_normally',
};

// Same wording as the server default (autoHelpPlaybookService.DEFAULT_NUDGE_TEXT);
// {{days}} is filled from "Close after".
export const FALLBACK_NUDGE_TEXT = "Hope that sorted it out. If we don't hear back, we'll close this ticket in {{days}} — just reply if you still need a hand.";
export const MAX_INSTRUCTIONS = 8000;

// inputClass without w-full, for short number fields.
const narrowInput = inputClass.replace('w-full ', '');

const TOOL_ICON = {
  search_knowledge: Search,
  get_article: BookOpen,
  find_similar_resolved_tickets: History,
  get_ticket_details: Ticket,
  get_requester_profile: UserRound,
  lookup_company_portal_app: AppWindow,
};

const MODE_WORDS = {
  shadow: { label: 'Shadow', line: 'Answers are drafted and recorded, never sent' },
  approve: { label: 'Approve', line: 'Suggested on the ticket; an agent sends, edits or dismisses it' },
  auto: { label: 'Auto', line: 'Sends on its own once the readiness bar is met' },
};

function Field({ label, htmlFor, hint, hintId, tip = null, children, optional = false }) {
  return (
    <div className="min-w-0">
      {htmlFor ? (
        // The (i) sits beside the label, not inside it: a button inside a
        // <label> would be labelled by it too.
        <div className={fieldLabel}>
          <label htmlFor={htmlFor}>{label}{optional && <span className="font-normal text-muted-foreground"> (optional)</span>}</label>
          {tip}
        </div>
      ) : (
        <span className={fieldLabel}>{label}{optional && <span className="font-normal text-muted-foreground">(optional)</span>}{tip}</span>
      )}
      {children}
      {hint && <p id={hintId} className={fieldHint}>{hint}</p>}
    </div>
  );
}

/** A checkbox row with a title and one line of consequence. */
function OptionRow({ checked, onChange, title, hint, icon: Icon = null, disabled = false }) {
  return (
    <label className={`flex items-start gap-3 rounded-lg px-1 py-1.5 ${disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer hover:bg-muted/50'}`}>
      <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input accent-[hsl(var(--primary))]" />
      <span className="min-w-0">
        <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">{Icon && <Icon className="h-3.5 w-3.5 text-primary" aria-hidden="true" />}{title}</span>
        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{hint}</span>
      </span>
    </label>
  );
}

function playbookPayload(form, { mode, onHelp }) {
  return {
    name: form.name,
    enabled: form.enabled,
    categoryId: form.categoryId || null,
    subcategoryIds: form.subcategoryIds || [],
    match: { keywords: form.match?.keywords || [], excludeKeywords: form.match?.excludeKeywords || [] },
    instructions: form.instructions,
    instructionsAreSource: form.instructionsAreSource === true,
    stayQuietWhen: form.stayQuietWhen || [],
    allowedTools: form.allowedTools || [],
    kbScope: {
      mode: form.kbScope?.mode || 'all',
      tags: form.kbScope?.tags || [],
      includeVerifiedSolutions: form.kbScope?.includeVerifiedSolutions !== false,
    },
    minConfidence: Number(form.minConfidence),
    followUp: form.followUp || undefined,
    priority: Number(form.priority),
    mode,
    sensitive: form.sensitive === true,
    onHelp,
  };
}

export default function PlaybookBuilder({ playbookId, categories, canManage, tools, defaults = null }) {
  const navigate = useNavigate();
  const isNew = playbookId === 'new';
  const [form, setForm] = useState(isNew ? NEW_PLAYBOOK : null);
  const [saved, setSaved] = useState(null); // the last saved version (Duplicate copies it)
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [savedAt, setSavedAt] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [confirmDuplicate, setConfirmDuplicate] = useState(false);
  const [wsSettings, setWsSettings] = useState(null);
  const [groups, setGroups] = useState([]);
  const [readiness, setReadiness] = useState(null);
  const [panelTab, setPanelTab] = useState('test');
  const [runRequest, setRunRequest] = useState(0);
  const [offerDismissed, setOfferDismissed] = useState(false);
  const leave = useUnsavedGuard(canManage && dirty);
  // In-section navigation goes through the unsaved-changes guard (it asks first).
  const go = (to) => (leave ? leave(to) : navigate(to));

  useEffect(() => {
    let cancelled = false;
    Promise.resolve().then(() => knowledgeAPI.getSettings())
      .then((res) => { if (!cancelled) setWsSettings(res?.data || null); })
      .catch(() => {});
    Promise.resolve().then(() => ticketsAPI.meta?.())
      .then((res) => { if (!cancelled) setGroups((res?.data?.groups || []).map((g) => ({ value: `group:${g.id}`, label: g.name }))); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (isNew || !playbookId) return undefined;
    let cancelled = false;
    Promise.resolve().then(() => knowledgeAPI.playbookReadiness?.(playbookId))
      .then((res) => { if (!cancelled) setReadiness(res?.data || null); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [playbookId, isNew, savedAt]);

  const adopt = (pb) => {
    const next = { ...NEW_PLAYBOOK, ...pb, match: { keywords: pb.match?.keywords || [], excludeKeywords: pb.match?.excludeKeywords || [] }, stayQuietWhen: pb.stayQuietWhen || [] };
    setForm(next);
    setSaved(next);
    setDirty(false);
  };

  useEffect(() => {
    if (isNew) { setForm(NEW_PLAYBOOK); setSaved(null); setDirty(false); return undefined; }
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
  const setMatch = (patch) => set({ match: { ...(form.match || {}), ...patch } });
  const setFollow = (patch) => set({ followUp: { ...(form.followUp || {}), ...patch } });
  const defaultNudge = defaults?.followUp?.nudgeText || FALLBACK_NUDGE_TEXT;
  const fu = {
    nudgeAfterBusinessDays: 2, closeAfterBusinessDays: 2, onSilence: 'resolve', ...(form.followUp || {}),
  };
  // The default wording is shown (and editable), never an empty box.
  if (!String(fu.nudgeText || '').trim()) fu.nudgeText = defaultNudge;
  const nudgePreview = fu.nudgeText.replace(/\{\{\s*days\s*\}\}/gi, `${fu.closeAfterBusinessDays} business day${Number(fu.closeAfterBusinessDays) === 1 ? '' : 's'}`);
  const readOnly = !canManage;
  const approveOn = wsSettings?.approveModeEnabled === true;
  const autoAllowed = wsSettings?.autoModeAllowed === true;
  const mode = form.mode || 'shadow';
  const onHelp = String(form.onHelp || 'assign_normally');
  const helpGroup = onHelp.startsWith('group:') ? onHelp : '';
  const workspaceQuiet = wsSettings?.alwaysStayQuietWhen || [];
  const instructionsBlock = !offerDismissed && !readOnly ? findStayQuietBlock(form.instructions) : null;

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

  const save = async ({ andTest = false } = {}) => {
    setSaving(true);
    setError(null);
    try {
      const payload = playbookPayload(form, { mode, onHelp });
      const res = isNew ? await knowledgeAPI.createPlaybook(payload) : await knowledgeAPI.updatePlaybook(playbookId, payload);
      setSavedAt(new Date());
      setDirty(false);
      if (isNew) navigate(`/knowledge/playbooks/${res.data.id}`, { replace: true });
      else adopt(res.data);
      if (andTest) { setPanelTab('test'); setRunRequest((n) => n + 1); }
      return true;
    } catch (err) {
      setError(err?.message || 'Could not save');
      return false;
    } finally {
      setSaving(false);
    }
  };

  /** A new, switched-off shadow copy — of the current edits (Save as copy) or of the saved version (Duplicate). */
  const copy = async (source) => {
    setSaving(true);
    setError(null);
    try {
      const payload = {
        ...playbookPayload(source, { mode: 'shadow', onHelp: String(source.onHelp || 'assign_normally') }),
        name: `${String(source.name || 'Playbook').trim()} (copy)`.slice(0, 200),
        enabled: false,
      };
      const res = await knowledgeAPI.createPlaybook(payload);
      setDirty(false);
      navigate(`/knowledge/playbooks/${res.data.id}`);
    } catch (err) {
      setError(err?.message || 'Could not make the copy');
    } finally {
      setSaving(false);
    }
  };

  /** ⋮ → Enable / Disable: saved on its own, without touching unsaved edits. */
  const switchEnabled = async (enabled) => {
    if (isNew) { set({ enabled }); return; }
    setError(null);
    try {
      const res = await knowledgeAPI.updatePlaybook(playbookId, { enabled });
      const patch = { enabled: res?.data?.enabled ?? enabled, updatedAt: res?.data?.updatedAt, updatedBy: res?.data?.updatedBy };
      setForm((f) => ({ ...f, ...patch }));
      setSaved((s) => (s ? { ...s, ...patch } : s));
    } catch (err) {
      setError(err?.message || 'Could not switch the playbook');
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

  const discard = () => {
    if (saved) { setForm(saved); setDirty(false); } else { setForm(NEW_PLAYBOOK); setDirty(false); }
  };

  const moveInstructionLines = () => {
    if (!instructionsBlock) return;
    set({ stayQuietWhen: mergeConditions(form.stayQuietWhen, instructionsBlock.items), instructions: instructionsBlock.rest });
  };

  const canEnable = Boolean(saved?.categoryId ?? form.categoryId);
  const modeItems = [
    { id: 'shadow', label: 'Shadow', hint: 'Drafted and recorded for review. Nothing reaches the requester.', icon: Eye, checked: mode === 'shadow', onSelect: () => set({ mode: 'shadow' }) },
    {
      id: 'approve', label: 'Approve', icon: Send, checked: mode === 'approve', disabled: !approveOn,
      hint: approveOn ? 'Suggested on the ticket as "Auto-help suggests"; an agent sends, edits or dismisses it.' : 'Switch approve mode on for the workspace first (Knowledge → Settings).',
      onSelect: () => set({ mode: 'approve' }),
    },
    {
      id: 'auto', label: 'Auto', icon: Lock, checked: mode === 'auto', disabled: !autoAllowed || form.sensitive === true,
      hint: !autoAllowed ? `Locked — not in this build${form.sensitive ? '; never for a sensitive playbook' : ''}.` : form.sensitive ? 'Never for a sensitive playbook.' : 'Sends on its own once the readiness bar is met.',
      onSelect: () => set({ mode: 'auto' }),
    },
  ];
  const overflowItems = [
    !isNew && {
      id: 'duplicate', label: 'Duplicate', hint: 'A switched-off copy of the saved version', icon: Copy, disabled: saving,
      // The copy is the SAVED version and opening it leaves this page: with
      // unsaved edits, ask first (in-app) — Save as copy keeps the edits.
      onSelect: () => (dirty && canManage ? setConfirmDuplicate(true) : copy(saved || form)),
    },
    {
      id: 'enable', label: form.enabled ? 'Disable' : 'Enable', icon: Power,
      hint: form.enabled ? 'Stops picking up new tickets' : canEnable ? 'Starts picking up new tickets that match' : 'Pick a category and save first',
      disabled: !form.enabled && !canEnable, onSelect: () => switchEnabled(!form.enabled),
    },
    !isNew && { id: 'backtest', label: 'Backtest', hint: 'Run it on recent resolved tickets', icon: History, onSelect: () => setPanelTab('backtest') },
    !isNew && { id: 'delete', label: 'Delete…', hint: 'Past runs stay in Activity', icon: Trash2, destructive: true, onSelect: () => setConfirmDelete(true) },
  ];

  return (
    <div className="animate-fadeIn" data-testid="playbook-builder">
      <TabActions>
        {dirty && canManage && <span className="hidden text-xs font-medium text-amber-700 dark:text-amber-300 sm:inline" data-testid="unsaved-note">Unsaved changes</span>}
        {!dirty && savedAt && canManage && <span className="hidden text-xs text-muted-foreground sm:inline">Saved {timeAgo(savedAt)}</span>}
        <GuardedLink to="/knowledge/playbooks" aria-label="All playbooks" className="tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg border border-border bg-card px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted sm:px-3">
          <ArrowLeft className="h-4 w-4" aria-hidden="true" /> <span className="hidden sm:inline">All playbooks</span>
        </GuardedLink>
        {canManage && (
          <>
            <SplitButton
              label={saving ? 'Saving…' : isNew ? 'Create playbook' : 'Save changes'}
              icon={Save}
              onClick={() => save()}
              disabled={saving || !String(form.name || '').trim()}
              menuLabel="More ways to save"
              testId="save-split"
              items={[
                { id: 'save', label: isNew ? 'Create' : 'Save', hint: 'Keep the changes', icon: Save, onSelect: () => save() },
                { id: 'save-test', label: isNew ? 'Create & test' : 'Save & test', hint: 'Save, then run the test on the ticket in the panel', icon: Wand2, onSelect: () => save({ andTest: true }) },
                { id: 'save-copy', label: 'Save as copy', hint: 'A new, switched-off playbook with these edits', icon: Copy, onSelect: () => copy(form) },
              ]}
            />
            <Menu
              label="Page actions"
              testId="page-menu"
              items={[
                { id: 'discard', label: 'Discard unsaved changes', icon: Undo2, disabled: !dirty, onSelect: discard },
                !isNew && { id: 'runs', label: 'Runs in Activity', hint: 'Every run of this playbook', icon: ListChecks, onSelect: () => go(`/knowledge/activity?playbook=${playbookId}`) },
                { id: 'settings', label: 'Knowledge settings', hint: 'Workspace switches, stay-quiet list', icon: Settings2, onSelect: () => go('/knowledge/settings') },
              ]}
            />
          </>
        )}
      </TabActions>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(360px,440px)]">
        <div className="min-w-0 space-y-4">
          {/* Header card */}
          <section className="tp-card p-4 sm:p-5" aria-label="Playbook" data-testid="playbook-header">
            <div className="flex items-start gap-4">
              <IconTile icon={BookMarked} className="hidden sm:inline-flex" />
              <div className="min-w-0 flex-1">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground">AI automatic response playbook</p>
                    <TitleField id="pb-name" ariaLabel="Name" value={form.name} onChange={(name) => set({ name })} readOnly={readOnly} placeholder="Name this playbook" />
                  </div>
                  <div className="flex flex-shrink-0 items-center gap-2 pt-1">
                    <StatusBadge tone={form.enabled ? 'success' : 'muted'} testId="playbook-status">{form.enabled ? 'Active' : 'Off'}</StatusBadge>
                    {canManage && <Menu label="Playbook actions" items={overflowItems} testId="playbook-menu" />}
                  </div>
                </div>
                <MetaRow className="mt-2.5">
                  {canManage ? (
                    <Menu
                      label={`Mode: ${MODE_WORDS[mode].label}`}
                      items={modeItems}
                      align="left"
                      menuClassName="w-72"
                      testId="mode-control"
                      buttonClassName="tp-focus-ring -ml-1 inline-flex h-7 items-center gap-1 rounded-md px-1 text-[13px] font-medium text-foreground hover:bg-muted"
                    >
                      Mode: {MODE_WORDS[mode].label}
                      <ChevronDown className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
                    </Menu>
                  ) : <span className="font-medium text-foreground">Mode: {MODE_WORDS[mode].label}</span>}
                  <span data-testid="mode-line">{mode !== 'shadow' && !approveOn ? 'Approve mode is off for this workspace — runs in shadow' : MODE_WORDS[mode].line}</span>
                  {!isNew && <span>Version {form.version || 1}</span>}
                  {!isNew && form.updatedAt && (
                    <span className="inline-flex min-w-0 items-center gap-1.5">
                      Last updated {timeAgo(form.updatedAt)}
                      {form.updatedBy && String(form.updatedBy).includes('@') && <><span>by</span><PersonLine email={form.updatedBy} /></>}
                    </span>
                  )}
                  {form.sensitive && <StatusBadge tone="info" icon={ShieldCheck}>Sensitive · approve only</StatusBadge>}
                </MetaRow>
                {mode !== 'shadow' && !approveOn && (
                  <p className="mt-2 text-xs text-amber-700 dark:text-amber-300">Switch approve mode on in Knowledge → Settings for this playbook to suggest answers on tickets.</p>
                )}
              </div>
            </div>
          </section>

          <fieldset disabled={readOnly} className="min-w-0 space-y-4" aria-label="Playbook editor">
            {/* 1 · Ticket matching */}
            <NumberedSection
              n={1}
              id="pb-matching"
              title="Ticket matching"
              description="Which tickets this playbook looks at, and the words that include or exclude them."
              action={(
                <HelpPopover label="Learn how matching works" icon={BookOpen} title="How matching works" testId="help-matching">
                  <ul className="list-disc space-y-1.5 pl-4">
                    <li>The ticket&rsquo;s category must be this playbook&rsquo;s category. Tick subcategories to narrow it; none ticked covers the whole category.</li>
                    <li><span className="font-medium text-foreground/90">Only when</span>: at least one term must appear in the subject or description. Whole words, any case: &ldquo;app&rdquo; never matches &ldquo;approval&rdquo;.</li>
                    <li><span className="font-medium text-foreground/90">Never when</span>: any one of these terms keeps the playbook quiet.</li>
                    <li>E-mail disclaimers under a signature are ignored.</li>
                    <li>When two playbooks fit, the higher priority (step 5) runs.</li>
                  </ul>
                </HelpPopover>
              )}
            >
              <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.35fr)]">
                <Field label="Category" hint="The playbook only looks at tickets in this category.">
                  <FancySelect
                    value={form.categoryId || ''}
                    onChange={(v) => set({ categoryId: v ? Number(v) : null, subcategoryIds: [] })}
                    options={[
                      { value: '', label: 'Pick a category', icon: <FolderTree className="h-4 w-4 text-muted-foreground" /> },
                      ...categories.map((c) => ({ value: c.id, label: c.name, icon: <Layers className="h-4 w-4 text-primary" /> })),
                    ]}
                    aria-label="Category"
                    disabled={readOnly}
                    className="h-10"
                  />
                </Field>
                <div className="min-w-0">
                  <span className={fieldLabel}>Subcategories <span className="font-normal text-muted-foreground">(optional)</span></span>
                  {top && (top.subcategories || []).length > 0 ? (
                    <div role="group" aria-label="Subcategories" className="settings-scrollbar grid max-h-60 gap-x-5 gap-y-0.5 overflow-auto sm:grid-cols-2">
                      {top.subcategories.map((s) => (
                        <label key={s.id} className="flex cursor-pointer items-start gap-2 rounded px-1 py-1 text-[13px] leading-snug text-foreground/90 hover:bg-muted/50">
                          <input type="checkbox" checked={(form.subcategoryIds || []).includes(s.id)} onChange={() => toggleSub(s.id)} className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input accent-[hsl(var(--primary))]" />
                          {s.name}
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">{top ? 'This category has no subcategories.' : 'Pick a category to narrow it by subcategory.'}</p>
                  )}
                </div>
              </div>
              <div className="mt-5 grid gap-5 md:grid-cols-2">
                <Field
                  label="Only when it mentions any of these terms"
                  htmlFor="pb-kw"
                  hintId="pb-kw-hint"
                  hint="Enter or a comma adds a term. Empty = any wording."
                  tip={<InfoTip label="About these terms">At least one of these words must appear in the ticket&rsquo;s subject or description, as a whole word.</InfoTip>}
                >
                  <TokenInput
                    id="pb-kw"
                    label="Only when it mentions any of these terms"
                    values={form.match?.keywords || []}
                    onChange={(keywords) => setMatch({ keywords })}
                    describedBy="pb-kw-hint"
                    disabled={readOnly}
                    testId="tokens-include"
                  />
                </Field>
                <Field
                  label="Never when it mentions these terms"
                  htmlFor="pb-ex"
                  hintId="pb-ex-hint"
                  hint="Any of these words keeps the playbook quiet."
                  tip={<InfoTip label="About excluded terms">If any of these appears, the playbook leaves the ticket to a person, whatever else it says.</InfoTip>}
                >
                  <TokenInput
                    id="pb-ex"
                    label="Never when it mentions these terms"
                    values={form.match?.excludeKeywords || []}
                    onChange={(excludeKeywords) => setMatch({ excludeKeywords })}
                    describedBy="pb-ex-hint"
                    disabled={readOnly}
                    testId="tokens-exclude"
                  />
                </Field>
              </div>
            </NumberedSection>

            {/* 2 · Answer behaviour */}
            <NumberedSection
              n={2}
              id="pb-behaviour"
              title="Answer behaviour & instructions"
              description="How to answer, what a good answer looks like, and when to stay quiet."
              action={(
                <HelpPopover label="View best practices" icon={BookOpen} title="Writing good instructions" testId="help-instructions">
                  <ul className="list-disc space-y-1.5 pl-4">
                    <li>Say when to use the playbook in one line, then what a good answer looks like.</li>
                    <li>Name apps, pages and menus exactly as your articles do. Auto-help only answers from the knowledge it finds.</li>
                    <li>Put hard stops in <span className="font-medium text-foreground/90">Stay quiet when</span>, one per line, not in the instructions: they are checked as rules.</li>
                    <li>Short is better. Leave out greetings and sign-offs; those are added for you.</li>
                  </ul>
                </HelpPopover>
              )}
            >
              <div className="grid gap-4 lg:grid-cols-[minmax(0,1.45fr)_minmax(0,1fr)]">
                <div className="min-w-0">
                  <label htmlFor="pb-instructions" className={fieldLabel}>Instructions for the AI</label>
                  <div className="relative">
                    <textarea
                      id="pb-instructions"
                      aria-label="Instructions"
                      rows={11}
                      value={form.instructions}
                      maxLength={MAX_INSTRUCTIONS}
                      onChange={(e) => set({ instructions: e.target.value })}
                      placeholder={'Use this playbook when…\n\nA good answer:\n- …'}
                      className={`${textareaClass} settings-scrollbar pb-7 font-[inherit]`}
                      aria-describedby="pb-instructions-count"
                    />
                    <span id="pb-instructions-count" className="pointer-events-none absolute bottom-2 right-3 text-[11px] tabular-nums text-muted-foreground/80" data-testid="instructions-count">
                      {String(form.instructions || '').length}/{MAX_INSTRUCTIONS}
                    </span>
                  </div>
                  {instructionsBlock && (
                    <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5 rounded-lg bg-muted/60 px-3 py-2 text-xs text-foreground/85" role="note" data-testid="stay-quiet-offer">
                      <span className="min-w-0 flex-1">
                        These instructions list {instructionsBlock.items.length} &ldquo;stay quiet&rdquo; line{instructionsBlock.items.length === 1 ? '' : 's'}. Move {instructionsBlock.items.length === 1 ? 'it' : 'them'} into <span className="font-medium">Stay quiet when</span>, where {instructionsBlock.items.length === 1 ? 'it is' : 'they are'} checked as rules?
                      </span>
                      <span className="flex gap-1">
                        <button type="button" onClick={moveInstructionLines} className="tp-focus-ring inline-flex h-7 items-center rounded-md bg-primary px-2.5 font-semibold text-primary-foreground hover:bg-primary/90">Move {instructionsBlock.items.length === 1 ? 'it' : 'them'}</button>
                        <button type="button" onClick={() => setOfferDismissed(true)} className="tp-focus-ring inline-flex h-7 items-center rounded-md px-2 text-muted-foreground hover:bg-card hover:text-foreground">Not now</button>
                      </span>
                    </div>
                  )}
                  <div className="mt-3 space-y-1">
                    <OptionRow
                      checked={form.instructionsAreSource === true}
                      onChange={(v) => set({ instructionsAreSource: v })}
                      title="Let the answer quote these instructions (e.g. a standard how-to)"
                      hint="Off: every answer must cite an article or a verified solution. On: the instructions count as a source too; answers grounded only in them are marked and never sent on their own."
                    />
                    <OptionRow
                      checked={form.sensitive === true}
                      icon={ShieldCheck}
                      onChange={(v) => set({ sensitive: v, ...(v && mode === 'auto' ? { mode: approveOn ? 'approve' : 'shadow' } : {}) })}
                      title="Sensitive topic"
                      hint="Passwords, MFA, access, security: Auto-help may suggest, but a person always sends. Never auto."
                    />
                  </div>
                </div>
                <StayQuietPanel
                  values={form.stayQuietWhen || []}
                  onChange={(stayQuietWhen) => set({ stayQuietWhen })}
                  workspaceList={workspaceQuiet}
                  readOnly={readOnly}
                />
              </div>
            </NumberedSection>

            {/* 3 · Tools */}
            <NumberedSection
              n={3}
              id="pb-tools"
              title="Tools the AI may use"
              description="Read-only. The playbook can only use what is ticked; each one says what it lets the AI see."
            >
              <div role="group" aria-label="Allowed tools" className="grid gap-2.5 sm:grid-cols-2 2xl:grid-cols-3">
                {(tools || []).map((t) => {
                  const on = (form.allowedTools || []).includes(t.name);
                  const Icon = TOOL_ICON[t.name] || FileSearch;
                  return (
                    <label
                      key={t.name}
                      className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${
                        on ? 'border-blue-300/80 bg-blue-50/50 dark:border-blue-400/35 dark:bg-blue-500/10' : 'border-border bg-card hover:bg-muted/40'
                      }`}
                      data-testid={`tool-${t.name}`}
                    >
                      <input type="checkbox" checked={on} onChange={() => toggleTool(t.name)} className="mt-0.5 h-4 w-4 flex-shrink-0 rounded border-input accent-[hsl(var(--primary))]" />
                      <Icon className={`mt-0.5 h-4 w-4 flex-shrink-0 ${on ? 'text-primary' : 'text-muted-foreground'}`} aria-hidden="true" />
                      <span className="min-w-0">
                        <span className={`block text-sm font-medium ${on ? 'text-foreground' : 'text-foreground/80'}`}>{t.label}</span>
                        <span className="mt-0.5 block text-xs leading-relaxed text-muted-foreground">{t.summary}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
            </NumberedSection>

            {/* 4 · Knowledge */}
            <NumberedSection n={4} id="pb-knowledge" title="Knowledge" description="What the playbook may quote. Only published articles are ever used.">
              <div className="grid gap-2.5 md:grid-cols-2" role="radiogroup" aria-label="Knowledge scope">
                {[['all', 'All published articles', 'Every published article in this workspace.'], ['tags', 'Only articles with these tags', 'Narrow it to articles tagged for this kind of request.']].map(([scope, label, hint]) => {
                  const on = (form.kbScope?.mode || 'all') === scope;
                  return (
                    <label key={scope} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 transition-colors ${on ? 'border-blue-300/80 bg-blue-50/50 dark:border-blue-400/35 dark:bg-blue-500/10' : 'border-border hover:bg-muted/40'}`}>
                      <input type="radio" name="pb-scope" checked={on} onChange={() => set({ kbScope: { ...(form.kbScope || {}), mode: scope } })} className="mt-0.5 h-4 w-4 accent-[hsl(var(--primary))]" />
                      <span className="min-w-0">
                        <span className="block text-sm font-medium text-foreground">{label}</span>
                        <span className="mt-0.5 block text-xs text-muted-foreground">{hint}</span>
                      </span>
                    </label>
                  );
                })}
              </div>
              {(form.kbScope?.mode || 'all') === 'tags' && (
                <div className="mt-3">
                  <Field label="Article tags" htmlFor="pb-tags" hint="An article with any of these tags may be quoted.">
                    <TokenInput
                      id="pb-tags"
                      label="Article tags"
                      values={form.kbScope?.tags || []}
                      onChange={(tags) => set({ kbScope: { ...(form.kbScope || {}), tags } })}
                      placeholder="company portal, software…"
                      disabled={readOnly}
                      minRows={1}
                    />
                  </Field>
                </div>
              )}
              <div className="mt-3">
                <OptionRow
                  checked={form.kbScope?.includeVerifiedSolutions !== false}
                  onChange={(v) => set({ kbScope: { ...(form.kbScope || {}), includeVerifiedSolutions: v } })}
                  title="Include verified solutions from resolved tickets"
                  hint="Solutions an agent marked as verified count as knowledge too (never internal notes)."
                />
              </div>
            </NumberedSection>

            {/* 5 · Thresholds */}
            <NumberedSection n={5} id="pb-thresholds" title="Decision thresholds" description="How sure the AI must be, and which playbook wins when two fit.">
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label="Minimum confidence" htmlFor="pb-conf" hint="Answers below this are marked in Activity and never go out on their own.">
                  <div className="flex items-center gap-3">
                    <input id="pb-conf" type="range" min="0.5" max="1" step="0.05" value={form.minConfidence} onChange={(e) => set({ minConfidence: Number(e.target.value) })} className="tp-focus-ring min-w-0 flex-1 accent-[hsl(var(--primary))]" aria-valuetext={`${Math.round(Number(form.minConfidence) * 100)}%`} />
                    <span className="w-12 rounded-md bg-muted px-2 py-1 text-center text-sm font-semibold tabular-nums text-foreground" data-testid="confidence-value">{Math.round(Number(form.minConfidence) * 100)}%</span>
                  </div>
                </Field>
                <Field label="Priority" htmlFor="pb-prio" hint="Higher runs first when two playbooks fit the same ticket.">
                  <input id="pb-prio" type="number" min="0" max="1000" value={form.priority} onChange={(e) => set({ priority: e.target.value })} className={`${narrowInput} w-28`} />
                </Field>
              </div>
            </NumberedSection>

            {/* 6 · Follow-up */}
            <NumberedSection n={6} id="pb-followup" title="Follow-up & closure" description="After an answer is sent. The requester can always reply to reach a person.">
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Check in after (business days)" htmlFor="pb-nudge">
                  <input id="pb-nudge" type="number" min="1" max="30" value={fu.nudgeAfterBusinessDays} onChange={(e) => setFollow({ nudgeAfterBusinessDays: Number(e.target.value) })} className={`${narrowInput} w-24`} />
                </Field>
                <Field label="Close after a further (business days)" htmlFor="pb-close">
                  <input id="pb-close" type="number" min="1" max="30" value={fu.closeAfterBusinessDays} onChange={(e) => setFollow({ closeAfterBusinessDays: Number(e.target.value) })} className={`${narrowInput} w-24`} />
                </Field>
              </div>
              <div className="mt-4">
                <Field label="Check-in message" htmlFor="pb-nudge-text" hint={`{{days}} becomes the close-after days. Reads: “${nudgePreview}”`}>
                  <textarea id="pb-nudge-text" rows={2} value={fu.nudgeText} onChange={(e) => setFollow({ nudgeText: e.target.value })} className={textareaClass} />
                </Field>
              </div>
              <div className="mt-4 grid gap-4 md:grid-cols-2">
                <div role="radiogroup" aria-label="When nobody replies" className="space-y-1.5">
                  <span className={fieldLabel}>When nobody replies</span>
                  {[['resolve', 'Resolve the ticket'], ['leave_open', 'Leave it open for a person']].map(([v, label]) => (
                    <label key={v} className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                      <input type="radio" name="pb-silence" checked={fu.onSilence === v} onChange={() => setFollow({ onSilence: v })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                      {label}
                    </label>
                  ))}
                </div>
                <div role="radiogroup" aria-label="When they still need help" className="space-y-1.5">
                  <span className={fieldLabel}>When they reply that they still need help</span>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input type="radio" name="pb-help" checked={!helpGroup} onChange={() => set({ onHelp: 'assign_normally' })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                    Keep the assignee and tell them
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-sm text-foreground">
                    <input type="radio" name="pb-help" checked={Boolean(helpGroup)} disabled={!groups.length} onChange={() => set({ onHelp: groups[0]?.value || 'assign_normally' })} className="h-4 w-4 accent-[hsl(var(--primary))]" />
                    Send it to a group, unassigned
                  </label>
                  {helpGroup && (
                    <div className="ml-6 max-w-xs">
                      <FancySelect value={helpGroup} onChange={(v) => set({ onHelp: v || 'assign_normally' })} options={groups} aria-label="Group" disabled={readOnly} />
                      <p className="mt-1 text-[11px] text-muted-foreground/75">FreshService tickets keep their assignee (the group is FreshService&rsquo;s); the assignee is told.</p>
                    </div>
                  )}
                </div>
              </div>
            </NumberedSection>
          </fieldset>
          {error && <p className="px-1 text-sm text-red-700 dark:text-red-300" role="alert">{error}</p>}
        </div>

        <div className="settings-scrollbar min-w-0 xl:sticky xl:top-20 xl:max-h-[calc(100vh-6rem)] xl:overflow-y-auto xl:rounded-xl">
          <PlaybookSidePanel
            playbookId={isNew ? null : Number(playbookId)}
            dirty={dirty}
            canManage={canManage}
            tab={panelTab}
            onTab={setPanelTab}
            runRequest={runRequest}
            readiness={!isNew ? readiness : null}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmDelete}
        title="Delete this playbook?"
        confirmLabel="Delete playbook"
        destructive
        onCancel={() => setConfirmDelete(false)}
        onConfirm={remove}
      >
        Its past runs stay in Activity. A playbook whose answers are still waiting on requesters can&rsquo;t be deleted; switch it off instead.
      </ConfirmDialog>
      <ConfirmDialog
        open={confirmDuplicate}
        title="Duplicate without your edits?"
        confirmLabel="Duplicate saved version"
        cancelLabel="Keep editing"
        destructive
        onCancel={() => setConfirmDuplicate(false)}
        onConfirm={() => { setConfirmDuplicate(false); copy(saved || form); }}
      >
        The copy is made from the saved version and opens at once, so your unsaved edits here are lost. To keep them in a copy, use Save as copy.
      </ConfirmDialog>
    </div>
  );
}
