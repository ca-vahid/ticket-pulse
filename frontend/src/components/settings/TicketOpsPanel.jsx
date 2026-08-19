import { useCallback, useEffect, useState } from 'react';
import { AlertTriangle, Archive, CalendarClock, Check, FileText, Globe as GlobeGlyph, Layers, Loader2, Plus, RefreshCw, Sparkles, Star, StickyNote, Tag as TagGlyph, Timer, Trash2, Wand2 } from 'lucide-react';
import { settingsAPI, ticketsAPI, workspaceAPI } from '../../services/api';
import { useWorkspace } from '../../contexts/WorkspaceContext';
import { TAG_CHIP_TONES, TYPE_COLOR_TONES } from '../tickets/ticketUi';
import { useTicketTypes, invalidateTicketTypesCache } from '../../hooks/useTicketTypes';
import TicketStatusesSection from './TicketStatusesSection';

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

export function SlaSection() {
  const { activeTypes } = useTicketTypes();
  const [policies, setPolicies] = useState([]);
  const [busyKey, setBusyKey] = useState(null); // `${priority}:${typeId}`
  const [typeTab, setTypeTab] = useState(null); // type id (string); no generic scope
  // Calendar-aware SLAs (QA 08-17 #9): per-workspace flag — when on, the
  // clocks count business minutes only (Settings → Business Hours & Holidays).
  const [calendarAware, setCalendarAware] = useState(null); // null = loading
  const [calendarBusy, setCalendarBusy] = useState(false);
  const load = useCallback(() => {
    settingsAPI.getSlaPolicies().then((res) => setPolicies(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);
  useEffect(() => {
    settingsAPI.getSlaCalendar()
      .then((res) => setCalendarAware((res.data?.data ?? res.data)?.slaCalendarAware === true))
      .catch(() => setCalendarAware(false));
  }, []);

  const toggleCalendar = async () => {
    if (calendarAware === null || calendarBusy) return;
    setCalendarBusy(true);
    try {
      const res = await settingsAPI.updateSlaCalendar(!calendarAware);
      setCalendarAware((res.data?.data ?? res.data)?.slaCalendarAware === true);
    } catch { /* flag unchanged on failure */ }
    setCalendarBusy(false);
  };
  // SLAs are defined PER TYPE (no generic fallback) — land on the first type.
  useEffect(() => {
    if (typeTab === null && activeTypes.length) setTypeTab(String(activeTypes[0].id));
  }, [typeTab, activeTypes]);

  const currentTypeId = typeTab === null ? null : Number(typeTab);
  const forTab = new Map(policies.filter((p) => p.ticketTypeId === currentTypeId).map((p) => [p.priority, p]));

  const save = async (priority, fr, resolve) => {
    setBusyKey(`${priority}:${currentTypeId}`);
    try {
      await settingsAPI.upsertSlaPolicy({ priority, ticketTypeId: currentTypeId, firstResponseMinutes: fr || null, resolveMinutes: resolve || null });
      load();
    } catch { /* validation message is in the response; keep simple */ }
    setBusyKey(null);
  };

  // 24/7 escape hatch: flips a policy row between 'inherit' (follow the
  // workspace calendar) and 'always_on' (wall-clock around the clock — for
  // Urgent / Major Incident clocks that must not pause over a weekend).
  const toggleAlwaysOn = async (policy) => {
    if (!policy) return;
    setBusyKey(`mode:${policy.priority}:${currentTypeId}`);
    try {
      await settingsAPI.upsertSlaPolicy({
        priority: policy.priority,
        ticketTypeId: currentTypeId,
        firstResponseMinutes: policy.firstResponseMinutes || null,
        resolveMinutes: policy.resolveMinutes || null,
        calendarMode: policy.calendarMode === 'always_on' ? 'inherit' : 'always_on',
      });
      load();
    } catch { /* keep simple */ }
    setBusyKey(null);
  };

  return (
    <SectionCard icon={Timer} title="SLA policies (Ticket Pulse tickets)" hint="Per-type, per-priority clocks applied when a TP-born ticket is created (e.g. a tighter Major Incident response than a Service Request). The clock pauses while a ticket is Pending. Build escalation ladders as workflows on the SLA-breach triggers.">
      <div className="mb-3 rounded-lg border border-slate-200 bg-slate-50/70 px-3 py-2.5">
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-start gap-2">
            <CalendarClock className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" aria-hidden="true" />
            <div>
              <p className="text-xs font-bold text-slate-700">Calendar-aware SLAs</p>
              <p className="text-[11px] text-slate-500 mt-0.5 max-w-lg">
                Due dates count business hours only — uses <span className="font-semibold text-slate-600">Settings → Business Hours &amp; Holidays</span>.
                The clock already pauses while a ticket is Pending; this also stops it over weekends and holidays.
              </p>
            </div>
          </div>
          <button
            type="button"
            role="switch"
            aria-checked={calendarAware === true}
            aria-label={`Calendar-aware SLAs ${calendarAware ? 'on' : 'off'}`}
            onClick={toggleCalendar}
            disabled={calendarAware === null || calendarBusy}
            className={`tp-focus-ring relative inline-flex h-5 w-9 shrink-0 rounded-full transition-colors disabled:opacity-60 ${calendarAware ? 'bg-blue-600' : 'bg-slate-300'}`}
          >
            <span className="absolute top-0.5 left-0.5 h-4 w-4 rounded-full bg-white shadow transition-transform" style={{ transform: calendarAware ? 'translateX(16px)' : 'translateX(0)' }} aria-hidden="true" />
          </button>
        </div>
        {calendarAware === true && (
          <p className="text-[11px] text-blue-600/90 mt-1.5 ml-6">
            New tickets get business-hours due dates. Mark a row <span className="font-semibold">24/7</span> to keep that clock running around the clock.
          </p>
        )}
      </div>
      {activeTypes.length === 0 && (
        <p className="text-xs text-slate-400 italic">Configure ticket types above first — SLAs are defined per type.</p>
      )}
      {activeTypes.length > 1 && (
        <div className="flex flex-wrap gap-1 mb-2.5" role="tablist" aria-label="SLA ticket type">
          {activeTypes.map((t) => {
            const count = policies.filter((p) => p.ticketTypeId === t.id).length;
            return (
              <button
                key={t.id}
                role="tab"
                aria-selected={typeTab === String(t.id)}
                onClick={() => setTypeTab(String(t.id))}
                className={`tp-focus-ring px-2.5 py-1 rounded-full text-[11px] font-semibold border ${typeTab === String(t.id) ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-500 border-slate-200 hover:border-blue-300'}`}
              >
                {t.name}{count > 0 && <span className="ml-1 opacity-70">({count})</span>}
              </button>
            );
          })}
        </div>
      )}
      {currentTypeId !== null && (
        <div className="space-y-1.5">
          {[4, 3, 2, 1].map((priority) => (
            <SlaRow
              key={`${priority}:${typeTab}`}
              priority={priority}
              policy={forTab.get(priority)}
              busy={busyKey === `${priority}:${currentTypeId}`}
              onSave={save}
              onDelete={async () => { await settingsAPI.deleteSlaPolicy(priority, currentTypeId).catch(() => {}); load(); }}
              calendarAware={calendarAware === true}
              modeBusy={busyKey === `mode:${priority}:${currentTypeId}`}
              onToggleAlwaysOn={() => toggleAlwaysOn(forTab.get(priority))}
            />
          ))}
        </div>
      )}
    </SectionCard>
  );
}

function SlaRow({ priority, policy, busy, onSave, onDelete, calendarAware = false, modeBusy = false, onToggleAlwaysOn }) {
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
      {calendarAware && policy && (
        <button
          type="button"
          onClick={onToggleAlwaysOn}
          disabled={modeBusy}
          aria-pressed={policy.calendarMode === 'always_on'}
          aria-label={`${PRIORITY_LABELS[priority]} SLA ${policy.calendarMode === 'always_on' ? 'runs 24/7 — switch to the business-hours calendar' : 'follows business hours — switch to 24/7'}`}
          title={policy.calendarMode === 'always_on'
            ? 'Runs 24/7 — this clock never pauses for weekends or holidays. Click to follow the business-hours calendar.'
            : 'Follows the business-hours calendar. Click to run this clock 24/7 (e.g. Urgent / Major Incident).'}
          className={`tp-focus-ring px-1.5 py-0.5 rounded-full text-[10px] font-bold border disabled:opacity-60 ${policy.calendarMode === 'always_on'
            ? 'bg-indigo-600 text-white border-indigo-600'
            : 'bg-white text-slate-400 border-slate-200 hover:border-indigo-300 hover:text-indigo-500'}`}
        >
          24/7
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

// ---------------------------------------------------------------- ticket types

const TYPE_COLOR_KEYS = Object.keys(TYPE_COLOR_TONES);

function TicketTypesSection() {
  const { types, refresh } = useTicketTypes();
  const [draft, setDraft] = useState(null); // create/edit form state
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [error, setError] = useState(null);
  const [confirmRetire, setConfirmRetire] = useState(null);

  const reload = useCallback(() => {
    invalidateTicketTypesCache();
    refresh({ force: true });
  }, [refresh]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const payload = {
        name: draft.name,
        description: draft.description || null,
        color: draft.color,
        abbreviation: draft.abbreviation || null,
        aiAssignable: draft.aiAssignable,
        isDefault: draft.isDefault,
        fsTypeValue: draft.fsMapped ? (draft.fsTypeValue || draft.name) : null,
        aliases: String(draft.aliases || '').split(',').map((a) => a.trim()).filter(Boolean),
      };
      if (editingId) {
        delete payload.name; // renames are retire+create by design
        await settingsAPI.updateTicketType(editingId, payload);
      } else {
        await settingsAPI.createTicketType(payload);
      }
      setDraft(null); setEditingId(null);
      reload();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const retire = async (id) => {
    setError(null);
    try { await settingsAPI.retireTicketType(id); reload(); } catch (e) { setError(e.response?.data?.message || e.message); }
    setConfirmRetire(null);
  };

  const syncNow = async () => {
    setSyncing(true); setError(null);
    try { await settingsAPI.syncTicketTypes(); reload(); } catch (e) { setError(e.response?.data?.message || e.message); }
    setSyncing(false);
  };

  const startEdit = (t) => {
    setEditingId(t.id);
    setDraft({
      name: t.name,
      description: t.description || '',
      color: t.color || 'slate',
      abbreviation: t.abbreviation || '',
      aiAssignable: t.aiAssignable !== false,
      isDefault: Boolean(t.isDefault),
      fsMapped: Boolean(t.fsTypeValue),
      fsTypeValue: t.fsTypeValue || '',
      aliases: (t.aliases || []).join(', '),
    });
  };

  // FS drift: a mapped type FS hasn't offered in >48h probably got removed.
  const fsStale = (t) => t.fsTypeValue && t.fsDetectedAt && (Date.now() - new Date(t.fsDetectedAt).getTime() > 48 * 60 * 60 * 1000);

  return (
    <SectionCard icon={Layers} title="Ticket types" hint="This workspace's ticket-type vocabulary: what agents pick, what the AI classifies against (the description IS its guidance), what SLAs key on, and how each type maps to FreshService. Types are retired, never deleted.">
      <div className="space-y-1.5 mb-2">
        {types.map((t) => {
          const tone = TYPE_COLOR_TONES[t.color] || TYPE_COLOR_TONES.slate;
          return (
            <div key={t.id} className={`rounded-lg border px-2.5 py-1.5 ${t.isActive ? 'border-slate-100' : 'border-slate-100 opacity-50'}`}>
              <div className="flex items-center gap-2 text-xs">
                <span aria-hidden="true" className={`inline-flex items-center justify-center min-w-[30px] h-[18px] px-1 rounded-[5px] text-[9px] font-bold tracking-wider ${tone.tile}`}>
                  {t.abbreviation || t.name.slice(0, 4).toUpperCase()}
                </span>
                <span className={`font-semibold ${t.isActive ? 'text-slate-700' : 'text-slate-400 line-through'}`}>{t.name}</span>
                {t.isDefault && <span title="Default for new tickets"><Star className="w-3 h-3 text-amber-400 fill-amber-400" aria-label="Default type" /></span>}
                {t.aiAssignable !== false
                  ? <span className="inline-flex items-center gap-0.5 text-[10px] text-indigo-500" title="The AI may classify tickets as this type"><Sparkles className="w-3 h-3" aria-hidden="true" />AI</span>
                  : <span className="text-[10px] text-slate-400" title="Human-only: the AI never assigns this type">human-only</span>}
                {t.fsTypeValue
                  ? <span className="text-[10px] text-slate-400" title={`Written to FreshService as "${t.fsTypeValue}"`}>FS: {t.fsTypeValue}</span>
                  : <span className="text-[10px] text-cyan-600 font-medium" title="Ticket Pulse–native: never written to FreshService">TP-only</span>}
                {fsStale(t) && (
                  <span className="inline-flex items-center gap-0.5 text-[10px] text-amber-600" title="FreshService hasn't offered this type choice recently — it may have been removed in FS admin">
                    <AlertTriangle className="w-3 h-3" aria-hidden="true" /> FS drift
                  </span>
                )}
                {t.isActive && !t.description && (
                  <span className="text-[10px] text-amber-500 italic" title="Add a description so the AI knows when to pick this type">needs description</span>
                )}
                <span className="flex-1" />
                {t.isActive && (
                  <>
                    <button onClick={() => startEdit(t)} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">Edit</button>
                    {confirmRetire === t.id ? (
                      <button onClick={() => retire(t.id)} className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white font-semibold">
                        <Archive className="w-3 h-3" aria-hidden="true" /> Confirm retire
                      </button>
                    ) : (
                      <button onClick={() => setConfirmRetire(t.id)} aria-label={`Retire type ${t.name}`} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200">Retire</button>
                    )}
                  </>
                )}
                {!t.isActive && <span className="text-[10px] text-slate-300 italic">retired</span>}
              </div>
              {t.description && <p className="mt-1 ml-9 text-[11px] text-slate-400 line-clamp-2">{t.description}</p>}
            </div>
          );
        })}
        {types.length === 0 && <p className="text-xs text-slate-400 italic">No ticket types configured — &ldquo;Check FreshService&rdquo; imports this workspace&apos;s FS type choices.</p>}
      </div>
      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-1.5 text-xs">
          <div className="grid grid-cols-2 gap-1.5">
            <input value={draft.name} disabled={Boolean(editingId)} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Type name (e.g. Breakfix)" aria-label="Type name" title={editingId ? 'Types cannot be renamed — retire and create a new one' : undefined} className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1 disabled:bg-slate-50 disabled:text-slate-400" />
            <input value={draft.abbreviation} onChange={(e) => setDraft({ ...draft, abbreviation: e.target.value.toUpperCase().slice(0, 6) })} placeholder="Pill code (e.g. BRK)" aria-label="Abbreviation" className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1 uppercase" />
          </div>
          <textarea
            value={draft.description}
            onChange={(e) => setDraft({ ...draft, description: e.target.value })}
            placeholder="Description — this is the AI's classification guidance. Say when a ticket IS this type (e.g. “Something that used to work is broken or degraded…”)."
            aria-label="Type description (AI guidance)"
            className="tp-focus-ring w-full h-16 border border-slate-200 rounded-md px-2 py-1"
          />
          <div className="flex flex-wrap items-center gap-3">
            <select value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} aria-label="Pill color" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              {TYPE_COLOR_KEYS.map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            <label className="flex items-center gap-1.5 text-slate-500">
              <input type="checkbox" checked={draft.aiAssignable} onChange={(e) => setDraft({ ...draft, aiAssignable: e.target.checked })} className="tp-focus-ring" />
              AI may pick this type
            </label>
            <label className="flex items-center gap-1.5 text-slate-500">
              <input type="checkbox" checked={draft.isDefault} onChange={(e) => setDraft({ ...draft, isDefault: e.target.checked })} className="tp-focus-ring" />
              Default for new tickets
            </label>
            <label className="flex items-center gap-1.5 text-slate-500" title="Unmapped types stay Ticket Pulse–only: never written to FreshService">
              <input type="checkbox" checked={draft.fsMapped} onChange={(e) => setDraft({ ...draft, fsMapped: e.target.checked })} className="tp-focus-ring" />
              Maps to FreshService
            </label>
            {draft.fsMapped && (
              <input value={draft.fsTypeValue} onChange={(e) => setDraft({ ...draft, fsTypeValue: e.target.value })} placeholder={draft.name || 'FS value'} aria-label="FreshService type value" className="tp-focus-ring w-36 border border-slate-200 rounded-md px-2 py-1" />
            )}
          </div>
          <input value={draft.aliases} onChange={(e) => setDraft({ ...draft, aliases: e.target.value })} placeholder="Aliases, comma-separated (e.g. breakfix, break-fix) — accepted as input and normalized to the name" aria-label="Aliases" className="tp-focus-ring w-full border border-slate-200 rounded-md px-2 py-1" />
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy || (!editingId && !draft.name.trim())} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
              {busy ? <Loader2 className="w-3 h-3 animate-spin inline" aria-hidden="true" /> : (editingId ? 'Save' : 'Create')}
            </button>
            <button onClick={() => { setDraft(null); setEditingId(null); setError(null); }} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
          </div>
        </div>
      ) : (
        <div className="flex items-center gap-3">
          <button onClick={() => setDraft({ name: '', description: '', color: 'slate', abbreviation: '', aiAssignable: true, isDefault: false, fsMapped: false, fsTypeValue: '', aliases: '' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
            <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New type
          </button>
          <button onClick={syncNow} disabled={syncing} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-slate-500 hover:text-slate-700 disabled:opacity-60" title="Re-read this workspace's Type choices from FreshService; new FS types are added automatically">
            {syncing ? <Loader2 className="w-3.5 h-3.5 animate-spin" aria-hidden="true" /> : <RefreshCw className="w-3.5 h-3.5" aria-hidden="true" />} Check FreshService
          </button>
        </div>
      )}
    </SectionCard>
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

// Fields provisioned by API intake in the last 7 days get a "new from API"
// highlight so admins spot what arrived and curate it (FR 08-05 #1, Phase 1c).
const API_FIELD_FRESH_DAYS = 7;

export function CustomFieldsSection() {
  const [fields, setFields] = useState([]);
  const [draft, setDraft] = useState(null); // { key, label, type, options }
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const load = useCallback(() => {
    settingsAPI.getCustomFields().then((res) => setFields(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      const payload = {
        label: draft.label,
        type: draft.type,
        options: draft.type === 'select' ? String(draft.options || '').split(',').map((v) => v.trim()).filter(Boolean) : [],
      };
      if (editingId) {
        await settingsAPI.updateCustomField(editingId, payload);
      } else {
        await settingsAPI.createCustomField({ ...payload, key: draft.key });
      }
      setDraft(null); setEditingId(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const startEdit = (field) => {
    setEditingId(field.id);
    setError(null);
    setDraft({
      key: field.key,
      label: field.label,
      type: field.type,
      options: (field.options || []).join(', '),
    });
  };

  const isApiBorn = (field) => field.source === 'api';
  const isFreshFromApi = (field) => isApiBorn(field) && field.createdAt
    && (Date.now() - new Date(field.createdAt).getTime() < API_FIELD_FRESH_DAYS * 24 * 60 * 60 * 1000);

  // Featured field (Phase 2): the ONE definition surfaced as a chip on queue
  // rows + the peek. Optimistic single-select — the server enforces one max
  // (featuring one unfeatures the rest), so mirror that locally and reconcile
  // with a reload.
  const toggleFeatured = async (field) => {
    const next = !field.isFeatured;
    setFields((prev) => prev.map((f) => ({ ...f, isFeatured: f.id === field.id ? next : false })));
    try { await settingsAPI.updateCustomField(field.id, { isFeatured: next }); } catch { /* reload shows truth */ }
    load();
  };

  return (
    <SectionCard icon={Plus} title="Custom fields" hint="Per-workspace fields shown on every ticket (Ticket Pulse's own annotation layer — never written to FreshService). API senders can set values at creation — unknown keys auto-provision a definition here, badged API, for you to curate. Usable in workflow conditions as custom:<key>.">
      <ul className="space-y-1 mb-2">
        {fields.map((field) => (
          <li
            key={field.id}
            className={`flex items-center gap-2 text-xs rounded-md px-1.5 py-1 -mx-1.5 ${isFreshFromApi(field) ? 'bg-indigo-50/70' : ''}`}
          >
            <span className={`font-semibold ${field.isActive ? 'text-slate-700' : 'text-slate-300 line-through'}`}>{field.label}</span>
            <code className="text-[10px] bg-slate-100 rounded px-1 text-slate-500">{field.key}</code>
            <span className="text-slate-400">{field.type}{field.type === 'select' ? ` (${(field.options || []).length})` : ''}</span>
            {isApiBorn(field) ? (
              <span
                className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-indigo-600 bg-indigo-50 border border-indigo-100 rounded-full px-1.5 py-px"
                title="Auto-provisioned by API intake — type inferred from the first value; edit to curate"
              >
                <Sparkles className="w-2.5 h-2.5" aria-hidden="true" /> API
              </span>
            ) : (
              <span className="text-[10px] text-slate-400 border border-slate-200 rounded-full px-1.5 py-px" title="Created by an admin in Settings">Manual</span>
            )}
            {isFreshFromApi(field) && <span className="text-[10px] text-indigo-500 italic">new from API</span>}
            {!field.isActive && <span className="text-[10px] text-slate-300 italic">retired</span>}
            <span className="flex-1" />
            <button
              onClick={() => toggleFeatured(field)}
              aria-label={field.isFeatured ? `Unfeature ${field.label}` : `Feature ${field.label} on queue rows`}
              aria-pressed={field.isFeatured}
              title={field.isFeatured
                ? 'Featured: shown as a chip on queue rows and in the peek. Click to unfeature.'
                : 'Feature this field: shows as a chip on queue rows and in the peek (one per workspace — featuring this unfeatures the current one)'}
              className={`tp-focus-ring p-1 rounded ${field.isFeatured ? 'text-amber-400 hover:text-amber-500' : 'text-slate-300 hover:text-amber-400'}`}
            >
              <Star className={`w-3.5 h-3.5 ${field.isFeatured ? 'fill-amber-400' : ''}`} aria-hidden="true" />
            </button>
            <button
              onClick={() => startEdit(field)}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              Edit
            </button>
            <button
              onClick={async () => { await settingsAPI.updateCustomField(field.id, { isActive: !field.isActive }).catch(() => {}); load(); }}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              title={field.isActive
                ? 'Retire: hides the field from forms and conditions; stored ticket values are kept'
                : 'Reactivate this field'}
            >
              {field.isActive ? 'Deactivate' : 'Reactivate'}
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
            <input
              value={draft.key}
              disabled={Boolean(editingId)}
              onChange={(e) => setDraft({ ...draft, key: e.target.value })}
              placeholder="key (e.g. cost_centre)"
              aria-label="Field key"
              title={editingId ? 'Keys are permanent — ticket values are stored under them' : undefined}
              className="tp-focus-ring border border-slate-200 rounded-md px-2 py-1 font-mono disabled:bg-slate-50 disabled:text-slate-400"
            />
          </div>
          <div className="flex gap-1.5">
            <select value={draft.type} onChange={(e) => setDraft({ ...draft, type: e.target.value })} aria-label="Field type" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
              {['text', 'number', 'select', 'boolean', 'date'].map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            {draft.type === 'select' && (
              <input value={draft.options} onChange={(e) => setDraft({ ...draft, options: e.target.value })} placeholder="Options, comma-separated" aria-label="Options" className="tp-focus-ring flex-1 border border-slate-200 rounded-md px-2 py-1" />
            )}
          </div>
          {editingId && (
            <p className="text-[10px] text-slate-400">Existing ticket values keep their stored shape — the new type applies from the next edit or API write.</p>
          )}
          {error && <p className="text-red-500">{error}</p>}
          <div className="flex gap-1.5">
            <button onClick={save} disabled={busy || !String(draft.label || '').trim()} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
              {busy ? <Loader2 className="w-3 h-3 animate-spin inline" aria-hidden="true" /> : (editingId ? 'Save' : 'Create')}
            </button>
            <button onClick={() => { setDraft(null); setEditingId(null); setError(null); }} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
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

function TagsSection() {
  const [tags, setTags] = useState([]);
  const [draft, setDraft] = useState(null); // { name, color }
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [mergingId, setMergingId] = useState(null); // tag id with merge picker open

  const load = useCallback(() => {
    settingsAPI.getTicketTags().then((res) => setTags(res.data?.data || res.data || [])).catch(() => {});
  }, []);
  useEffect(() => { load(); }, [load]);

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await settingsAPI.createTicketTag(draft);
      setDraft(null);
      load();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const act = async (fn) => {
    setError(null);
    try { await fn(); load(); } catch (e) { setError(e.response?.data?.message || e.message); }
  };

  return (
    <SectionCard icon={TagGlyph} title="Tags" hint="The workspace tag palette. Tags apply to tickets of both origins (never written to FreshService) and power queue filters, workflow conditions/actions, and analytics.">
      <ul className="space-y-1 mb-2">
        {tags.map((tag) => (
          <li key={tag.id} className="flex items-center gap-2 text-xs">
            <span className={`px-2 py-0.5 rounded-full border font-medium ${TAG_CHIP_TONES[tag.color] || TAG_CHIP_TONES.slate} ${tag.isActive ? '' : 'opacity-40 line-through'}`}>{tag.name}</span>
            <span className="text-slate-400">{tag.ticketCount} ticket{tag.ticketCount === 1 ? '' : 's'}</span>
            <span className="flex-1" />
            <select
              value=""
              onChange={(e) => { if (e.target.value) act(() => settingsAPI.updateTicketTag(tag.id, { color: e.target.value })); }}
              aria-label={`Recolor ${tag.name}`}
              className="tp-focus-ring text-[10px] border border-slate-200 rounded px-1 py-0.5 text-slate-500"
            >
              <option value="">color…</option>
              {Object.keys(TAG_CHIP_TONES).map((c) => <option key={c} value={c}>{c}</option>)}
            </select>
            {mergingId === tag.id ? (
              <select
                autoFocus
                value=""
                onChange={(e) => {
                  const target = Number(e.target.value);
                  setMergingId(null);
                  if (target) act(() => settingsAPI.mergeTicketTag(tag.id, target));
                }}
                onBlur={() => setMergingId(null)}
                aria-label={`Merge ${tag.name} into`}
                className="tp-focus-ring text-[10px] border border-blue-300 rounded px-1 py-0.5 text-blue-700"
              >
                <option value="">merge into…</option>
                {tags.filter((t) => t.id !== tag.id && t.isActive).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
              </select>
            ) : (
              <button onClick={() => setMergingId(tag.id)} className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50">Merge</button>
            )}
            <button
              onClick={() => act(() => settingsAPI.updateTicketTag(tag.id, { isActive: !tag.isActive }))}
              className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
            >
              {tag.isActive ? 'Disable' : 'Enable'}
            </button>
            <button
              onClick={() => act(() => settingsAPI.deleteTicketTag(tag.id))}
              aria-label={`Delete tag ${tag.name}`}
              className="tp-focus-ring p-1 rounded text-slate-300 hover:text-red-500"
            >
              <Trash2 className="w-3.5 h-3.5" aria-hidden="true" />
            </button>
          </li>
        ))}
        {tags.length === 0 && <li className="text-xs text-slate-400 italic">No tags yet.</li>}
      </ul>
      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 flex items-center gap-1.5 text-xs">
          <input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} placeholder="Tag name (e.g. VIP)" aria-label="Tag name" className="tp-focus-ring flex-1 border border-slate-200 rounded-md px-2 py-1" />
          <select value={draft.color} onChange={(e) => setDraft({ ...draft, color: e.target.value })} aria-label="Tag color" className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1">
            {Object.keys(TAG_CHIP_TONES).map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
          <button onClick={save} disabled={busy || !draft.name.trim()} className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60">
            {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Create'}
          </button>
          <button onClick={() => setDraft(null)} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
        </div>
      ) : (
        <button onClick={() => setDraft({ name: '', color: 'slate' })} className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700">
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New tag
        </button>
      )}
    </SectionCard>
  );
}

function CategoryGroupSection() {
  const [links, setLinks] = useState([]); // [{ categoryId, groupId }]
  const [categories, setCategories] = useState([]);
  const [groups, setGroups] = useState([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    ticketsAPI.meta().then((res) => {
      setCategories((res.data?.categoryTree || []).map((c) => ({ id: c.id, name: c.name })));
      setGroups((res.data?.groups || []).filter((g) => g.freshserviceId).map((g) => ({ id: String(g.freshserviceId), name: g.name })));
    }).catch(() => {});
    ticketsAPI.categoryGroupLinks().then((res) => {
      setLinks((res.data || []).map((l) => ({ categoryId: l.categoryId, groupId: String(l.groupId) })));
    }).catch(() => {});
  }, []);

  const toggle = (categoryId, groupId) => {
    setDirty(true);
    setLinks((prev) => {
      const exists = prev.some((l) => l.categoryId === categoryId && l.groupId === groupId);
      return exists
        ? prev.filter((l) => !(l.categoryId === categoryId && l.groupId === groupId))
        : [...prev, { categoryId, groupId }];
    });
  };

  const save = async () => {
    setBusy(true); setError(null);
    try {
      await ticketsAPI.setCategoryGroupLinks(links);
      setDirty(false);
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  if (groups.length === 0) return null;

  return (
    <SectionCard icon={Check} title="Category ↔ group mapping" hint="Scope top categories to specific groups: a mapped category only shows in pickers for tickets in one of its groups. Categories with no mapping stay visible everywhere.">
      <div className="space-y-1.5 mb-2">
        {categories.map((cat) => {
          const mapped = links.filter((l) => l.categoryId === cat.id).map((l) => l.groupId);
          return (
            <div key={cat.id} className="flex flex-wrap items-center gap-1.5 text-xs">
              <span className="w-56 truncate font-semibold text-slate-600" title={cat.name}>{cat.name}</span>
              {groups.map((g) => (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => toggle(cat.id, g.id)}
                  aria-pressed={mapped.includes(g.id)}
                  className={`tp-focus-ring px-2 py-0.5 rounded-full border text-[11px] ${
                    mapped.includes(g.id) ? 'bg-indigo-600 text-white border-indigo-600' : 'bg-white text-slate-400 border-slate-200 hover:border-indigo-300'
                  }`}
                >
                  {g.name}
                </button>
              ))}
              {mapped.length === 0 && <span className="text-[10px] text-slate-300 italic">all groups</span>}
            </div>
          );
        })}
      </div>
      {error && <p className="text-xs text-red-500 mb-1.5">{error}</p>}
      {dirty && (
        <button onClick={save} disabled={busy} className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-60">
          {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />} Save mapping
        </button>
      )}
    </SectionCard>
  );
}

// Trusted (internal) email domains — tickets whose requester email is outside
// this list get an "External" badge across the queue/preview/detail (QA 07-27
// #4). Per-workspace; empty list turns the flagging off.
function TrustedDomainsSection() {
  const { currentWorkspace } = useWorkspace();
  const [domains, setDomains] = useState([]);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(false);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    if (!currentWorkspace?.id) return;
    workspaceAPI.getById(currentWorkspace.id)
      .then((res) => setDomains(res.data?.internalDomains || res.data?.data?.internalDomains || []))
      .catch(() => {})
      .finally(() => setLoaded(true));
  }, [currentWorkspace?.id]);

  const persist = async (next) => {
    setBusy(true); setSaved(false);
    try {
      const res = await workspaceAPI.update(currentWorkspace.id, { internalDomains: next });
      setDomains(res.data?.internalDomains || res.data?.data?.internalDomains || next);
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    } catch { /* keep prior state; server rejects malformed domains silently */ }
    setBusy(false);
  };

  const addDomain = () => {
    const cleaned = draft.trim().toLowerCase().replace(/^.*@/, '');
    if (!cleaned) return;
    setDraft('');
    if (domains.includes(cleaned)) return;
    persist([...domains, cleaned]);
  };

  return (
    <SectionCard
      icon={GlobeGlyph}
      title="Trusted domains (external-requester flag)"
      hint='Tickets from requester emails OUTSIDE these domains get an amber "External" badge in the queue, preview, and detail. Add every domain your organization sends from (subdomains are trusted automatically). Leave empty to turn the badge off.'
    >
      <div className="flex flex-wrap items-center gap-1.5">
        {domains.map((d) => (
          <span key={d} className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-xs font-semibold text-slate-700">
            {d}
            <button
              type="button"
              aria-label={`Remove ${d}`}
              onClick={() => persist(domains.filter((x) => x !== d))}
              disabled={busy}
              className="text-slate-400 hover:text-red-600"
            >
              ×
            </button>
          </span>
        ))}
        {loaded && domains.length === 0 && (
          <span className="text-xs italic text-slate-400">No trusted domains yet — external flagging is off.</span>
        )}
      </div>
      <div className="mt-3 flex items-center gap-2">
        <input
          type="text"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addDomain(); } }}
          placeholder="bgcengineering.ca"
          className="h-9 w-64 rounded-lg border border-slate-200 px-3 text-sm outline-none focus:ring-2 focus:ring-blue-200"
        />
        <button
          type="button"
          onClick={addDomain}
          disabled={busy || !draft.trim()}
          className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-slate-900 px-3 text-sm font-semibold text-white hover:bg-slate-800 disabled:opacity-50"
        >
          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Plus className="h-4 w-4" aria-hidden="true" />}
          Add domain
        </button>
        {saved && <span className="inline-flex items-center gap-1 text-xs font-semibold text-emerald-600"><Check className="h-3.5 w-3.5" aria-hidden="true" /> Saved</span>}
      </div>
    </SectionCard>
  );
}

export default function TicketOpsPanel() {
  return (
    <div className="space-y-4 animate-fadeIn">
      <TicketTypesSection />
      <TicketStatusesSection />
      <SlaSection />
      <TrustedDomainsSection />
      <TagsSection />
      <CategoryGroupSection />
      <MacrosSection />
      <QuickNotesSection />
      <CustomFieldsSection />
      <CreateTemplatesSection />
    </div>
  );
}
