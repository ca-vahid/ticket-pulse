import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Loader2 } from 'lucide-react';
import { availabilityAPI } from '../../../services/api';
import { BTN_PRIMARY, BTN_QUIET, ErrorNote, Field, INPUT, SectionTitle, addDaysKey, todayKey } from '../availabilityUi';
import { Segmented } from '../teamViews';
import { SharedNote, canEditShared } from './adminUi';

const fmtWhen = (iso) => {
  const d = iso ? new Date(iso) : null;
  if (!d || Number.isNaN(d.getTime())) return null;
  return d.toLocaleString('en-CA', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', timeZone: 'America/Vancouver' });
};

/**
 * QA 11-09 #1: the import also runs by itself every 15 minutes. One line
 * says when it last did, for the workspace in the field.
 */
export function AutoImportLine({ status, workspaceId }) {
  if (!status) return null;
  if (!status.automatic) {
    return <p className="mb-3 text-xs text-muted-foreground" data-testid="vt-auto-import">The automatic import is off on this server. Use Import below.</p>;
  }
  const auto = status.workspaces?.[String(workspaceId)]?.auto || null;
  const when = fmtWhen(auto?.at);
  let text = `Runs by itself every ${status.everyMinutes || 15} minutes. It has not run for this workspace yet.`;
  if (when && auto.ok) {
    const changes = (auto.created || 0) + (auto.updated || 0) + (auto.cancelled || 0);
    text = `Last imported automatically ${when}${changes ? ` (${auto.created || 0} new, ${auto.updated || 0} changed, ${auto.cancelled || 0} cancelled)` : ', nothing new'}. Runs every ${status.everyMinutes || 15} minutes.`;
  } else if (when) {
    text = `The automatic import could not run ${when}: ${auto.error || 'unknown error'}. It tries again every ${status.everyMinutes || 15} minutes.`;
  }
  return <p className={`mb-3 text-xs ${when && !auto.ok ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`} data-testid="vt-auto-import">{text}</p>;
}

const MODE_OPTIONS = [
  { value: 'off', label: 'Off' },
  { value: 'shadow', label: 'Shadow' },
  { value: 'live', label: 'Live' },
];

const SKIP_WORDS = [
  ['skipped_unmatched', 'not matched to a person'],
  ['skipped_review', 'waiting for review'],
  ['skipped_tentative', 'tentative or placeholder'],
  ['skipped_private', 'private'],
  ['skipped_app_booked', 'already booked in Vacation Pulse'],
  ['skipped_cancelled_here', 'cancelled in Vacation Pulse'],
  ['skipped_duplicate', 'duplicates'],
  ['skipped_ignored', 'not time away'],
  ['skipped_other', 'other entries'],
  ['skipped_no_email', 'no e-mail for the person'],
  ['skipped_no_type', 'no matching leave type'],
  ['skipped_bad_dates', 'unreadable dates'],
  ['skipped_bad_event', 'unreadable entries'],
];

/** "12 not matched to a person, 3 private" — only the reasons that happened. */
function skipSummary(counts = {}) {
  return SKIP_WORDS.filter(([k]) => Number(counts[k]) > 0).map(([k, words]) => `${counts[k]} ${words}`).join(', ');
}

function CalendarImportRow({ ws, onMode, saving }) {
  const run = ws.lastRun || null;
  const when = fmtWhen(run?.at);
  const counts = run?.counts || {};
  const shadow = run?.mode === 'shadow';
  const skipped = skipSummary(counts);
  const unmatched = Array.isArray(run?.unmatched) ? run.unmatched : [];
  const tentative = Array.isArray(run?.tentative) ? run.tentative : [];
  let runLine = 'It has not run yet. It runs with the hourly calendar sync.';
  if (when && run.ok === false) runLine = `The last run (${when}) failed: ${run.error || 'unknown error'}.`;
  else if (when) {
    runLine = shadow
      ? `Last run ${when}, in Shadow: it would create ${counts.created || 0}, update ${counts.updated || 0} and cancel ${counts.cancelled || 0}. Nothing was written.`
      : `Last run ${when}: ${counts.created || 0} created, ${counts.updated || 0} updated, ${counts.cancelled || 0} cancelled, ${counts.unchanged || 0} unchanged.`;
  }
  return (
    <div className="py-3" data-testid={`cal-import-${ws.workspaceId}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="min-w-[10rem] text-sm font-medium text-foreground">{ws.name}</span>
        <Segmented label={`Shared calendar import for ${ws.name}`} value={ws.mode || 'off'} onChange={(m) => onMode(ws, m)} options={MODE_OPTIONS} />
        {saving && <Loader2 className="h-4 w-4 animate-spin text-muted-foreground" aria-hidden="true" />}
      </div>
      {!ws.syncEnabled && ws.mode !== 'off' && (
        <p className="mt-1 text-xs text-amber-700 dark:text-amber-300">The hourly calendar sync is off for this workspace, so this does not run.</p>
      )}
      <p className={`mt-1 text-xs ${run?.ok === false ? 'text-amber-700 dark:text-amber-300' : 'text-muted-foreground'}`} data-testid="cal-import-run">{runLine}</p>
      {when && run.ok !== false && skipped && <p className="mt-0.5 text-xs text-muted-foreground" data-testid="cal-import-skipped">Skipped: {skipped}.</p>}
      {run?.guard && <p className="mt-0.5 text-xs text-amber-700 dark:text-amber-300">The calendar listed no entries, so nothing was cancelled.</p>}
      {unmatched.length > 0 && (
        <p className="mt-1 text-xs text-foreground/85" data-testid="cal-import-unmatched">
          Names not matched to anyone: {unmatched.map((u) => (u.events > 1 ? `${u.name} (${u.events})` : u.name)).join(', ')}.{' '}
          <Link to="/settings#calendar-leave" className="tp-focus-ring rounded text-primary underline-offset-2 hover:underline">Map them in Settings → Shared Calendar</Link>
        </p>
      )}
      {tentative.length > 0 && (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="tp-focus-ring w-fit cursor-pointer rounded">Tentative entries left out ({tentative.length})</summary>
          <ul className="mt-1 max-h-40 space-y-0.5 overflow-y-auto pl-3">
            {tentative.map((t, i) => <li key={`${t.date}-${i}`}>{t.date ? `${t.date} · ` : ''}{t.subject || t.name}</li>)}
          </ul>
        </details>
      )}
    </div>
  );
}

/**
 * QA 11-16: Accounting's shared calendar → Vacation Pulse. Per workspace with
 * a calendar set up: Off, Shadow (records what it would do) or Live, and what
 * the last run did. Imported entries can be cancelled here, not changed.
 */
export function SharedCalendarImport({ toast }) {
  const [data, setData] = useState(null);
  const [saving, setSaving] = useState(null);
  const [error, setError] = useState(null);

  const load = useCallback(() => {
    Promise.resolve()
      .then(() => availabilityAPI.calendarImportStatus?.())
      .then((res) => setData(res?.data || { workspaces: [] }))
      .catch((err) => { setData({ workspaces: [] }); setError(err?.message || 'Could not load the shared calendar import'); });
  }, []);
  useEffect(() => { load(); }, [load]);

  const onMode = async (ws, mode) => {
    if (mode === ws.mode) return;
    setSaving(ws.workspaceId);
    setError(null);
    try {
      await availabilityAPI.setCalendarImportMode({ workspaceId: ws.workspaceId, mode });
      setData((d) => ({ ...d, workspaces: (d?.workspaces || []).map((w) => (w.workspaceId === ws.workspaceId ? { ...w, mode } : w)) }));
      toast?.(`Shared calendar import for ${ws.name}: ${MODE_OPTIONS.find((o) => o.value === mode)?.label || mode}`);
    } catch (err) {
      setError(err?.message || 'Could not change it');
    } finally {
      setSaving(null);
    }
  };

  const list = data?.workspaces || [];
  return (
    <section aria-label="Shared calendar" className="border-t border-border pt-5">
      <SectionTitle hint="Adds the entries the hourly shared calendar sync reads as approved requests, matched to people by their alias. Shadow only records what it would do. Imported entries can be cancelled here but not changed; change them in the calendar.">
        Shared calendar
      </SectionTitle>
      {data === null && <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading…</p>}
      {data !== null && !list.length && !error && <p className="text-sm text-muted-foreground">No workspace you administer has a shared calendar set up.</p>}
      {list.length > 0 && (
        <div className="divide-y divide-border">
          {list.map((ws) => <CalendarImportRow key={ws.workspaceId} ws={ws} onMode={onMode} saving={saving === ws.workspaceId} />)}
        </div>
      )}
      <ErrorNote>{error}</ErrorNote>
    </section>
  );
}

/**
 * Import from Vacation Tracker (the leaves Ticket Pulse already syncs for a
 * workspace) and rebuild the calendar entries the dashboards read.
 */
export default function ImportSection({ toast, config = null }) {
  // 26 Nov 2026: once Vacation Tracker is retired there is nothing to import from it.
  const vtRetired = Boolean(config?.settings?.vtRetired);
  const [workspaceId, setWorkspaceId] = useState(1);
  const [from, setFrom] = useState(`${new Date().getFullYear()}-01-01`);
  const [to, setTo] = useState(addDaysKey(todayKey(), 365));
  const [busy, setBusy] = useState(null);
  const [result, setResult] = useState(null);
  const [rebuilt, setRebuilt] = useState(null);
  const [error, setError] = useState(null);
  const [status, setStatus] = useState(null);

  const loadStatus = useCallback(() => {
    Promise.resolve()
      .then(() => availabilityAPI.vtImportStatus?.())
      .then((res) => setStatus(res?.data || null))
      .catch(() => setStatus(null));
  }, []);
  useEffect(() => { if (!vtRetired) loadStatus(); }, [loadStatus, vtRetired]);

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
      loadStatus();
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
      {vtRetired ? (
        <section aria-label="Import from Vacation Tracker" data-testid="vt-import-retired">
          <SectionTitle>Import from Vacation Tracker</SectionTitle>
          <p className="text-sm text-muted-foreground">Vacation Tracker is retired, so nothing is imported from it. Its bookings are in Vacation Pulse now.</p>
        </section>
      ) : (
        <section aria-label="Import from Vacation Tracker">
          <SectionTitle hint="Reads approved leaves from Vacation Tracker (using that workspace's Vacation Tracker key) and adds them as approved requests, matched by e-mail. Already-imported leaves are skipped, so it is safe to run again.">
            Import from Vacation Tracker
          </SectionTitle>
          <AutoImportLine status={status} workspaceId={workspaceId} />
          {/* 26 Nov 2026: the import can add shared leave types, so it is the super admins'. */}
          {!canEditShared(config) && <SharedNote />}
          <div className={`grid max-w-2xl gap-3 sm:grid-cols-[8rem_1fr_1fr_auto] sm:items-end ${canEditShared(config) ? '' : 'hidden'}`}>
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
      )}

      <SharedCalendarImport toast={toast} />

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
