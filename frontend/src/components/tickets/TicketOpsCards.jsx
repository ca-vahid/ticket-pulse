import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, Link2, Loader2, Wand2, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Enterprise ticket ops, kept compact for the detail sidebar:
 *  - TicketLinksCard: explicit relationships (duplicate_of / related_to /
 *    parent_of) + "mark as duplicate" which also resolves TP-born sources.
 *  - CustomFieldsCard: per-workspace user-defined fields (JSON UDF).
 *  - MacroMenu: one-click quick-action bundles.
 */

const KIND_LABEL = {
  duplicate_of: 'duplicate of',
  related_to: 'related to',
  parent_of: 'parent of',
  merged_into: 'merged into',
};

export function TicketLinksCard({ ticketId, canWrite = false, canMerge = false, onNavigate, onMerged, refreshToken = null }) {
  const [links, setLinks] = useState([]);
  const [adding, setAdding] = useState(false);
  const [targetId, setTargetId] = useState('');
  const [kind, setKind] = useState('related_to');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notifyRequester, setNotifyRequester] = useState(false);

  // Likely-duplicate suggestions for the duplicate/merge pickers (gap plan 2
  // P5.2): same-subject matches + high embedding similarity, fetched lazily
  // the first time the add form opens.
  const [suggestions, setSuggestions] = useState(null);
  useEffect(() => {
    if (!adding || suggestions !== null) return;
    ticketsAPI.related(ticketId)
      .then((res) => {
        const d = res?.data || {};
        const seen = new Set();
        setSuggestions([
          ...(d.nearDuplicates || []).map((t) => ({ ...t, why: 'same subject' })),
          ...(d.similarByContent || [])
            .filter((t) => (t.similarity || 0) >= 0.7)
            .map((t) => ({ ...t, why: `${Math.round(t.similarity * 100)}% similar` })),
        ].filter((t) => (seen.has(t.id) ? false : seen.add(t.id))).slice(0, 3));
      })
      .catch(() => setSuggestions([]));
  }, [adding, suggestions, ticketId]);

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.links(ticketId);
      setLinks(res?.data || []);
    } catch { setLinks([]); }
  }, [ticketId]);
  useEffect(() => { load(); }, [load, refreshToken]);

  const add = async () => {
    // Accepts what people see: TP-1042, #231164, or a bare number — the
    // backend resolves it workspace-scoped (QA 07-07 #6).
    const ref = targetId.trim();
    if (!ref || busy) return;
    setBusy(true); setError(null);
    try {
      if (kind === 'merge_into') {
        await ticketsAPI.mergeTicket(ticketId, ref, notifyRequester);
        onMerged?.();
      } else if (kind === 'duplicate_of') await ticketsAPI.markDuplicateOf(ticketId, ref);
      else await ticketsAPI.addLink(ticketId, ref, kind);
      setTargetId(''); setAdding(false);
      await load();
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Link failed');
    }
    setBusy(false);
  };

  const remove = async (linkId) => {
    try { await ticketsAPI.removeLink(ticketId, linkId); await load(); } catch { /* refresh shows truth */ }
  };

  if (links.length === 0 && !canWrite) return null;

  return (
    <div className="tp-card rounded-xl p-3" data-testid="ticket-links-card">
      <div className="flex items-center gap-1.5 mb-2">
        <Link2 className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Linked tickets</span>
        {canWrite && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="tp-focus-ring ml-auto text-[11px] font-medium text-blue-600 hover:text-blue-700 px-1.5 py-0.5 rounded"
          >
            {adding ? 'Cancel' : '+ Link'}
          </button>
        )}
      </div>
      {links.length === 0 && <p className="text-xs text-slate-400 italic">No linked tickets.</p>}
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={`${link.direction}-${link.id}`} className="group flex items-center gap-1.5 text-xs">
            <span className="text-slate-400 flex-shrink-0">{link.direction === 'in' ? (link.label || link.kind) : (KIND_LABEL[link.kind] || link.kind)}</span>
            <button
              onClick={() => onNavigate?.(link.other.id)}
              className="tp-focus-ring font-mono font-semibold text-blue-600 hover:underline truncate"
              title={link.other.subject}
            >
              {link.other.displayRef}
            </button>
            <span className="text-slate-500 truncate flex-1">{link.other.subject}</span>
            {canWrite && (
              <button
                onClick={() => remove(link.id)}
                aria-label="Remove link"
                className="tp-focus-ring opacity-0 group-hover:opacity-100 p-0.5 rounded text-slate-300 hover:text-red-500"
              >
                <X className="w-3 h-3" aria-hidden="true" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {adding && (
        <div className="mt-2 space-y-1.5">
          <div className="flex items-center gap-1.5">
            <select
              value={kind}
              onChange={(e) => setKind(e.target.value)}
              aria-label="Link kind"
              className="tp-focus-ring text-xs border border-slate-200 rounded-md px-1.5 py-1 bg-white"
            >
              <option value="related_to">related to</option>
              <option value="duplicate_of">duplicate of</option>
              <option value="parent_of">parent of</option>
              {canMerge && <option value="merge_into">merge into…</option>}
            </select>
            <input
              value={targetId}
              onChange={(e) => setTargetId(e.target.value)}
              placeholder="TP-1042 or 231164"
              aria-label="Ticket reference"
              className="tp-focus-ring flex-1 min-w-0 text-xs border border-slate-200 rounded-md px-2 py-1"
            />
            <button
              onClick={add}
              disabled={busy}
              className="tp-focus-ring px-2 py-1 rounded-md bg-blue-600 text-white text-xs font-semibold hover:bg-blue-700 disabled:opacity-60"
            >
              {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : 'Add'}
            </button>
          </div>
          {['duplicate_of', 'merge_into'].includes(kind) && suggestions?.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <span className="text-[10px] text-slate-400">Likely:</span>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setTargetId(s.displayRef)}
                  title={`${s.subject || '(no subject)'} — ${s.why}`}
                  className={`tp-focus-ring inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono font-semibold ${
                    s.displayRef === targetId
                      ? 'bg-violet-100 border-violet-300 text-violet-800'
                      : 'bg-violet-50 border-violet-200 text-violet-700 hover:bg-violet-100'
                  }`}
                >
                  {s.displayRef}
                  <span className="font-sans font-normal text-violet-500">{s.why}</span>
                </button>
              ))}
            </div>
          )}
          {kind === 'duplicate_of' && (
            <p className="text-[10px] text-amber-600">Marks this ticket as the duplicate and resolves it (TP-born) with an audit note.</p>
          )}
          {kind === 'merge_into' && (
            <>
              <p className="text-[10px] text-amber-600">
                Copies this ticket&apos;s conversation onto the target, carries its tags over, and closes this ticket (TP-born) with an audit trail. Attachments stay here, referenced from the target.
              </p>
              <label className="flex items-center gap-1.5 text-[11px] text-slate-600">
                <input
                  type="checkbox"
                  checked={notifyRequester}
                  onChange={(e) => setNotifyRequester(e.target.checked)}
                  className="tp-focus-ring rounded border-slate-300 text-blue-600"
                />
                Email the requester that their ticket was consolidated (TP-born only)
              </label>
            </>
          )}
          {error && <p className="text-[10px] text-red-500">{error}</p>}
        </div>
      )}
    </div>
  );
}

export function CustomFieldsCard({ ticketId, values = {}, canWrite = false, onSaved }) {
  const [definitions, setDefinitions] = useState(null);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    ticketsAPI.customFieldDefinitions()
      .then((res) => setDefinitions(res?.data || []))
      .catch(() => setDefinitions([]));
  }, []);
  useEffect(() => { setDraft(values || {}); setDirty(false); }, [values]);

  if (!definitions || definitions.length === 0) return null;

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      await ticketsAPI.setCustomFields(ticketId, draft);
      setDirty(false);
      onSaved?.();
    } catch (e) {
      setError(e.response?.data?.message || e.message || 'Save failed');
    }
    setBusy(false);
  };

  const input = (definition) => {
    const value = draft[definition.key] ?? '';
    const set = (v) => { setDraft((d) => ({ ...d, [definition.key]: v })); setDirty(true); };
    const base = 'tp-focus-ring w-full text-xs border border-slate-200 rounded-md px-2 py-1 bg-white disabled:bg-slate-50 disabled:text-slate-500';
    if (definition.type === 'select') {
      return (
        <select value={value} onChange={(e) => set(e.target.value)} disabled={!canWrite} className={base} aria-label={definition.label}>
          <option value="">—</option>
          {definition.options.map((opt) => <option key={opt} value={opt}>{opt}</option>)}
        </select>
      );
    }
    if (definition.type === 'boolean') {
      return (
        <select value={String(value)} onChange={(e) => set(e.target.value === 'true')} disabled={!canWrite} className={base} aria-label={definition.label}>
          <option value="">—</option>
          <option value="true">Yes</option>
          <option value="false">No</option>
        </select>
      );
    }
    return (
      <input
        type={definition.type === 'number' ? 'number' : definition.type === 'date' ? 'date' : 'text'}
        value={definition.type === 'date' && value ? String(value).slice(0, 10) : value}
        onChange={(e) => set(e.target.value)}
        disabled={!canWrite}
        aria-label={definition.label}
        className={base}
      />
    );
  };

  return (
    <div className="tp-card rounded-xl p-3" data-testid="custom-fields-card">
      <div className="flex items-center gap-1.5 mb-2">
        <Copy className="w-3.5 h-3.5 text-slate-400" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Custom fields</span>
        {dirty && canWrite && (
          <button
            onClick={save}
            disabled={busy}
            className="tp-focus-ring ml-auto inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-600 text-white text-[11px] font-semibold hover:bg-blue-700 disabled:opacity-60"
          >
            {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Check className="w-3 h-3" aria-hidden="true" />} Save
          </button>
        )}
      </div>
      <div className="space-y-1.5">
        {definitions.map((definition) => (
          <label key={definition.key} className="block">
            <span className="block text-[10px] text-slate-400 mb-0.5">{definition.label}</span>
            {input(definition)}
          </label>
        ))}
      </div>
      {error && <p className="mt-1 text-[10px] text-red-500">{error}</p>}
    </div>
  );
}

// Time tracking was retired on request (QA 07-07 #7).

export function MacroMenu({ ticketId, onApplied, disabled = false }) {
  const [open, setOpen] = useState(false);
  const [macros, setMacros] = useState(null);
  const [applying, setApplying] = useState(null);

  useEffect(() => {
    if (!open || macros) return;
    ticketsAPI.macros().then((res) => setMacros(res?.data || [])).catch(() => setMacros([]));
  }, [open, macros]);

  const apply = async (macro) => {
    setApplying(macro.id);
    try {
      const res = await ticketsAPI.applyMacro(ticketId, macro.id);
      setOpen(false);
      onApplied?.(res?.data);
    } catch { /* refresh shows truth */ }
    setApplying(null);
  };

  return (
    <span className="relative inline-flex">
      <button
        onClick={() => setOpen((v) => !v)}
        disabled={disabled}
        className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-slate-200 bg-white text-xs font-medium text-slate-600 hover:border-violet-300 hover:text-violet-700 disabled:opacity-50"
      >
        <Wand2 className="w-3.5 h-3.5" aria-hidden="true" /> Macros
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-72 tp-card rounded-xl shadow-soft p-1.5">
          {macros === null && <p className="px-2 py-2 text-xs text-slate-400">Loading…</p>}
          {macros?.length === 0 && <p className="px-2 py-2 text-xs text-slate-400">No macros yet — admins create them in Settings.</p>}
          {(macros || []).map((macro) => (
            <button
              key={macro.id}
              onClick={() => apply(macro)}
              disabled={applying !== null}
              className="tp-focus-ring w-full rounded-lg px-2 py-1.5 text-left hover:bg-violet-50 disabled:opacity-60"
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-slate-700">{macro.name}</span>
                {applying === macro.id && <Loader2 className="w-3 h-3 animate-spin text-violet-500" aria-hidden="true" />}
              </span>
              {macro.description && <span className="block text-[10px] text-slate-400 truncate">{macro.description}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
