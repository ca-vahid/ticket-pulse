import { useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowRight, Info, Loader2, Mail, MinusCircle, Wand2 } from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { APPLY_CHUNK, PREVIEW_CHUNK, chunk, mergeBulkSummaries, summaryLines, ticketsLabel as tickets } from './bulkMacroSummary';

/**
 * One macro on a bulk-bar selection (QA 11-09 #9). Lives inside the bulk bar,
 * in place of the pickers (not a window.confirm): it asks the server what the
 * macro will do on each selected ticket, says it in a few plain lines ("on 3
 * the close is skipped — Security needs a reason"), and on Apply runs it
 * ticket by ticket. The server does the real work with the single-ticket
 * preview/apply, so every rule of the ticket page's Macros menu holds here.
 */

const unwrap = (res) => res?.data?.data ?? res?.data ?? res;
const errText = (e, fallback) => e?.response?.data?.message || e?.message || fallback;

const TONE_ICON = {
  run: { Icon: ArrowRight, cls: 'text-primary' },
  skip: { Icon: MinusCircle, cls: 'text-muted-foreground' },
  notice: { Icon: Info, cls: 'text-amber-600 dark:text-amber-300' },
  error: { Icon: AlertCircle, cls: 'text-red-600 dark:text-red-300' },
  mail: { Icon: Mail, cls: 'text-muted-foreground' },
};

export default function BulkMacroPanel({ macro, ticketIds, onCancel, onDone }) {
  const [summary, setSummary] = useState(null);
  const [refs, setRefs] = useState({}); // ticketId → ref, from the preview
  // Only tickets the macro will do something on are applied (no empty
  // "applied macro: nothing to change" rows on the rest).
  const [runIds, setRunIds] = useState([]);
  const [error, setError] = useState(null);
  const [progress, setProgress] = useState(null); // { done, total } while applying
  const applyRef = useRef(null);
  const applying = Boolean(progress);
  // The selection as it was when the macro was picked: what was previewed is what runs.
  const [ids] = useState(() => [...new Set(ticketIds)]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const parts = [];
        const map = {};
        const runnable = [];
        for (const part of chunk(ids, PREVIEW_CHUNK)) {
          const data = unwrap(await ticketsAPI.previewMacroBulk(macro.id, part));
          parts.push(data?.summary);
          for (const t of data?.tickets || []) {
            if (t.ref) map[t.ticketId] = t.ref;
            if (t.ok && (t.steps || []).some((s) => s.run)) runnable.push(t.ticketId);
          }
        }
        if (!cancelled) { setRefs(map); setRunIds(runnable); setSummary(mergeBulkSummaries(parts)); }
      } catch (e) {
        if (!cancelled) setError(errText(e, 'Could not check what this macro will do'));
      }
    })();
    return () => { cancelled = true; };
  }, [ids, macro.id]);
  useEffect(() => { if (summary) applyRef.current?.focus(); }, [summary]);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !applying) onCancel?.(); };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onCancel, applying]);

  const apply = async () => {
    setError(null);
    setProgress({ done: 0, total: runIds.length });
    const results = [];
    for (const part of chunk(runIds, APPLY_CHUNK)) {
      try {
        const data = unwrap(await ticketsAPI.applyMacroBulk(macro.id, part));
        results.push(...(data?.results || []));
      } catch (e) {
        // The whole call failed (network, timeout): we cannot tell what ran on these.
        const message = errText(e, 'The request failed — open the ticket to check');
        results.push(...part.map((ticketId) => ({ ticketId, ok: false, error: message })));
      }
      setProgress({ done: results.length, total: runIds.length });
    }
    const failed = results.filter((r) => !r.ok).map((r) => ({
      id: r.ticketId,
      ref: r.ref || refs[r.ticketId] || `ticket ${r.ticketId}`,
      message: r.error || 'failed',
    }));
    const applied = results.length - failed.length;
    onDone?.({
      kind: 'macro',
      macroName: macro.name,
      ok: applied,
      total: results.length,
      failed,
      failedIds: failed.map((f) => f.id),
      leftAlone: ids.length - runIds.length,
      skipped: 0,
      label: `macro “${macro.name}”`,
    });
  };

  const lines = summaryLines(summary);
  const canApply = Boolean(summary) && runIds.length > 0 && !applying;

  return (
    <div role="group" aria-labelledby="bulk-macro-title" data-testid="bulk-macro-panel" className="w-[min(36rem,90vw)] px-4 py-3">
      <p id="bulk-macro-title" className="flex items-center gap-2 text-sm font-semibold text-foreground">
        <Wand2 className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <span className="min-w-0">Apply “{macro.name}” to {tickets(ids.length)}?</span>
      </p>
      <div aria-live="polite" className="mt-2 max-h-48 overflow-y-auto settings-scrollbar">
        {!summary && !error && (
          <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
            <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> Checking what it will do on each ticket…
          </p>
        )}
        {lines.length > 0 && (
          <ul className="space-y-1" data-testid="bulk-macro-summary">
            {lines.map((l) => {
              const { Icon, cls } = TONE_ICON[l.tone];
              return (
                <li key={l.text} className="flex items-start gap-2 text-[13px] leading-snug text-foreground/85">
                  <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${cls}`} aria-hidden="true" />
                  <span className="min-w-0">{l.text}</span>
                </li>
              );
            })}
          </ul>
        )}
        {error && <p role="alert" className="text-[13px] text-red-600 dark:text-red-300">{error}</p>}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          ref={applyRef}
          type="button"
          onClick={apply}
          disabled={!canApply}
          data-testid="bulk-macro-apply"
          className="tp-focus-ring inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          {applying ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
          {applying ? `Applying… ${progress.done} of ${progress.total}` : `Apply to ${tickets(summary ? runIds.length : ids.length)}`}
        </button>
        <button
          type="button"
          onClick={onCancel}
          disabled={applying}
          className="tp-focus-ring rounded-lg px-3 py-1.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        >
          Cancel
        </button>
        {applying && <span className="text-xs text-muted-foreground">One ticket at a time — keep this page open.</span>}
      </div>
    </div>
  );
}
