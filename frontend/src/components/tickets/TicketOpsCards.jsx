import { useCallback, useEffect, useState } from 'react';
import { Check, ChevronDown, Copy, ExternalLink, Link2, Loader2, Pencil, Wand2, X } from 'lucide-react';
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
        <Link2 className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">Linked tickets</span>
        {canWrite && (
          <button
            onClick={() => setAdding((v) => !v)}
            className="tp-focus-ring ml-auto text-[11px] font-medium text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 px-1.5 py-0.5 rounded"
          >
            {adding ? 'Cancel' : '+ Link'}
          </button>
        )}
      </div>
      {links.length === 0 && <p className="text-xs text-muted-foreground/75 italic">No linked tickets.</p>}
      <ul className="space-y-1">
        {links.map((link) => (
          <li key={`${link.direction}-${link.id}`} className="group flex items-center gap-1.5 text-xs">
            <span className="text-muted-foreground/75 flex-shrink-0">{link.direction === 'in' ? (link.label || link.kind) : (KIND_LABEL[link.kind] || link.kind)}</span>
            <button
              onClick={() => onNavigate?.(link.other.id)}
              className="tp-focus-ring font-mono font-semibold text-blue-600 dark:text-blue-300 hover:underline truncate"
              title={link.other.subject}
            >
              {link.other.displayRef}
            </button>
            <span className="text-muted-foreground truncate flex-1">{link.other.subject}</span>
            {canWrite && (
              <button
                onClick={() => remove(link.id)}
                aria-label="Remove link"
                className="tp-focus-ring opacity-0 group-hover:opacity-100 p-0.5 rounded text-muted-foreground/50 hover:text-red-500"
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
              className="tp-focus-ring text-xs border border-border rounded-md px-1.5 py-1 bg-card"
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
              className="tp-focus-ring flex-1 min-w-0 text-xs border border-border rounded-md px-2 py-1 bg-card"
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
              <span className="text-[10px] text-muted-foreground/75">Likely:</span>
              {suggestions.map((s) => (
                <button
                  key={s.id}
                  onClick={() => setTargetId(s.displayRef)}
                  title={`${s.subject || '(no subject)'} — ${s.why}`}
                  className={`tp-focus-ring inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md border text-[10px] font-mono font-semibold ${
                    s.displayRef === targetId
                      ? 'bg-violet-100 dark:bg-violet-500/20 border-violet-300 dark:border-violet-500/40 text-violet-800 dark:text-violet-200'
                      : 'bg-violet-50 dark:bg-violet-500/15 border-violet-200 dark:border-violet-500/30 text-violet-700 dark:text-violet-200 hover:bg-violet-100 dark:hover:bg-violet-500/20'
                  }`}
                >
                  {s.displayRef}
                  <span className="font-sans font-normal text-violet-500">{s.why}</span>
                </button>
              ))}
            </div>
          )}
          {kind === 'duplicate_of' && (
            <p className="text-[10px] text-amber-600 dark:text-amber-300">Marks this ticket as the duplicate and resolves it (TP-born) with an audit note.</p>
          )}
          {kind === 'merge_into' && (
            <>
              <p className="text-[10px] text-amber-600 dark:text-amber-300">
                Copies this ticket&apos;s conversation onto the target, carries its tags over, and closes this ticket (TP-born) with an audit trail. Attachments stay here, referenced from the target.
              </p>
              <label className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
                <input
                  type="checkbox"
                  checked={notifyRequester}
                  onChange={(e) => setNotifyRequester(e.target.checked)}
                  className="tp-focus-ring rounded border-input text-blue-600 dark:text-blue-300"
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

/** Is this stored custom-field value a web link? (QA's SharePoint/PowerApp links.) */
const isUrlValue = (v) => typeof v === 'string' && /^https?:\/\/\S+$/i.test(v.trim());

/** 'share_point_item_link' → 'Share Point Item Link' (labels for orphaned keys). */
const prettifyKey = (key) => String(key).split('_').filter(Boolean)
  .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');

function UrlValueLink({ href, label }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      title={href}
      className="tp-focus-ring inline-flex min-w-0 shrink items-center gap-1 text-xs text-blue-600 dark:text-blue-300 hover:text-blue-700 dark:hover:text-blue-200 hover:underline"
      aria-label={`${label} (opens in a new tab)`}
    >
      <span className="truncate">{href.replace(/^https?:\/\//i, '')}</span>
      <ExternalLink className="w-3 h-3 flex-shrink-0" aria-hidden="true" />
    </a>
  );
}

export function CustomFieldsCard({ ticketId, values = {}, canWrite = false, onSaved }) {
  const [definitions, setDefinitions] = useState(null);
  const [draft, setDraft] = useState({});
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  // URL-valued text fields render as links; a per-key toggle switches one back
  // to a plain input for editing.
  const [editingKeys, setEditingKeys] = useState(() => new Set());

  useEffect(() => {
    ticketsAPI.customFieldDefinitions()
      .then((res) => setDefinitions(res?.data || []))
      .catch(() => setDefinitions([]));
  }, []);
  useEffect(() => { setDraft(values || {}); setDirty(false); setEditingKeys(new Set()); }, [values]);

  // Keys with a stored value but no ACTIVE definition (retired or deleted in
  // Settings). Values are never dropped, so keep showing them — read-only.
  const definedKeys = new Set((definitions || []).map((d) => d.key));
  const orphanKeys = Object.keys(values || {})
    .filter((k) => !definedKeys.has(k) && values[k] !== null && values[k] !== undefined && values[k] !== '');

  if (!definitions || (definitions.length === 0 && orphanKeys.length === 0)) return null;

  const save = async () => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      // Send only defined keys — orphaned values are read-only (the backend
      // rejects keys without a definition).
      const payload = Object.fromEntries(Object.entries(draft).filter(([k]) => definedKeys.has(k)));
      await ticketsAPI.setCustomFields(ticketId, payload);
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
    const base = 'tp-focus-ring w-full text-xs border border-border rounded-md px-2 py-1 bg-card disabled:bg-muted/50 disabled:text-muted-foreground';
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
    // Link values display as clickable links (SharePoint / Power App refs);
    // the pencil swaps in the plain input for edits.
    if (isUrlValue(value) && !editingKeys.has(definition.key)) {
      return (
        <span className="flex w-full items-center gap-1 min-w-0">
          <UrlValueLink href={String(value).trim()} label={definition.label} />
          {canWrite && (
            <button
              type="button"
              onClick={() => setEditingKeys((prev) => new Set(prev).add(definition.key))}
              aria-label={`Edit ${definition.label}`}
              className="tp-focus-ring p-0.5 rounded text-muted-foreground/50 hover:text-muted-foreground flex-shrink-0"
            >
              <Pencil className="w-3 h-3" aria-hidden="true" />
            </button>
          )}
        </span>
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
    <div className="tp-card rounded-xl p-3 overflow-hidden" data-testid="custom-fields-card">
      <div className="flex items-center gap-1.5 mb-2">
        <Copy className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
        <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/75">Custom fields</span>
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
            <span className="block text-[10px] text-muted-foreground/75 mb-0.5">{definition.label}</span>
            {input(definition)}
          </label>
        ))}
        {orphanKeys.map((key) => {
          const value = values[key];
          return (
            <div key={key} className="block">
              <span className="block text-[10px] text-muted-foreground/75 mb-0.5">{prettifyKey(key)}</span>
              {isUrlValue(value) ? (
                <UrlValueLink href={String(value).trim()} label={prettifyKey(key)} />
              ) : (
                <span
                  className="inline-flex max-w-full items-center rounded-md bg-muted/50 border border-border px-2 py-1 text-xs text-muted-foreground"
                  title="This field's definition was retired — the value is kept read-only"
                >
                  <span className="truncate">{String(value)}</span>
                </span>
              )}
              <span className="block text-[9px] text-muted-foreground/50 mt-0.5 italic" title="This field's definition was retired — the value is kept read-only">definition retired</span>
            </div>
          );
        })}
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
        className="tp-focus-ring inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border border-border bg-card text-xs font-medium text-muted-foreground hover:border-violet-300 dark:hover:border-violet-500/40 hover:text-violet-700 dark:hover:text-violet-200 disabled:opacity-50"
      >
        <Wand2 className="w-3.5 h-3.5" aria-hidden="true" /> Macros
        <ChevronDown className={`w-3 h-3 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute right-0 top-full z-40 mt-1 w-72 tp-card rounded-xl shadow-soft p-1.5">
          {macros === null && <p className="px-2 py-2 text-xs text-muted-foreground/75">Loading…</p>}
          {macros?.length === 0 && <p className="px-2 py-2 text-xs text-muted-foreground/75">No macros yet — admins create them in Settings.</p>}
          {(macros || []).map((macro) => (
            <button
              key={macro.id}
              onClick={() => apply(macro)}
              disabled={applying !== null}
              className="tp-focus-ring w-full rounded-lg px-2 py-1.5 text-left hover:bg-violet-50 dark:hover:bg-violet-500/15 disabled:opacity-60"
            >
              <span className="flex items-center gap-2">
                <span className="text-xs font-semibold text-foreground/85">{macro.name}</span>
                {applying === macro.id && <Loader2 className="w-3 h-3 animate-spin text-violet-500" aria-hidden="true" />}
              </span>
              {macro.description && <span className="block text-[10px] text-muted-foreground/75 truncate">{macro.description}</span>}
            </button>
          ))}
        </div>
      )}
    </span>
  );
}
