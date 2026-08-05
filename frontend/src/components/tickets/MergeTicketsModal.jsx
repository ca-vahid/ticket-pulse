import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, GitMerge, Loader2, Search, Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { StatusPill, formatDay } from './ticketUi';

// List rows carry displayRef from the server; the detail ticket may not.
const refOf = (t) => t?.displayRef
  || (t?.origin === 'ticketpulse' && t?.nativeNumber ? `TP-${t.nativeNumber}` : null)
  || (t?.freshserviceTicketId ? `#${t.freshserviceTicketId}` : `#${t?.id}`);

/**
 * Multi-merge dialog (QA 07-13 #1). Pick any number of tickets to fold into
 * one primary: candidates are pre-suggested (same requester's open tickets +
 * near-duplicates by subject/content), the oldest ticket is pre-selected as
 * primary, and the consequences are spelled out before the one-click merge.
 * The SURVIVOR must be TP-born (its conversation is TP-owned); FS-born
 * tickets can be folded IN as sources — their conversation is copied and the
 * FreshService ticket is closed with a pointer note (QA 07-16 #5).
 */
export default function MergeTicketsModal({ ticket, onClose, onMerged }) {
  const [candidates, setCandidates] = useState(null); // [{...ticket, why}]
  const [query, setQuery] = useState('');
  const [searching, setSearching] = useState(false);
  const [searchResults, setSearchResults] = useState([]);
  const [selected, setSelected] = useState(() => new Map([[ticket.id, ticket]]));
  const [primaryId, setPrimaryId] = useState(ticket.id);
  const [notifyRequester, setNotifyRequester] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const dialogRef = useRef(null);

  // Escape closes the dialog and focus moves into it on open — matches every
  // sibling modal's keyboard bar.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
  }, [busy, onClose]);

  // Sources may be TP- or FS-born; only the surviving primary must be TP-born.
  const isMergeable = (t) => ['Open', 'Pending'].includes(t.status) && t.id !== ticket.id;
  const isFsBorn = (t) => t.origin !== 'ticketpulse';

  // Pre-suggestions: near-duplicates (same subject / similar content) plus the
  // requester's other open TP-born tickets. Suggested rows come pre-checked
  // when they look like a burst (same subject).
  useEffect(() => {
    let alive = true;
    (async () => {
      const seen = new Set([ticket.id]);
      const out = [];
      try {
        const rel = (await ticketsAPI.related(ticket.id))?.data || {};
        for (const t of rel.nearDuplicates || []) {
          if (isMergeable(t) && !seen.has(t.id)) { seen.add(t.id); out.push({ ...t, why: 'same subject', preselect: true }); }
        }
        for (const t of rel.similarByContent || []) {
          if ((t.similarity || 0) >= 0.7 && isMergeable(t) && !seen.has(t.id)) {
            seen.add(t.id); out.push({ ...t, why: `${Math.round(t.similarity * 100)}% similar` });
          }
        }
      } catch { /* suggestions are best-effort */ }
      try {
        if (ticket.requester?.id) {
          const res = await ticketsAPI.list({ requesterId: ticket.requester.id, status: 'Open,Pending', pageSize: 10 });
          for (const t of res?.data?.items || []) {
            if (isMergeable(t) && !seen.has(t.id)) { seen.add(t.id); out.push({ ...t, why: 'same requester' }); }
          }
        }
      } catch { /* ditto */ }
      if (!alive) return;
      setCandidates(out.slice(0, 12));
      // Burst-looking twins start checked — the common case arrives solved.
      setSelected((prev) => {
        const next = new Map(prev);
        for (const t of out) if (t.preselect) next.set(t.id, t);
        return next;
      });
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ticket.id]);

  // Manual search for anything the suggestions missed (ref or subject).
  useEffect(() => {
    const q = query.trim();
    if (q.length < 2) { setSearchResults([]); return undefined; }
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await ticketsAPI.list({ q, status: 'Open,Pending', pageSize: 8 });
        setSearchResults((res?.data?.items || []).filter((t) => isMergeable(t)));
      } catch { setSearchResults([]); }
      setSearching(false);
    }, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query]);

  const toggle = (t) => {
    setSelected((prev) => {
      const next = new Map(prev);
      if (next.has(t.id)) {
        next.delete(t.id);
        if (primaryId === t.id) setPrimaryId(ticket.id);
      } else next.set(t.id, t);
      return next;
    });
  };

  const group = useMemo(() => [...selected.values()].sort((a, b) => new Date(a.createdAt || 0) - new Date(b.createdAt || 0)), [selected]);
  const secondaries = group.filter((t) => t.id !== primaryId);
  const primary = group.find((t) => t.id === primaryId);
  const canMerge = group.length >= 2 && !!primary && !isFsBorn(primary);

  const doMerge = useCallback(async () => {
    setBusy(true); setError(null);
    try {
      const res = await ticketsAPI.mergeMany(primaryId, secondaries.map((t) => t.id), notifyRequester);
      const data = res?.data || {};
      if (data.failed?.length) {
        setError(`${data.merged?.length || 0} merged, ${data.failed.length} failed: ${data.failed.map((f) => `${f.ref} (${f.error})`).join('; ')}`);
        setBusy(false);
        return;
      }
      onMerged?.(data);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setBusy(false);
    }
  }, [primaryId, secondaries, notifyRequester, onMerged]);

  const row = (t, why = null) => {
    const checked = selected.has(t.id);
    return (
      <li key={t.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(t)}
          aria-label={`Include ${refOf(t)} in the merge`}
          className="tp-focus-ring h-4 w-4 rounded border-slate-300"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-slate-700">{t.subject || '(no subject)'}</span>
          <span className="block text-xs text-slate-400">
            {refOf(t)}
            {t.createdAt ? ` · ${formatDay(t.createdAt)}` : ''}
            {why && <span className="ml-1 inline-flex items-center gap-0.5 text-violet-500"><Sparkles className="h-3 w-3" aria-hidden="true" />{why}</span>}
          </span>
        </span>
        {isFsBorn(t) && (
          <span className="inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700" title="FreshService-born — can be folded in; it will be closed in FreshService with a pointer note">
            FreshService
          </span>
        )}
        <StatusPill status={t.status} />
      </li>
    );
  };

  return (
    <div
      className="fixed inset-0 z-[200] flex items-center justify-center bg-slate-900/40 p-4 backdrop-blur-[2px]"
      role="dialog"
      aria-modal="true"
      aria-label="Merge tickets"
      onClick={busy ? undefined : onClose}
    >
      <div ref={dialogRef} tabIndex={-1} className="tp-focus-ring flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-white shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-slate-100 px-5 py-3.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-violet-100">
            <GitMerge className="h-4 w-4 text-violet-600" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-slate-900">Merge tickets</h3>
            <p className="text-xs text-slate-400">Fold duplicate or related tickets into one — conversations are copied in, the rest are closed.</p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="tp-focus-ring rounded p-1 text-slate-400 hover:text-slate-600">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 settings-scrollbar">
          {/* Candidates */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Suggested (open tickets from {ticket.requester?.name || 'this requester'} + look-alikes)</p>
            <div className="rounded-xl border border-slate-200">
              {candidates === null ? (
                <p className="flex items-center gap-2 px-3 py-3 text-sm text-slate-400"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Finding candidates…</p>
              ) : candidates.length === 0 ? (
                <p className="px-3 py-3 text-sm italic text-slate-400">No obvious candidates — search below.</p>
              ) : (
                <ul className="divide-y divide-slate-100">{candidates.map((t) => row(t, t.why))}</ul>
              )}
            </div>
          </div>

          {/* Search */}
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Add another ticket — TP-1042 or subject…"
                aria-label="Search tickets to merge"
                className="tp-focus-ring w-full rounded-lg border border-slate-200 py-2 pl-8 pr-3 text-sm"
              />
              {searching && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-slate-400" aria-hidden="true" />}
            </div>
            {searchResults.length > 0 && (
              <ul className="mt-1 divide-y divide-slate-100 rounded-xl border border-slate-200">{searchResults.map((t) => row(t))}</ul>
            )}
          </div>

          {/* Selection + primary choice */}
          {group.length >= 2 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-slate-400">Which ticket survives? ({group.length} in this merge)</p>
              <ul className="divide-y divide-slate-100 rounded-xl border border-violet-200 bg-violet-50/40">
                {group.map((t) => (
                  <li key={t.id} className="flex items-center gap-2.5 px-3 py-2">
                    <input
                      type="radio"
                      name="merge-primary"
                      checked={primaryId === t.id}
                      onChange={() => setPrimaryId(t.id)}
                      disabled={isFsBorn(t)}
                      title={isFsBorn(t) ? 'FreshService owns this ticket’s conversation — it can be folded in, but the survivor must be a Ticket Pulse ticket' : undefined}
                      aria-label={`Keep ${refOf(t)} as the primary`}
                      className="tp-focus-ring h-4 w-4 disabled:opacity-40"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-slate-700">{t.subject || '(no subject)'}</span>
                      <span className="block text-xs text-slate-400">
                        {refOf(t)}
                        {primaryId === t.id
                          ? ' · stays open, receives every conversation'
                          : isFsBorn(t)
                            ? ' · will be closed in FreshService with a pointer note'
                            : ' · will be closed with a pointer note'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-start gap-2 text-xs text-slate-500">
                <input type="checkbox" checked={notifyRequester} onChange={(e) => setNotifyRequester(e.target.checked)} className="tp-focus-ring mt-0.5" />
                Email each merged ticket&apos;s requester that their ticket was consolidated (public reply before closing)
              </label>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600" aria-hidden="true" />
              <span className="text-xs text-red-700">{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-slate-100 px-5 py-3.5">
          <p className="text-xs text-slate-400">
            {canMerge
              ? `${secondaries.length} ticket${secondaries.length === 1 ? '' : 's'} → ${refOf(primary || ticket)} · cannot be undone`
              : group.length >= 2 && primary && isFsBorn(primary)
                ? 'Pick a Ticket Pulse ticket as the survivor'
                : 'Select at least one other ticket'}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="tp-focus-ring rounded-lg border border-slate-200 bg-white px-3.5 py-2 text-xs font-semibold text-slate-600 hover:bg-slate-50">
              Cancel
            </button>
            <button
              onClick={doMerge}
              disabled={!canMerge || busy}
              className="tp-focus-ring flex items-center gap-1.5 rounded-lg bg-violet-600 px-3.5 py-2 text-xs font-semibold text-white hover:bg-violet-700 disabled:opacity-50"
            >
              {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <GitMerge className="h-3.5 w-3.5" aria-hidden="true" />}
              {busy ? 'Merging…' : 'Merge tickets'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
