import { useState } from 'react';
import { Loader2 } from 'lucide-react';
import { availabilityAPI } from '../../../services/api';
import { BTN_PRIMARY, BTN_QUIET, ErrorNote, Field, INPUT, SectionTitle, addDaysKey, todayKey } from '../availabilityUi';

/**
 * Import from Vacation Tracker (the leaves Ticket Pulse already syncs for a
 * workspace) and rebuild the calendar entries the dashboards read.
 */
export default function ImportSection({ toast }) {
  const [workspaceId, setWorkspaceId] = useState(1);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(addDaysKey(todayKey(), 365));
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [rebuilt, setRebuilt] = useState(null);
  const [error, setError] = useState(null);

  const runImport = async () => {
    setBusy('import');
    setError(null);
    setResult(null);
    try {
      const res = await availabilityAPI.importVacationTracker({ workspaceId: Number(workspaceId) || 1, from, to });
      setResult(res?.data || {});
      toast(`${res?.data?.created ?? 0} requests imported`);
    } catch (err) {
      setError(err?.message || 'Import failed');
    } finally {
      setBusy(null);
    }
  };

  const reproject = async () => {
    setBusy('reproject');
    setError(null);
    try {
      const res = await availabilityAPI.reproject({});
      setRebuilt(res?.data || {});
      toast('Calendar entries rebuilt');
    } catch (err) {
      setError(err?.message || 'Rebuild failed');
    } finally {
      setBusy(null);
    }
  };

  const unmatched = result?.unmatched;
  const unmatchedList = Array.isArray(unmatched) ? unmatched : [];
  const unmatchedCount = Array.isArray(unmatched) ? unmatched.length : Number(unmatched || 0);

  return (
    <div className="space-y-6">
      <section aria-label="Import from Vacation Tracker">
        <SectionTitle hint="Reads approved leaves from Vacation Tracker (using that workspace's Vacation Tracker key) and adds them as approved requests, matched by e-mail. Already-imported leaves are skipped, so it is safe to run again.">
          Import from Vacation Tracker
        </SectionTitle>
        <div className="grid max-w-2xl gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end">
          <Field label="Workspace id"><input type="number" min={1} className={INPUT} value={workspaceId} onChange={(e) => setWorkspaceId(e.target.value)} aria-label="Workspace id" /></Field>
          <Field label="From"><input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="Import from" /></Field>
          <Field label="To"><input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-label="Import to" /></Field>
          <button type="button" className={BTN_PRIMARY} onClick={runImport} disabled={Boolean(busy) || !from || !to}>
            {busy === 'import' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Import
          </button>
        </div>
        {result && (
          <div className="mt-3 text-sm text-foreground/85" role="status" data-testid="vt-import-result">
            <p>{result.created ?? 0} created · {result.skipped ?? 0} already there · {unmatchedCount} not matched ({result.from || from} to {result.to || to})</p>
            {unmatchedList.length > 0 && (
              <ul className="mt-1 max-h-40 overflow-y-auto text-xs text-amber-700 dark:text-amber-300">
                {unmatchedList.slice(0, 50).map((u, i) => <li key={i}>{typeof u === 'string' ? u : JSON.stringify(u)}</li>)}
              </ul>
            )}
          </div>
        )}
      </section>

      <section aria-label="Rebuild calendar entries" className="border-t border-border pt-5">
        <SectionTitle hint="Re-writes the technician leave entries (what the Dashboard and assignment read) for approved requests ending in the last 30 days or later. Use after an import.">
          Rebuild calendar entries
        </SectionTitle>
        <div className="flex flex-wrap items-center gap-3">
          <button type="button" className={`${BTN_QUIET} border border-border`} onClick={reproject} disabled={Boolean(busy)}>
            {busy === 'reproject' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Rebuild calendar entries
          </button>
          {rebuilt && <span className="text-sm text-foreground/85" role="status">{rebuilt.requests ?? 0} requests · {rebuilt.written ?? 0} entries written</span>}
        </div>
      </section>
      <ErrorNote>{error}</ErrorNote>
    </div>
  );
}
