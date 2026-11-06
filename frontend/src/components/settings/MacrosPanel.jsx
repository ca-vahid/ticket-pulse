import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowUp, Braces, ImagePlus, Info, Loader2, Pencil, Plus, Trash2, Wand2, X,
} from 'lucide-react';
import { settingsAPI, ticketsAPI } from '../../services/api';
import RichTextEditor from '../tickets/RichTextEditor';
import { Switch, SwitchCue } from '../ui/switch';
import {
  MACRO_ACTIONS, MACRO_ACTION_BY_TYPE, MACRO_VARIABLES, PRIORITY_LABELS,
  blankStep, describeStep, editableSteps, stepsForSave,
} from '../../utils/macroActions';

/**
 * Settings → Macros (QA 11-05 #2). Its own tab now (it used to be one card in
 * Ticket Ops), and a macro is an ordered list of actions like a FreshService
 * scenario: reply to the requester, add an internal note, set status /
 * priority / category / group / type / due date / a custom field, assign,
 * add tags. The reply and the note use the ticket composer's own editor, so
 * pictures and formatting work, plus "Insert variable" for the requester's
 * first name, the ticket number and the rest. Agents apply a macro from the
 * Macros button on a ticket and see what it will do before it runs.
 *
 * Same list layout as Alert correlation: one row per macro with its switch,
 * the plain summary of its actions, and edit / delete.
 */

const unwrap = (res) => res?.data?.data ?? res?.data ?? res;
const MAX_PICTURE_BYTES = 1.5 * 1024 * 1024;
const field = 'tp-focus-ring h-8 rounded-md border border-input bg-card px-2 text-sm text-foreground';

/** "Insert variable": a small menu of the tokens a macro fills in. */
export function VariableMenu({ onPick, label = 'Insert variable', testId }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onKey); };
  }, [open]);
  return (
    <span ref={boxRef} className="relative inline-flex">
      <button
        type="button"
        onMouseDown={(e) => e.preventDefault()}
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="menu"
        aria-expanded={open}
        data-testid={testId}
        className="tp-focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
      >
        <Braces className="h-3.5 w-3.5" aria-hidden="true" /> {label}
      </button>
      {open && (
        <div role="menu" aria-label="Variables" className="absolute left-0 top-full z-40 mt-1 w-96 max-w-[calc(100vw-2rem)] tp-card rounded-lg py-1 shadow-soft">
          {MACRO_VARIABLES.map((v) => (
            <button
              key={v.token}
              type="button"
              role="menuitem"
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onPick(v.token); setOpen(false); }}
              className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted"
            >
              <span>{v.label}</span>
              <code className="shrink-0 font-mono text-[11px] text-muted-foreground">{v.token}</code>
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

function readPicture(file) {
  return new Promise((resolve, reject) => {
    if (!file || !String(file.type || '').startsWith('image/')) { reject(new Error('That file is not a picture')); return; }
    if (file.size > MAX_PICTURE_BYTES) { reject(new Error('Pictures in a macro can be up to 1.5 MB')); return; }
    const reader = new FileReader();
    reader.onload = () => {
      const src = String(reader.result || '');
      const img = new Image();
      img.onload = () => resolve({ src, width: Math.min(img.naturalWidth || 480, 600) });
      img.onerror = () => resolve({ src, width: 480 });
      img.src = src;
    };
    reader.onerror = () => reject(new Error('That picture could not be read'));
    reader.readAsDataURL(file);
  });
}

/** The reply / note body: the composer's editor + variables + pictures. */
function MacroBodyEditor({ value, onChange, ariaLabel, placeholder, testId }) {
  const editorRef = useRef(null);
  const fileRef = useRef(null);
  const [error, setError] = useState(null);
  const addPicture = useCallback(async (file) => {
    setError(null);
    try {
      const { src, width } = await readPicture(file);
      editorRef.current?.insertHtml(`<img src="${src}" alt="" width="${width}">`);
    } catch (e) { setError(e.message); }
  }, []);
  return (
    <div data-testid={testId}>
      <div className="mb-1 flex flex-wrap items-center gap-1">
        <VariableMenu onPick={(token) => editorRef.current?.insertText(token)} testId={testId ? `${testId}-variables` : undefined} />
        <button
          type="button"
          onClick={() => fileRef.current?.click()}
          className="tp-focus-ring inline-flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <ImagePlus className="h-3.5 w-3.5" aria-hidden="true" /> Insert picture
        </button>
        <input
          ref={fileRef}
          type="file"
          accept="image/*"
          className="sr-only"
          tabIndex={-1}
          aria-label="Choose a picture"
          onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) addPicture(f); }}
        />
        <span className="ml-auto text-[11px] text-muted-foreground">Paste a screenshot straight in, too.</span>
      </div>
      <RichTextEditor
        ref={editorRef}
        value={value || ''}
        onChange={({ html }) => onChange(html)}
        ariaLabel={ariaLabel}
        placeholder={placeholder}
        minHeight={120}
        onImagePaste={(file) => { addPicture(file); return null; }}
      />
      {error && <p className="mt-1 text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>}
    </div>
  );
}

/** Subject line with its own variable menu (inserts at the cursor). */
function SubjectInput({ value, onChange }) {
  const inputRef = useRef(null);
  const insert = (token) => {
    const el = inputRef.current;
    const v = String(value || '');
    const start = el?.selectionStart ?? v.length;
    const end = el?.selectionEnd ?? v.length;
    const next = `${v.slice(0, start)}${token}${v.slice(end)}`;
    onChange(next);
    requestAnimationFrame(() => { el?.focus(); el?.setSelectionRange(start + token.length, start + token.length); });
  };
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <input
        ref={inputRef}
        value={value || ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder="The workspace's usual reply subject"
        aria-label="Reply subject"
        aria-describedby="macro-subject-hint"
        className={`${field} min-w-0 flex-1`}
      />
      <VariableMenu onPick={insert} label="Variable" testId="macro-subject-variables" />
    </div>
  );
}

function StepConfig({ step, onPatch, lookups }) {
  const { statuses = [], categories = [], groups = [], technicians = [], types = [], tags = [], customFields = [] } = lookups;
  switch (step.type) {
  case 'reply':
    return (
      <div className="space-y-2">
        <label className="block text-xs font-medium text-muted-foreground">Subject <span className="font-normal">(optional)</span></label>
        <SubjectInput value={step.subject} onChange={(subject) => onPatch({ subject })} />
        <p id="macro-subject-hint" className="text-[11px] text-muted-foreground">
          Leave empty to use the workspace&apos;s usual reply subject (keeps the thread together). A subject you type still gets the ticket number. FreshService tickets use FreshService&apos;s own subject.
        </p>
        <label className="block text-xs font-medium text-muted-foreground">Message</label>
        <MacroBodyEditor value={step.html} onChange={(html) => onPatch({ html })} ariaLabel="Reply to the requester" placeholder="Hi {{requester.firstName}}, …" testId="macro-reply-body" />
      </div>
    );
  case 'note':
    return <MacroBodyEditor value={step.html} onChange={(html) => onPatch({ html })} ariaLabel="Internal note" placeholder="What the agent should know…" testId="macro-note-body" />;
  case 'status':
    return (
      <select value={step.status || ''} onChange={(e) => onPatch({ status: e.target.value })} aria-label="Status" className={field}>
        <option value="">Pick a status…</option>
        {/* Only the workspace's live statuses (Resolved drops out where it is retired). */}
        {statuses.map((s) => <option key={s.name} value={s.name}>{s.name}</option>)}
        {step.status && statuses.length > 0 && !statuses.some((s) => s.name === step.status) && (
          <option value={step.status} disabled>{step.status} (no longer offered here)</option>
        )}
      </select>
    );
  case 'priority':
    return (
      <select value={String(step.priority || '')} onChange={(e) => onPatch({ priority: Number(e.target.value) })} aria-label="Priority" className={field}>
        {[1, 2, 3, 4].map((p) => <option key={p} value={p}>{PRIORITY_LABELS[p]}</option>)}
      </select>
    );
  case 'category': {
    const top = categories.find((c) => Number(c.id) === Number(step.categoryId));
    return (
      <div className="flex flex-wrap gap-2">
        <select value={String(step.categoryId || '')} onChange={(e) => onPatch({ categoryId: e.target.value ? Number(e.target.value) : '', subcategoryId: '' })} aria-label="Category" className={field}>
          <option value="">Pick a category…</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        {top && (top.subcategories || []).length > 0 && (
          <select value={String(step.subcategoryId || '')} onChange={(e) => onPatch({ subcategoryId: e.target.value ? Number(e.target.value) : '' })} aria-label="Subcategory" className={field}>
            <option value="">No subcategory</option>
            {top.subcategories.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
        )}
      </div>
    );
  }
  case 'group':
    return (
      <select value={String(step.groupId || '')} onChange={(e) => onPatch({ groupId: e.target.value ? Number(e.target.value) : '' })} aria-label="Group" className={field}>
        <option value="">Pick a group…</option>
        {groups.map((g) => <option key={g.id} value={g.id}>{g.name}{g.origin === 'local' ? ' (internal)' : ''}</option>)}
      </select>
    );
  case 'assign':
    return (
      <select
        value={step.to === 'applier' ? 'applier' : String(step.technicianId || '')}
        onChange={(e) => (e.target.value === 'applier' ? onPatch({ to: 'applier', technicianId: '' }) : onPatch({ to: 'technician', technicianId: e.target.value ? Number(e.target.value) : '' }))}
        aria-label="Assign to"
        className={field}
      >
        <option value="applier">The person applying it</option>
        <option value="">Pick a person…</option>
        {technicians.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
      </select>
    );
  case 'type':
    return (
      <select value={step.ticketType || ''} onChange={(e) => onPatch({ ticketType: e.target.value })} aria-label="Type" className={field}>
        <option value="">Pick a type…</option>
        {types.map((t) => <option key={t.id || t.name} value={t.name}>{t.name}</option>)}
      </select>
    );
  case 'tags':
    return tags.length === 0 ? <p className="text-xs text-muted-foreground">No tags in this workspace yet (Settings → Ticket Ops → Tags).</p> : (
      <fieldset className="max-h-40 overflow-y-auto settings-scrollbar rounded-md border border-border px-2 py-1.5">
        <legend className="sr-only">Tags to add</legend>
        <div className="grid gap-x-4 gap-y-1 sm:grid-cols-2">
          {tags.map((t) => {
            const on = (step.tagIds || []).map(Number).includes(Number(t.id));
            return (
              <label key={t.id} className="flex items-center gap-2 text-sm text-foreground">
                <input
                  type="checkbox"
                  checked={on}
                  onChange={() => onPatch({ tagIds: on ? step.tagIds.filter((id) => Number(id) !== Number(t.id)) : [...(step.tagIds || []), Number(t.id)] })}
                  className="h-4 w-4 accent-[hsl(var(--primary))]"
                />
                {t.name}
              </label>
            );
          })}
        </div>
      </fieldset>
    );
  case 'due':
    return (
      <div className="flex flex-wrap items-center gap-2 text-sm text-foreground">
        <input type="number" min={1} max={step.unit === 'hours' ? 8760 : 365} value={step.amount} onChange={(e) => onPatch({ amount: Number(e.target.value) || 1 })} aria-label="How long" className={`${field} w-20`} />
        <select value={step.unit} onChange={(e) => onPatch({ unit: e.target.value })} aria-label="Unit" className={field}>
          <option value="hours">hours</option>
          <option value="days">days</option>
        </select>
        <span className="text-muted-foreground">after the macro is applied</span>
      </div>
    );
  case 'custom_field': {
    const def = customFields.find((d) => d.key === step.key);
    const valueInput = !def ? null : def.type === 'select' ? (
      <select value={String(step.value ?? '')} onChange={(e) => onPatch({ value: e.target.value })} aria-label="Value" className={field}>
        <option value="">(blank)</option>
        {(def.options || []).map((o) => <option key={o} value={o}>{o}</option>)}
      </select>
    ) : def.type === 'boolean' ? (
      <select value={step.value === true ? 'true' : 'false'} onChange={(e) => onPatch({ value: e.target.value === 'true' })} aria-label="Value" className={field}>
        <option value="true">Yes</option>
        <option value="false">No</option>
      </select>
    ) : (
      <input
        type={def.type === 'number' ? 'number' : def.type === 'date' ? 'date' : 'text'}
        value={step.value ?? ''}
        onChange={(e) => onPatch({ value: def.type === 'number' ? (e.target.value === '' ? '' : Number(e.target.value)) : e.target.value })}
        aria-label="Value"
        className={`${field} w-56`}
      />
    );
    return (
      <div className="flex flex-wrap items-center gap-2">
        <select value={step.key || ''} onChange={(e) => { const d = customFields.find((x) => x.key === e.target.value); onPatch({ key: e.target.value, label: d?.label || '', value: d?.type === 'boolean' ? false : '' }); }} aria-label="Custom field" className={field}>
          <option value="">Pick a field…</option>
          {customFields.map((d) => <option key={d.key} value={d.key}>{d.label}</option>)}
        </select>
        {valueInput}
      </div>
    );
  }
  default:
    return null;
  }
}

/** Add-an-action menu (a list, never pills). */
function AddActionMenu({ onAdd }) {
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (boxRef.current && !boxRef.current.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  return (
    <span ref={boxRef} className="relative inline-flex">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-haspopup="menu" aria-expanded={open} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md px-2 py-1.5 text-sm font-medium text-primary hover:bg-muted">
        <Plus className="h-4 w-4" aria-hidden="true" /> Add action
      </button>
      {open && (
        <div role="menu" aria-label="Actions" className="absolute left-0 top-full z-40 mt-1 w-72 tp-card rounded-lg py-1 shadow-soft">
          {MACRO_ACTIONS.map((a) => (
            <button key={a.type} type="button" role="menuitem" onClick={() => { onAdd(a.type); setOpen(false); }} className="flex w-full items-baseline justify-between gap-3 px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted">
              <span>{a.label}</span>
              {a.tpOnly && <span className="shrink-0 text-[11px] text-muted-foreground">Ticket Pulse tickets</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}

export function MacroForm({ initial, lookups, onSave, onCancel, busy = false, error = null }) {
  const [name, setName] = useState(initial?.name || '');
  const [description, setDescription] = useState(initial?.description || '');
  const [steps, setSteps] = useState(() => editableSteps(initial?.actions));
  const patchStep = (id, patch) => setSteps((list) => list.map((s) => (s.id === id ? { ...s, ...patch } : s)));
  const move = (index, delta) => setSteps((list) => {
    const next = [...list];
    const [item] = next.splice(index, 1);
    next.splice(index + delta, 0, item);
    return next;
  });
  const submit = (e) => {
    e.preventDefault();
    onSave({ name: name.trim(), description: description.trim(), actions: { steps: stepsForSave(steps) } });
  };
  // QA 11-05b #4: steps run in this exact order, so a reply can follow a
  // close. closedBefore[i] = the closing status a step at i runs after, or null.
  const closedBefore = useMemo(() => {
    const baseOf = new Map((lookups?.statuses || []).map((s) => [s.name, s.baseStatus || s.name]));
    let closed = null;
    return steps.map((s) => {
      const before = closed;
      if (s.type === 'status' && s.status) closed = ['Resolved', 'Closed'].includes(baseOf.get(s.status) || s.status) ? s.status : null;
      return before;
    });
  }, [steps, lookups?.statuses]);
  return (
    // Two levels at most (house style): the form has no box of its own; the action
    // list is plain rows split by rules.
    <form onSubmit={submit} className="space-y-3 py-1" data-testid="macro-form" aria-label={initial?.id ? `Edit ${initial.name}` : 'New macro'}>
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">Name</span>
          <input value={name} onChange={(e) => setName(e.target.value)} required maxLength={120} placeholder="Spam / phishing reported" aria-label="Macro name" className={`${field} mt-0.5 w-full`} />
        </label>
        <label className="block">
          <span className="text-xs font-medium text-muted-foreground">What it is for <span className="font-normal">(agents see this in the menu)</span></span>
          <input value={description} onChange={(e) => setDescription(e.target.value)} maxLength={300} placeholder="Thanks the requester, notes it, files it as phishing and closes it" aria-label="Macro description" className={`${field} mt-0.5 w-full`} />
        </label>
      </div>

      <div>
        <div className="flex items-baseline justify-between gap-2">
          <h4 className="text-sm font-semibold text-foreground">Actions</h4>
          <p className="text-[11px] text-muted-foreground">Run top to bottom, in exactly this order.</p>
        </div>
        <ol className="mt-1.5 divide-y divide-border/60 border-y border-border/60" data-testid="macro-steps">
          {steps.length === 0 && <li className="py-3 text-xs text-muted-foreground">No actions yet. Add the first one below.</li>}
          {steps.map((step, i) => {
            const meta = MACRO_ACTION_BY_TYPE[step.type] || { label: step.type };
            return (
              <li key={step.id} className="py-3" data-testid={`macro-step-${step.type}`}>
                <div className="flex items-center gap-2">
                  <span className="w-5 shrink-0 text-xs font-semibold tabular-nums text-muted-foreground">{i + 1}.</span>
                  <span className="text-sm font-medium text-foreground">{meta.label}</span>
                  {meta.tpOnly && <SwitchCue>Ticket Pulse tickets only — FreshService owns this field</SwitchCue>}
                  <span className="ml-auto flex items-center gap-0.5">
                    <button type="button" onClick={() => move(i, -1)} disabled={i === 0} aria-label={`Move “${meta.label}” up`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"><ArrowUp className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button type="button" onClick={() => move(i, 1)} disabled={i === steps.length - 1} aria-label={`Move “${meta.label}” down`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-40"><ArrowDown className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button type="button" onClick={() => setSteps((list) => list.filter((s) => s.id !== step.id))} aria-label={`Remove “${meta.label}”`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </span>
                </div>
                <div className="mt-2 pl-7">
                  <StepConfig step={step} onPatch={(patch) => patchStep(step.id, patch)} lookups={lookups} />
                  {meta.hint && <p className="mt-1 text-[11px] text-muted-foreground">{meta.hint}</p>}
                  {step.type === 'reply' && closedBefore[i] && (
                    <p className="mt-1 flex items-start gap-1 text-[11px] text-amber-800 dark:text-amber-200" data-testid="macro-reply-after-close">
                      <Info className="mt-px h-3 w-3 shrink-0" aria-hidden="true" />
                      Runs after the ticket is set to {closedBefore[i]}: the reply is still sent, and the ticket stays {closedBefore[i]}.
                    </p>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
        <div className="mt-1.5"><AddActionMenu onAdd={(type) => setSteps((list) => [...list, blankStep(type)])} /></div>
      </div>

      {error && <p className="text-xs text-red-600 dark:text-red-300" role="alert">{error}</p>}
      <div className="flex items-center gap-2">
        <button type="submit" disabled={busy || !name.trim() || steps.length === 0} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-50">
          {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />} {initial?.id ? 'Save macro' : 'Create macro'}
        </button>
        <button type="button" onClick={onCancel} className="tp-focus-ring rounded-lg px-3 py-1.5 text-xs font-medium text-muted-foreground hover:bg-muted">Cancel</button>
      </div>
    </form>
  );
}

export default function MacrosPanel() {
  const [macros, setMacros] = useState(null);
  const [lookups, setLookups] = useState({});
  const [editing, setEditing] = useState(null); // null | 'new' | macro
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState(null);

  const load = useCallback(() => {
    settingsAPI.getMacros().then((res) => setMacros(unwrap(res) || [])).catch(() => setMacros([]));
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    let cancelled = false;
    Promise.all([
      Promise.resolve().then(() => ticketsAPI.meta()).then(unwrap).catch(() => ({})),
      Promise.resolve().then(() => settingsAPI.getTicketTypes()).then(unwrap).catch(() => []),
      Promise.resolve().then(() => settingsAPI.getCustomFields()).then(unwrap).catch(() => []),
    ]).then(([meta, types, customFields]) => {
      if (cancelled) return;
      setLookups({
        statuses: meta?.statuses || [],
        categories: meta?.categoryTree || [],
        groups: meta?.groups || [],
        technicians: meta?.technicians || [],
        tags: meta?.tags || [],
        types: (Array.isArray(types) ? types : []).filter((t) => t.isActive !== false),
        customFields: (Array.isArray(customFields) ? customFields : []).filter((d) => d.isActive !== false),
      });
    });
    return () => { cancelled = true; };
  }, []);

  const save = async (payload) => {
    setBusy(true); setFormError(null);
    try {
      if (editing && editing !== 'new') await settingsAPI.updateMacro(editing.id, payload);
      else await settingsAPI.createMacro(payload);
      setEditing(null);
      load();
    } catch (e) { setFormError(e.response?.data?.message || e.message); }
    setBusy(false);
  };
  const toggle = async (macro) => { await settingsAPI.updateMacro(macro.id, { isActive: !macro.isActive }).catch(() => {}); load(); };
  const remove = async (macro) => {
    if (typeof window !== 'undefined' && window.confirm && !window.confirm(`Delete the macro “${macro.name}”? Agents can no longer apply it.`)) return;
    await settingsAPI.deleteMacro(macro.id).catch(() => {});
    load();
  };

  const activeCount = useMemo(() => (macros || []).filter((m) => m.isActive).length, [macros]);

  return (
    <div className="space-y-4 animate-fadeIn" data-testid="macros-panel">
      <section className="tp-card rounded-xl p-4">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="mb-1 flex items-center gap-2">
              <Wand2 className="h-4 w-4 text-blue-500" aria-hidden="true" />
              <h3 className="text-sm font-bold text-foreground">Macros</h3>
              {macros && <span className="text-xs text-muted-foreground">{activeCount} of {macros.length} on</span>}
            </div>
            <p className="text-xs text-muted-foreground/75">
              One click from the Macros button on a ticket runs a set of actions: reply to the requester, add an internal note, set the status, category and more.
              Agents see what a macro will do before it runs. Every step uses the same path as doing it by hand, so the ticket history, the FreshService copy and the requester&rsquo;s e-mail behave as usual.
              On FreshService tickets only what Ticket Pulse can already change there is applied.
            </p>
          </div>
          <button onClick={() => { setEditing('new'); setFormError(null); }} className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700">
            <Plus className="h-3.5 w-3.5" aria-hidden="true" /> New macro
          </button>
        </div>

        {editing === 'new' && <div className="mt-3"><MacroForm initial={null} lookups={lookups} onSave={save} onCancel={() => setEditing(null)} busy={busy} error={formError} /></div>}

        <ul className="mt-3 divide-y divide-border/60 rounded-xl border border-border" data-testid="macro-list">
          {macros === null && <li className="px-3 py-3 text-xs text-muted-foreground">Loading…</li>}
          {macros?.length === 0 && editing !== 'new' && <li className="px-3 py-4 text-xs text-muted-foreground">No macros yet. Start with the one your team types most often.</li>}
          {(macros || []).map((macro) => (
            <li key={macro.id} className="px-3 py-2.5">
              {editing && editing !== 'new' && editing.id === macro.id ? (
                <MacroForm initial={macro} lookups={lookups} onSave={save} onCancel={() => setEditing(null)} busy={busy} error={formError} />
              ) : (
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <p className={`text-sm font-semibold ${macro.isActive ? 'text-foreground' : 'text-muted-foreground'}`}>{macro.name}</p>
                    {macro.description && <p className="text-[11.5px] text-muted-foreground">{macro.description}</p>}
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      {editableSteps(macro.actions).map((s) => describeStep(s, lookups)).join(' · ') || 'No actions'}
                    </p>
                  </div>
                  {/* Switch on the right, before edit/delete, like every Settings row. */}
                  <div className="flex shrink-0 items-center gap-1">
                    <Switch
                      checked={macro.isActive === true}
                      aria-label={`${macro.isActive ? 'Turn off' : 'Turn on'} ${macro.name}`}
                      onCheckedChange={() => toggle(macro)}
                      className="mr-1.5"
                    />
                    <button onClick={() => { setEditing(macro); setFormError(null); }} aria-label={`Edit ${macro.name}`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground"><Pencil className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    <button onClick={() => remove(macro)} aria-label={`Delete ${macro.name}`} className="tp-focus-ring rounded p-1 text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300"><Trash2 className="h-3.5 w-3.5" aria-hidden="true" /></button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
