import { useCallback, useEffect, useState } from 'react';
import { Check, FileText, Loader2, Plus, StickyNote, Timer, Trash2, Wand2 } from 'lucide-react';
import { settingsAPI, ticketsAPI } from '../../services/api';

/**
 * Admin config for the enterprise ticket ops shipped with the workflow revamp:
 *  - SLA policies: per-priority first-response/resolution clocks for TP-born
 *    tickets (escalation LADDERS are workflows on the SLA triggers).
 *  - Macros: one-click quick-action bundles for agents.
 *  - Custom fields: per-workspace user-defined ticket fields.
 * Deliberately spartan — three focused CRUD sections, one panel.
 */

const PRIORITY_LABELS = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };

function SectionCard({ icon: Icon, title, hint, children }) {
  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <Icon className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">{title}</h3>
      </div>
      <p className="text-xs text-slate-400 mb-3">{hint}</p>
      {children}
    </section>
  );
}

function SlaSection() {
  const [policies, setPolicies] = useState([]);
  const [busyPriority, setBusyPriority] = useState(null);
  const load = useCallback(() => {
    settingsAPI.getSlaPolicies().then((res) => setPolicies(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const byPriority = new Map(policies.map((p) => [p.priority, p]));

  const save = async (priority, fr, resolve) => {
    setBusyPriority(priority);
    try {
      await settingsAPI.upsertSlaPolicy({ priority, firstResponseMinutes: fr || null, resolveMinutes: resolve || null });
      load();
    } catch { /* validation message is in the response; keep simple */ }
    setBusyPriority(null);
  };

  return (
    <SectionCard icon={Timer} title="SLA policies (Ticket Pulse tickets)" hint="Per-priority clocks applied when a TP-born ticket is created. Build escalation ladders as workflows on the SLA-breach triggers.">
      <div className="space-y-1.5">
        {[4, 3, 2, 1].map((priority) => {
          const policy = byPriority.get(priority);
          return (
            <SlaRow
              key={priority}
              priority={priority}
              policy={policy}
              busy={busyPriority === priority}
              onSave={save}
              onDelete={async () => { await settingsAPI.deleteSlaPolicy(priority).catch(() => {}); load(); }}
            />
          );
        })}
      </div>
    </SectionCard>
  );
}

function SlaRow({ priority, policy, busy, onSave, onDelete }) {
  const [fr, setFr] = useState(policy?.firstResponseMinutes ?? '');
  const [resolve, setResolve] = useState(policy?.resolveMinutes ?? '');
  useEffect(() => { setFr(policy?.firstResponseMinutes ?? ''); setResolve(policy?.resolveMinutes ?? ''); }, [policy]);
  const dirty = String(fr) !== String(policy?.firstResponseMinutes ?? '') || String(resolve) !== String(policy?.resolveMinutes ?? '');

  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="w-16 font-semibold text-slate-600">{PRIORITY_LABELS[priority]}</span>
      <label className="flex items-center gap-1 text-slate-400">
        first response
        <input type="number" min="5" value={fr} onChange={(e) => setFr(e.target.value)} placeholder="—" aria-label={`${PRIORITY_LABELS[priority]} first-response minutes`} className="tp-focus-ring w-20 border border-slate-200 rounded-md px-1.5 py-1 tabular-nums" />
        m
      </label>
      <label className="flex items-center gap-1 text-slate-400">
        resolve
        <input type="number" min="5" value={resolve} onChange={(e) => setResolve(e.target.value)} placeholder="—" aria-label={`${PRIORITY_LABELS[priority]} resolve minutes`} className="tp-focus-ring w-24 border border-slate-200 rounded-md px-1.5 py-1 tabular-nums" />
        m
      </label>
      {dirty && (
        <button onClick={() => onSave(priority, Number(fr) || null, Number(resolve) || null)} disabled={busy} className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />} Save
        </button>
      )}
      {policy && (
        <button onClick={onDelete} aria-label={`Remove ${PRIORITY_LABELS[priority]} SLA`} className="tp-focus-ring ml-auto p-1 rounded text-slate-300 hover:text-red-500">
          <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

function MacrosSection() {
  const [macros, setMacros] = useState([]);
  const [draft, setDraft] = useState(null); // { name, description, actions }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    settingsAPI.getMacros().then((res) => setMacros(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await settingsAPI.createMacro(draft);
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  return (
    <SectionCard icon={Wand2} title="Macros" hint="One-click bundles agents apply from a ticket: status + priority + note/reply together, using the same audited paths as manual edits.">
      <ul className="space-y-1 mb-2">
        {macros.map((macro) => (
          <li key={macro.id} className="flex items-center gap-2 text-xs">
            <span className={`font-semibold ${macro.isActive ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{macro.name}</span>
            <span className="text-slate-400 truncate flex-1">{Object.keys(macro.actions || {}).join(' · ')}</span>
            <button
              onClick={async () => { await settingsAPI.updateMacro(macro.id, { isActive: !macro.isActive }).catch(() => {}); load(); }}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              {macro.isActive ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={async () => { await settingsAPI.deleteMacro(macro.id).catch(() => {}); load(); }}
              aria-label={`Delete macro ${macro.name}`}
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {macros.length === 0 && <li className="text-xs text-slate-400 italic">No macros yet.</li>}
      </ul>
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-1.5 text-xs">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Macro name" aria-label="Macro name" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          <div className="grid grid-cols-2 gap-1.5">
            <select value={draft.actions.setStatus || ''} onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, setStatus: e.target.value || undefined } })} aria-label="Set status" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              <option value="">Status: unchanged</option>
              {['Open', 'Pending', 'Resolved', 'Closed'].map((s) => <option key={s} value={s}>Status → {s}</option>)}
            </select>
            <select value={draft.actions.setPriority || ''} onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, setPriority: Number(e.target.value) || undefined } })} aria-label="Set priority" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              <option value="">Priority: unchanged</option>
              {[1, 2, 3, 4].map((p) => <option key={p} value={p}>Priority → {PRIORITY_LABELS[p]}</option>)}
            </select>
          </div>
          <input value={draft.actions.addNote || ''} onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, addNote: e.target.value || undefined } })} placeholder="Internal note to add (optional)" aria-label="Internal note" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          <input value={draft.actions.replyBody || ''} onChange={(e) => setDraft({ ...draft, actions: { ...draft.actions, replyBody: e.target.value || undefined } })} placeholder="Reply to requester (optional)" aria-label="Reply body" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          {error && <p className="text-red-500">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">Create</button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', description: '', actions: {} })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New macro
        </button>
      )}
    </SectionCard>
  );
}

function CustomFieldsSection() {
  const [fields, setFields] = useState([]);
  const [draft, setDraft] = useState(null); // { key, label, type, options }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    settingsAPI.getCustomFields().then((res) => setFields(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await settingsAPI.createCustomField({
        ...draft,
        options: draft.type === 'select' ? String(draft.options || '').split(',').map((v) => v.trim()).filter(Boolean) : [],
      });
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  return (
    <SectionCard icon={Plus} title="Custom fields" hint="Per-workspace fields shown on every ticket (Ticket Pulse's own annotation layer — never written to FreshService). Usable in workflow conditions as custom:<key>.">
      <ul className="space-y-1 mb-2">
        {fields.map((field) => (
          <li key={field.id} className="flex items-center gap-2 text-xs">
            <span className={`font-semibold ${field.isActive ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{field.label}</span>
            <code className="text-[10px] bg-slate-100 rounded px-1 text-slate-500">{field.key}</code>
            <span className="text-slate-400">{field.type}{field.type === 'select' ? ` (${field.options.length})` : ''}</span>
            <button
              onClick={async () => { await settingsAPI.updateCustomField(field.id, { isActive: !field.isActive }).catch(() => {}); load(); }}
              className="tp-focus-ring ml-auto text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              {field.isActive ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={async () => { await settingsAPI.deleteCustomField(field.id).catch(() => {}); load(); }}
              aria-label={`Delete field ${field.label}`}
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {fields.length === 0 && <li className="text-xs text-slate-400 italic">No custom fields yet.</li>}
      </ul>
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-1.5 text-xs">
          <div className="grid grid-cols-2 gap-1.5">
            <input value={draft.label} onChange={(e) => setDraft({ ...draft, label: e.target.value })} placeholder="Label (e.g. Cost centre)" aria-label="Field label" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1" />
            <input value={draft.key} onChange={(e) => setDraft({ ...draft, key: e.target.value })} placeholder="key (e.g. cost_centre)" aria-label="Field key" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1 font-mono" />
          </div>
          <div className="flex gap-1.5">
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} aria-label="Field type" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              {['text', 'number', 'select', 'boolean', 'date'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {draft.type === 'select' && (
              <input value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Options, comma-separated" aria-label="Options" className="tp-focus-ring flex-1 border border-slate-200 rounded-md px-2 py-1" />
            )}
          </div>
          {error && <p className="text-red-500">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">Create</button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ key: '', label: '', type: 'text', options: '' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New field
        </button>
      )}
    </SectionCard>
  );
}

function CreateTemplatesSection() {
  const [templates, setTemplates] = useState([]);
  const [draft, setDraft] = useState(null); // { name, subject, description, priority }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    settingsAPI.getTicketTemplates().then((res) => setTemplates(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await settingsAPI.createTicketTemplate({ ...draft, priority: Number(draft.priority) || null });
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  return (
    <SectionCard icon={FileText} title="Create-form templates" hint="Presets that pre-fill the new-ticket form for recurring request shapes (subject, description scaffold, priority).">
      <ul className="space-y-1 mb-2">
        {templates.map((template) => (
          <li key={template.id} className="flex items-center gap-2 text-xs">
            <span className={`font-semibold ${template.isActive ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{template.name}</span>
            <span className="text-slate-400 truncate flex-1">{template.subject || '—'}</span>
            <button
              onClick={async () => { await settingsAPI.updateTicketTemplate(template.id, { isActive: !template.isActive }).catch(() => {}); load(); }}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              {template.isActive ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={async () => { await settingsAPI.deleteTicketTemplate(template.id).catch(() => {}); load(); }}
              aria-label={`Delete template ${template.name}`}
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {templates.length === 0 && <li className="text-xs text-slate-400 italic">No templates yet.</li>}
      </ul>
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-1.5 text-xs">
          <div className="grid grid-cols-2 gap-1.5">
            <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Template name" aria-label="Template name" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1" />
            <select value={draft.priority || ''} onChange={(e) => setDraft({ ...draft, priority: e.target.value })} aria-label="Priority" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              <option value="">Priority: none</option>
              {[1, 2, 3, 4].map((p) => <option key={p} value={p}>Priority → {PRIORITY_LABELS[p]}</option>)}
            </select>
          </div>
          <input value={draft.subject} onChange={(e) => setDraft({ ...draft, subject: e.target.value })} placeholder="Subject (e.g. New starter — laptop + accounts)" aria-label="Subject" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          <textarea value={draft.description} onChange={(e) => setDraft({ ...draft, description: e.target.value })} placeholder={'Description scaffold, e.g.\nStart date:\nManager:\nEquipment needed:'} aria-label="Description scaffold" className="tp-focus-ring w-full h-20 border border-slate-200 rounded-md px-2 py-1" />
          {error && <p className="text-red-500">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy || !draft.name} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">Create</button>
            <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', subject: '', description: '', priority: '' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New template
        </button>
      )}
    </SectionCard>
  );
}

function QuickNotesSection() {
  const [notes, setNotes] = useState([]);
  const [categories, setCategories] = useState([]); // top-level internal categories
  const [draft, setDraft] = useState(null); // { name, bodyText, internalCategoryIds }
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    settingsAPI.getQuickNotes().then((res) => setNotes(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    ticketsAPI.meta().then((res) => setCategories((res.data?.categoryTree || []).map((c) => ({ id: c.id, name: c.name })))).catch(() => {});
  }, []);

  const categoryName = (id) => categories.find((c) => c.id === id)?.name || `#${id}`;

  const save = async () => {
    setBusy(true); setError(null);
    try {
      if (editingId) await settingsAPI.updateQuickNote(editingId, draft);
      else await settingsAPI.createQuickNote(draft);
      setDraft(null); setEditingId(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const toggleCategory = (id) => setDraft((d) => ({
    ...d,
    internalCategoryIds: d.internalCategoryIds.includes(id)
      ? d.internalCategoryIds.filter((x) => x !== id)
      : [...d.internalCategoryIds, id],
  }));

  return (
    <SectionCard icon={StickyNote} title="Quick notes" hint="Canned internal notes agents insert from the composer's note mode. Scope a note to top categories, or leave unscoped to show it on every ticket.">
      <ul className="space-y-1 mb-2">
        {notes.map((note) => (
          <li key={note.id} className="flex items-center gap-2 text-xs">
            <span className={`font-semibold ${note.isActive ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{note.name}</span>
            <span className="text-slate-400 truncate flex-1" title={note.bodyText}>
              {(note.internalCategoryIds || []).length > 0
                ? (note.internalCategoryIds || []).map(categoryName).join(', ')
                : 'All categories'}
              {' · '}{String(note.bodyText || '').slice(0, 60)}
            </span>
            <button
              onClick={() => { setEditingId(note.id); setDraft({ name: note.name, bodyText: note.bodyText, internalCategoryIds: note.internalCategoryIds || [] }); }}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              Edit
            </button>
            <button
              onClick={async () => { await settingsAPI.updateQuickNote(note.id, { isActive: !note.isActive }).catch(() => {}); load(); }}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              {note.isActive ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={async () => { await settingsAPI.deleteQuickNote(note.id).catch(() => {}); load(); }}
              aria-label={`Delete quick note ${note.name}`}
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {notes.length === 0 && <li className="text-xs text-slate-400 italic">No quick notes yet.</li>}
      </ul>
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-1.5 text-xs">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Note name (e.g. Chased requester — no response)" aria-label="Quick note name" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          <textarea value={draft.bodyText} onChange={(e) => setDraft({ ...draft, bodyText: e.target.value })} placeholder="Internal note body…" aria-label="Quick note body" className="tp-focus-ring w-full h-20 border border-slate-200 rounded-md px-2 py-1" />
          <div>
            <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Show for categories <span className="font-normal normal-case">(none selected = every ticket)</span></p>
            <div className="flex flex-wrap gap-1">
              {categories.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => toggleCategory(c.id)}
                  aria-pressed={draft.internalCategoryIds.includes(c.id)}
                  className={`tp-focus-ring px-2 py-0.5 rounded-full border text-[11px] ${draft.internalCategoryIds.includes(c.id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
                >
                  {c.name}
                </button>
              ))}
              {categories.length === 0 && <span className="text-slate-400 italic">No internal categories in this workspace.</span>}
            </div>
          </div>
          {error && <p className="text-red-500">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy || !draft.name.trim() || !draft.bodyText.trim()} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
              {busy ? <Loader2 className="w-3 h-3 animate-spin inline" aria-hidden="true" /> : (editingId ? 'Save' : 'Create')}
            </button>
            <button onClick={() => { setDraft(null); setEditingId(null); setError(null); }} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', bodyText: '', internalCategoryIds: [] })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New quick note
        </button>
      )}
    </SectionCard>
  );
}

export default function TicketOpsPanel() {
  return (
    <div className="space-y-4 animate-fadeIn">
      <SlaSection />
      <MacrosSection />
      <QuickNotesSection />
      <CustomFieldsSection />
      <CreateTemplatesSection />
    </div>
  );
}
