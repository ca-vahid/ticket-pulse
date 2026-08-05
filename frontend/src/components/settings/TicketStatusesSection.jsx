import { useCallback, useEffect, useMemo, useState } from 'react';
import { Archive, ArrowDown, ArrowUp, Check, CircleDot, Info, Loader2, Lock, Plus, RotateCcw } from 'lucide-react';
import { settingsAPI } from '../../services/api';
import { invalidateConditionFieldsCache } from './ConditionGroupBuilder';

/**
 * Settings → Ticket Ops → "Ticket statuses" (QA 08-04 #12, Phase 8a).
 * Per-workspace status vocabulary manager. Every status maps to one of the 4
 * canonical BASE statuses so lifecycle logic (SLA, terminal detection,
 * episodes) keeps working for custom labels. System rows (the canonical 4)
 * can be renamed/recolored but never re-based or retired. Custom rows retire
 * (never delete) — historical tickets keep the label.
 *
 * Queue/board/workflow consumers pick these up in the 8b/8c releases; until
 * then this section only manages the vocabulary.
 */

export const BASE_STATUSES = ['Open', 'Pending', 'Resolved', 'Closed'];

// Base-status chip tones — match the queue's status pill palette.
const BASE_CHIP_TONES = {
  Open: 'bg-blue-50 text-blue-600 border-blue-200',
  Pending: 'bg-amber-50 text-amber-700 border-amber-200',
  Resolved: 'bg-emerald-50 text-emerald-600 border-emerald-200',
  Closed: 'bg-slate-100 text-slate-500 border-slate-200',
};

// Small tp palette (same tokens as the ticket-type registry).
export const STATUS_DOT_CLASSES = {
  blue: 'bg-blue-500',
  amber: 'bg-amber-500',
  emerald: 'bg-emerald-500',
  slate: 'bg-slate-400',
  violet: 'bg-violet-500',
  orange: 'bg-orange-500',
  red: 'bg-red-500',
  cyan: 'bg-cyan-500',
  pink: 'bg-pink-500',
};
const COLOR_KEYS = Object.keys(STATUS_DOT_CLASSES);

function ColorPicker({ value, onChange, idPrefix }) {
  return (
    <div className="flex items-center gap-1" role="radiogroup" aria-label="Status color">
      {COLOR_KEYS.map((c) => (
        <button
          key={`${idPrefix}-${c}`}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Color ${c}`}
          onClick={() => onChange(c)}
          className={`tp-focus-ring w-5 h-5 rounded-full inline-flex items-center justify-center border-2 ${value === c ? 'border-slate-500' : 'border-transparent hover:border-slate-300'}`}
        >
          <span aria-hidden="true" className={`w-3 h-3 rounded-full ${STATUS_DOT_CLASSES[c]}`} />
        </button>
      ))}
    </div>
  );
}

function BaseChip({ base }) {
  return (
    <span className={`inline-flex items-center px-1.5 py-0.5 rounded-full border text-[10px] font-semibold whitespace-nowrap ${BASE_CHIP_TONES[base] || BASE_CHIP_TONES.Closed}`}>
      {base}
    </span>
  );
}

export default function TicketStatusesSection() {
  const [rows, setRows] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [draft, setDraft] = useState(null); // { name, baseStatus, color }
  const [editingId, setEditingId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [confirmRetire, setConfirmRetire] = useState(null);
  const [baseChangeArmed, setBaseChangeArmed] = useState(false);

  const load = useCallback(() => {
    settingsAPI.getTicketStatuses()
      .then((res) => setRows(res.data?.data || res.data || []))
      .catch((e) => setError(e.response?.data?.message || e.message))
      .finally(() => setLoaded(true));
  }, []);
  useEffect(() => { load(); }, [load]);

  const active = useMemo(
    () => rows.filter((r) => r.isActive).sort((a, b) => (a.sortOrder - b.sortOrder) || a.name.localeCompare(b.name)),
    [rows],
  );
  const inactive = useMemo(() => rows.filter((r) => !r.isActive), [rows]);

  const run = async (fn) => {
    setBusy(true); setError(null);
    try {
      await fn();
      load();
      // The workflow builder caches the server-resolved condition fields
      // (ticket.status options come from this registry) — keep it honest.
      invalidateConditionFieldsCache();
    } catch (e) { setError(e.response?.data?.message || e.message); }
    setBusy(false);
  };

  const editingRow = editingId ? rows.find((r) => r.id === editingId) : null;
  const baseChanged = Boolean(editingRow && draft && draft.baseStatus !== editingRow.baseStatus);

  const save = async () => {
    if (editingRow) {
      const payload = {};
      if (draft.name.trim() && draft.name.trim() !== editingRow.name) payload.name = draft.name.trim();
      if ((draft.color || null) !== (editingRow.color || null)) payload.color = draft.color || null;
      if (baseChanged) {
        // Two-step confirm: the first Save arms the warning, the second sends.
        if (!baseChangeArmed) { setBaseChangeArmed(true); return; }
        payload.baseStatus = draft.baseStatus;
        payload.confirmBaseChange = true;
      }
      await run(async () => {
        if (Object.keys(payload).length > 0) await settingsAPI.updateTicketStatus(editingRow.id, payload);
        setDraft(null); setEditingId(null); setBaseChangeArmed(false);
      });
    } else {
      await run(async () => {
        await settingsAPI.createTicketStatus({ name: draft.name.trim(), baseStatus: draft.baseStatus, color: draft.color || null });
        setDraft(null);
      });
    }
  };

  // Up/down reorder: renumber the active list so every row's sortOrder is its
  // index — robust even when legacy rows share a sortOrder.
  const move = async (index, dir) => {
    const target = index + dir;
    if (target < 0 || target >= active.length) return;
    const next = [...active];
    [next[index], next[target]] = [next[target], next[index]];
    await run(async () => {
      for (let i = 0; i < next.length; i += 1) {
        if (next[i].sortOrder !== i) await settingsAPI.updateTicketStatus(next[i].id, { sortOrder: i });
      }
    });
  };

  const startEdit = (r) => {
    setEditingId(r.id);
    setBaseChangeArmed(false);
    setDraft({ name: r.name, baseStatus: r.baseStatus, color: r.color || 'slate' });
  };

  const cancelForm = () => { setDraft(null); setEditingId(null); setError(null); setBaseChangeArmed(false); };

  return (
    <section className="tp-card rounded-xl p-4">
      <div className="flex items-center gap-2 mb-1">
        <CircleDot className="w-4 h-4 text-blue-500" aria-hidden="true" />
        <h3 className="text-sm font-bold text-slate-800">Ticket statuses</h3>
      </div>
      <p className="text-xs text-slate-400 mb-2">
        This workspace&apos;s status vocabulary. Every status maps to a <span className="font-semibold">base status</span> (Open, Pending, Resolved or Closed) that drives SLA clocks, reopen logic and reporting — a custom &ldquo;Waiting on vendor&rdquo; with a Pending base behaves exactly like Pending. Statuses are retired, never deleted.
      </p>
      <div className="flex items-start gap-1.5 rounded-lg border border-blue-100 bg-blue-50/60 px-2.5 py-1.5 mb-3 text-[11px] text-blue-700">
        <Info className="w-3.5 h-3.5 mt-px shrink-0" aria-hidden="true" />
        <span>Custom statuses apply to Ticket Pulse-born tickets. FreshService-born tickets keep FreshService statuses.</span>
      </div>

      <ul className="space-y-1.5 mb-2" aria-label="Ticket statuses">
        {active.map((r, i) => (
          <li key={r.id} className="rounded-lg border border-slate-100 px-2.5 py-1.5">
            <div className="flex items-center gap-2 text-xs">
              <div className="flex flex-col -my-0.5">
                <button
                  type="button"
                  onClick={() => move(i, -1)}
                  disabled={busy || i === 0}
                  aria-label={`Move ${r.name} up`}
                  className="tp-focus-ring text-slate-300 hover:text-slate-500 disabled:opacity-30 disabled:hover:text-slate-300"
                >
                  <ArrowUp className="w-3 h-3" aria-hidden="true" />
                </button>
                <button
                  type="button"
                  onClick={() => move(i, 1)}
                  disabled={busy || i === active.length - 1}
                  aria-label={`Move ${r.name} down`}
                  className="tp-focus-ring text-slate-300 hover:text-slate-500 disabled:opacity-30 disabled:hover:text-slate-300"
                >
                  <ArrowDown className="w-3 h-3" aria-hidden="true" />
                </button>
              </div>
              <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT_CLASSES[r.color] || 'bg-slate-300'}`} />
              <span className="font-semibold text-slate-700">{r.name}</span>
              <BaseChip base={r.baseStatus} />
              {r.isSystem && (
                <span className="inline-flex items-center gap-0.5 text-[10px] text-slate-400" title="System status — rename and recolor only; its base behavior is fixed and it can't be retired">
                  <Lock className="w-3 h-3" aria-hidden="true" /> system
                </span>
              )}
              <span className="flex-1" />
              <button
                type="button"
                onClick={() => startEdit(r)}
                className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
              >
                Edit
              </button>
              {!r.isSystem && (confirmRetire === r.id ? (
                <button
                  type="button"
                  onClick={() => run(async () => { await settingsAPI.deactivateTicketStatus(r.id); setConfirmRetire(null); })}
                  className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded bg-red-600 text-white font-semibold"
                >
                  <Archive className="w-3 h-3" aria-hidden="true" /> Confirm retire
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setConfirmRetire(r.id)}
                  aria-label={`Retire status ${r.name}`}
                  className="tp-focus-ring text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-400 hover:text-red-500 hover:border-red-200"
                >
                  Retire
                </button>
              ))}
            </div>
            {confirmRetire === r.id && (
              <p className="mt-1 ml-8 text-[11px] text-slate-400">Tickets keep this label; it can&apos;t be chosen for new status changes. You can reactivate it later.</p>
            )}
          </li>
        ))}
        {loaded && active.length === 0 && (
          <li className="text-xs text-slate-400 italic list-none">No statuses configured.</li>
        )}
      </ul>

      {inactive.length > 0 && (
        <div className="mb-2">
          <p className="text-[10px] uppercase tracking-wide font-semibold text-slate-300 mb-1">Retired</p>
          <ul className="space-y-1" aria-label="Retired statuses">
            {inactive.map((r) => (
              <li key={r.id} className="flex items-center gap-2 rounded-lg border border-slate-100 px-2.5 py-1 text-xs opacity-60">
                <span aria-hidden="true" className={`w-2.5 h-2.5 rounded-full shrink-0 ${STATUS_DOT_CLASSES[r.color] || 'bg-slate-300'}`} />
                <span className="text-slate-500 line-through">{r.name}</span>
                <BaseChip base={r.baseStatus} />
                <span className="flex-1" />
                <button
                  type="button"
                  onClick={() => run(() => settingsAPI.reactivateTicketStatus(r.id))}
                  className="tp-focus-ring inline-flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded border border-slate-200 text-slate-500 hover:bg-slate-50"
                >
                  <RotateCcw className="w-3 h-3" aria-hidden="true" /> Reactivate
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {error && <p className="text-xs text-red-500 mb-1.5" role="alert">{error}</p>}

      {draft ? (
        <div className="rounded-lg border border-slate-200 p-2.5 space-y-2 text-xs">
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={draft.name}
              onChange={(e) => setDraft({ ...draft, name: e.target.value.slice(0, 50) })}
              placeholder="Status name (e.g. Waiting on vendor)"
              aria-label="Status name"
              className="tp-focus-ring w-56 border border-slate-200 rounded-md px-2 py-1"
            />
            <label className="flex items-center gap-1.5 text-slate-500">
              Behaves like
              <select
                value={draft.baseStatus}
                onChange={(e) => { setDraft({ ...draft, baseStatus: e.target.value }); setBaseChangeArmed(false); }}
                disabled={Boolean(editingRow?.isSystem)}
                aria-label="Base status"
                title={editingRow?.isSystem ? 'System statuses keep their base behavior' : undefined}
                className="tp-focus-ring border border-slate-200 rounded-md px-1.5 py-1 disabled:bg-slate-50 disabled:text-slate-400"
              >
                {BASE_STATUSES.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </label>
            <ColorPicker idPrefix={editingRow ? `edit-${editingRow.id}` : 'new'} value={draft.color} onChange={(c) => setDraft({ ...draft, color: c })} />
          </div>
          {baseChanged && baseChangeArmed && (
            <p className="text-[11px] text-amber-600" role="alert">
              Changing the base status changes how tickets with this status behave (SLA clocks, terminal logic). Click Save again to confirm.
            </p>
          )}
          <div className="flex gap-1.5">
            <button
              type="button"
              onClick={save}
              disabled={busy || !draft.name.trim()}
              className="tp-focus-ring px-2.5 py-1 rounded-md bg-blue-600 text-white font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin inline" aria-hidden="true" /> : (editingRow ? 'Save' : 'Add status')}
            </button>
            <button type="button" onClick={cancelForm} className="tp-focus-ring px-2.5 py-1 rounded-md text-slate-500 hover:bg-slate-50">Cancel</button>
            {editingRow && draft.name.trim() && draft.name.trim() !== editingRow.name && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-400">
                <Check className="w-3 h-3" aria-hidden="true" /> Existing tickets with &ldquo;{editingRow.name}&rdquo; will be relabeled
              </span>
            )}
          </div>
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setDraft({ name: '', baseStatus: 'Pending', color: 'violet' })}
          className="tp-focus-ring inline-flex items-center gap-1 text-xs font-medium text-blue-600 hover:text-blue-700"
        >
          <Plus className="w-3.5 h-3.5" aria-hidden="true" /> New status
        </button>
      )}
    </section>
  );
}
