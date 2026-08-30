import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AlertCircle, GitMerge, Loader2, Search, Sparkles, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { StatusPill, formatDay } from './ticketUi';
import { baseStatusOf, isTerminalStatus } from './statusDefs';
// Survivor rules shared with the detail header's Merge button (Phase MB1/MB2).
import { mergeSurvivorBlockedReason } from './mergeRules';

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
export default function MergeTicketsModal({ ticket, onClose, onMerged, statusDefs = null }) {
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

  // Sources may be TP- or FS-born and in ANY status except Deleted/Spam —
  // exactly the service's source rule (Phase MB2; was Open/Pending only,
  // compared on raw labels so custom Pending-base statuses were invisible).
  // Only the surviving primary must be a TP-born Open/Pending ticket.
  const isMergeable = (t) => t.id !== ticket.id && !['Deleted', 'Spam'].includes(t.status)
    && !['Deleted', 'Spam'].includes(baseStatusOf(statusDefs, t.status));
  const isFsBorn = (t) => t.origin !== 'ticketpulse';
  const isTerminal = (t) => isTerminalStatus(statusDefs, t.status);

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
          // No status filter: the service accepts any non-Deleted/Spam source.
          const res = await ticketsAPI.list({ requesterId: ticket.requester.id, pageSize: 10 });
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
        const res = await ticketsAPI.list({ q, pageSize: 8 });
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
  const primaryBlocked = primary ? mergeSurvivorBlockedReason(primary, statusDefs) : null;
  const canMerge = group.length >= 2 && !!primary && !primaryBlocked;

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
      <li key={t.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-muted/50">
        <input
          type="checkbox"
          checked={checked}
          onChange={() => toggle(t)}
          aria-label={`Include ${refOf(t)} in the merge`}
          className="tp-focus-ring h-4 w-4 rounded border-input"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-foreground/85">{t.subject || '(no subject)'}</span>
          <span className="block text-xs text-muted-foreground/75">
            {refOf(t)}
            {t.createdAt ? ` · ${formatDay(t.createdAt)}` : ''}
            {why && <span className="ml-1 inline-flex items-center gap-0.5 text-violet-500"><Sparkles className="h-3 w-3" aria-hidden="true" />{why}</span>}
            {isTerminal(t) && (
              <span className="ml-1 text-muted-foreground/75" data-testid="merge-terminal-note">· {baseStatusOf(statusDefs, t.status) === 'Resolved' ? 'Resolved' : 'Closed'} — will be folded in as-is</span>
            )}
          </span>
        </span>
        {isFsBorn(t) && (
          <span className="inline-flex items-center rounded-full border border-emerald-200 dark:border-emerald-500/30 bg-emerald-50 dark:bg-emerald-500/15 px-1.5 py-0.5 text-[10px] font-semibold text-emerald-700 dark:text-emerald-200" title="FreshService-born — can be folded in; it will be closed in FreshService with a pointer note">
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
      <div ref={dialogRef} tabIndex={-1} className="tp-focus-ring flex max-h-[85vh] w-full max-w-2xl flex-col rounded-2xl bg-card shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center gap-2.5 border-b border-border/60 px-5 py-3.5">
          <span className="inline-flex h-8 w-8 items-center justify-center rounded-full bg-violet-100 dark:bg-violet-500/20">
            <GitMerge className="h-4 w-4 text-violet-600 dark:text-violet-300" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-sm font-bold text-foreground">Merge tickets</h3>
            <p className="text-xs text-muted-foreground/75">Fold duplicate or related tickets into one — conversations are copied in, the rest are closed.</p>
          </div>
          <button onClick={onClose} disabled={busy} aria-label="Close" className="tp-focus-ring rounded p-1 text-muted-foreground/75 hover:text-muted-foreground">
            <X className="h-4 w-4" aria-hidden="true" />
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-5 py-4 settings-scrollbar">
          {/* Candidates */}
          <div>
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Suggested (open tickets from {ticket.requester?.name || 'this requester'} + look-alikes)</p>
            <div className="rounded-xl border border-border">
              {candidates === null ? (
                <p className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground/75"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> Finding candidates…</p>
              ) : candidates.length === 0 ? (
                <p className="px-3 py-3 text-sm italic text-muted-foreground/75">No obvious candidates — search below.</p>
              ) : (
                <ul className="divide-y divide-border/60">{candidates.map((t) => row(t, t.why))}</ul>
              )}
            </div>
          </div>

          {/* Search */}
          <div>
            <div className="relative">
              <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground/75" aria-hidden="true" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Add another ticket — TP-1042 or subject…"
                aria-label="Search tickets to merge"
                className="tp-focus-ring w-full rounded-lg border border-border bg-card py-2 pl-8 pr-3 text-sm"
              />
              {searching && <Loader2 className="absolute right-2.5 top-1/2 h-4 w-4 -translate-y-1/2 animate-spin text-muted-foreground/75" aria-hidden="true" />}
            </div>
            {searchResults.length > 0 && (
              <ul className="mt-1 divide-y divide-border/60 rounded-xl border border-border">{searchResults.map((t) => row(t))}</ul>
            )}
          </div>

          {/* Selection + primary choice */}
          {group.length >= 2 && (
            <div>
              <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wide text-muted-foreground/75">Which ticket survives? ({group.length} in this merge)</p>
              <ul className="divide-y divide-border/60 rounded-xl border border-violet-200 dark:border-violet-500/30 bg-violet-50/40 dark:bg-violet-500/10">
                {group.map((t) => (
                  <li key={t.id} className="flex items-center gap-2.5 px-3 py-2">
                    <input
                      type="radio"
                      name="merge-primary"
                      checked={primaryId === t.id}
                      onChange={() => setPrimaryId(t.id)}
                      disabled={Boolean(mergeSurvivorBlockedReason(t, statusDefs))}
                      title={mergeSurvivorBlockedReason(t, statusDefs) || undefined}
                      aria-label={`Keep ${refOf(t)} as the primary`}
                      className="tp-focus-ring h-4 w-4 disabled:opacity-40"
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium text-foreground/85">{t.subject || '(no subject)'}</span>
                      <span className="block text-xs text-muted-foreground/75">
                        {refOf(t)}
                        {primaryId === t.id
                          ? ' · stays open, receives every conversation'
                          : isTerminal(t)
                            ? ' · already closed — folded in as-is with a pointer note'
                            : isFsBorn(t)
                              ? ' · will be closed in FreshService with a pointer note'
                              : ' · will be closed with a pointer note'}
                      </span>
                    </span>
                  </li>
                ))}
              </ul>
              <label className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                <input type="checkbox" checked={notifyRequester} onChange={(e) => setNotifyRequester(e.target.checked)} className="tp-focus-ring mt-0.5" />
                Email each merged ticket&apos;s requester that their ticket was consolidated (public reply before closing)
              </label>
            </div>
          )}

          {error && (
            <div className="flex items-start gap-2 rounded-lg border border-red-200 dark:border-red-500/30 bg-red-50 dark:bg-red-500/15 px-3 py-2" role="alert">
              <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-600 dark:text-red-300" aria-hidden="true" />
              <span className="text-xs text-red-700 dark:text-red-200">{error}</span>
            </div>
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t border-border/60 px-5 py-3.5">
          <p className="text-xs text-muted-foreground/75">
            {canMerge
              ? `${secondaries.length} ticket${secondaries.length === 1 ? '' : 's'} → ${refOf(primary || ticket)} · cannot be undone`
              : group.length >= 2 && primaryBlocked
                ? (isFsBorn(primary) ? 'Pick a Ticket Pulse ticket as the survivor' : 'Pick an Open or Pending ticket as the survivor')
                : 'Select at least one other ticket'}
          </p>
          <div className="flex gap-2">
            <button onClick={onClose} disabled={busy} className="tp-focus-ring rounded-lg border border-border bg-card px-3.5 py-2 text-xs font-semibold text-muted-foreground hover:bg-muted/50">
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
