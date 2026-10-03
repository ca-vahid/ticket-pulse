import { useCallback, useEffect, useMemo, useState } from 'react';
import { Loader2, Upload } from 'lucide-react';
import FancySelect from '../../common/FancySelect';
import { PersonAvatar } from '../../tickets/ticketUi';
import { availabilityAPI } from '../../../services/api';
import { BTN_LINK, BTN_PRIMARY, BTN_QUIET, ErrorNote, Field, INPUT, SectionTitle, TEXTAREA, trimNum } from '../availabilityUi';
import { TD, TH } from './adminUi';

/**
 * Balances per person per balance-tracked type for a leave year, with an
 * Adjust form (days ± and a reason) and a CSV paste for opening balances.
 */

function AdjustForm({ person, type, year, onDone, onCancel }) {
  const [days, setDays] = useState('');
  const [note, setNote] = useState('');
  const [kind, setKind] = useState('adjustment');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async () => {
    const n = Number(days);
    if (!n) { setError('Enter the days to add (negative to take away)'); return; }
    if (!note.trim()) { setError('Add a reason'); return; }
    setBusy(true);
    setError(null);
    try {
      await availabilityAPI.adjustBalance({ email: person.email, leaveTypeId: type.leaveTypeId, year, days: n, note: note.trim(), kind });
      onDone(`${person.name || person.email}: ${n > 0 ? '+' : ''}${trimNum(n)} ${type.name}`);
    } catch (err) {
      setError(err?.message || 'Could not adjust');
      setBusy(false);
    }
  };
  return (
    <div className="mt-2 grid gap-2 rounded-md border border-border bg-muted/40 p-3 sm:grid-cols-[6rem_9rem_minmax(0,1fr)_auto] sm:items-end">
      <Field label="Days"><input type="number" step="0.5" className={INPUT} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Adjustment days" autoFocus /></Field>
      <Field label="Kind">
        <FancySelect value={kind} onChange={setKind} options={[{ value: 'adjustment', label: 'Adjustment' }, { value: 'carryover', label: 'Carry-over' }]} aria-label="Adjustment kind" />
      </Field>
      <Field label="Reason"><input className={INPUT} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Adjustment reason" /></Field>
      <span className="flex gap-1">
        <button type="button" className={BTN_QUIET} onClick={onCancel} disabled={busy}>Cancel</button>
        <button type="button" className={BTN_PRIMARY} onClick={submit} disabled={busy}>{busy && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Save</button>
      </span>
      {error && <p className="text-xs text-red-700 dark:text-red-300 sm:col-span-4" role="alert">{error}</p>}
    </div>
  );
}

export default function BalancesSection({ config, toast }) {
  const thisYear = new Date().getFullYear();
  const [year, setYear] = useState(thisYear);
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [adjusting, setAdjusting] = useState(null); // `${email}|${leaveTypeId}`
  const [csvOpen, setCsvOpen] = useState(false);
  const [csv, setCsv] = useState('');
  const [importing, setImporting] = useState(false);
  const [importResult, setImportResult] = useState(null);

  const load = useCallback(() => {
    setRows(null);
    availabilityAPI.balances({ year })
      .then((res) => { setRows(Array.isArray(res?.data) ? res.data : []); setError(null); })
      .catch((err) => { setRows([]); setError(err?.message || 'Could not load balances'); });
  }, [year]);
  useEffect(() => { load(); }, [load]);

  const trackedTypes = useMemo(() => (config.leaveTypes || []).filter((t) => t.tracksBalance), [config.leaveTypes]);

  const importCsv = async () => {
    setImporting(true);
    setImportResult(null);
    try {
      const res = await availabilityAPI.importBalances({ csv, year });
      setImportResult(res?.data || null);
      toast(`${res?.data?.written ?? 0} opening balances written`);
      load();
    } catch (err) {
      setImportResult({ error: err?.message || 'Import failed' });
    } finally {
      setImporting(false);
    }
  };

  return (
    <section aria-label="Balances">
      <SectionTitle
        hint={trackedTypes.length ? `Tracked: ${trackedTypes.map((t) => t.name).join(', ')}.` : 'No leave type tracks a balance yet.'}
        action={(
          <span className="flex items-center gap-2">
            <FancySelect value={String(year)} onChange={(v) => setYear(Number(v))} options={[thisYear - 1, thisYear, thisYear + 1].map((y) => ({ value: String(y), label: String(y) }))} aria-label="Leave year" className="w-24" />
            <button type="button" className={BTN_LINK} onClick={() => setCsvOpen((o) => !o)} aria-expanded={csvOpen}><Upload className="h-4 w-4" aria-hidden="true" />Import opening balances</button>
          </span>
        )}
      >
        Balances
      </SectionTitle>

      {csvOpen && (
        <div className="mb-4 space-y-2 border-b border-border pb-4">
          <Field label="Paste CSV" hint="Columns: Email, Leave type, Remaining (a Vacation Tracker export works). Each balance is set to the Remaining value for this leave year.">
            <textarea rows={5} className={`${TEXTAREA} font-mono text-xs`} value={csv} onChange={(e) => setCsv(e.target.value)} placeholder={'Email,Leave type,Remaining\njane.doe@company.com,Vacation,12.5'} aria-label="Opening balances CSV" />
          </Field>
          <div className="flex items-center gap-3">
            <button type="button" className={BTN_PRIMARY} onClick={importCsv} disabled={importing || !csv.trim()}>{importing && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}Import for {year}</button>
            {importResult && !importResult.error && <span className="text-sm text-foreground/85" role="status">{importResult.written} written for {importResult.year}{importResult.problems?.length ? ` · ${importResult.problems.length} skipped` : ''}</span>}
          </div>
          {importResult?.error && <ErrorNote>{importResult.error}</ErrorNote>}
          {importResult?.problems?.length > 0 && (
            <ul className="max-h-40 overflow-y-auto text-xs text-amber-700 dark:text-amber-300">
              {importResult.problems.map((p) => <li key={p}>{p}</li>)}
            </ul>
          )}
        </div>
      )}

      <ErrorNote>{error}</ErrorNote>
      {rows === null ? (
        <p className="flex items-center gap-2 py-4 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading balances…</p>
      ) : !rows.length ? (
        <p className="py-4 text-sm text-muted-foreground">No balances for {year}.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[42rem] text-sm">
            <thead><tr><th className={TH}>Person</th><th className={TH}>Type</th><th className={`${TH} text-right`}>Entitled</th><th className={`${TH} text-right`}>Adjusted</th><th className={`${TH} text-right`}>Taken</th><th className={`${TH} text-right`}>Booked</th><th className={`${TH} text-right`}>Pending</th><th className={`${TH} text-right`}>Left</th><th className={TH}><span className="sr-only">Adjust</span></th></tr></thead>
            <tbody className="divide-y divide-border">
              {rows.flatMap((person) => (person.balances || []).map((b, i) => {
                const key = `${person.email}|${b.leaveTypeId}`;
                return (
                  <tr key={key}>
                    <td className={TD}>
                      {i === 0 && (
                        <span className="flex items-center gap-2">
                          <PersonAvatar name={person.name || person.email} size="h-6 w-6" />
                          <span className="truncate text-foreground">{person.name || person.email}</span>
                        </span>
                      )}
                    </td>
                    <td className={TD}>
                      <span className="text-foreground/85">{b.name}</span>
                      {adjusting === key && <AdjustForm person={person} type={b} year={year} onCancel={() => setAdjusting(null)} onDone={(msg) => { setAdjusting(null); toast(msg); load(); }} />}
                    </td>
                    <td className={`${TD} text-right tabular-nums text-foreground/85`}>{trimNum(b.entitled)}</td>
                    <td className={`${TD} text-right tabular-nums text-foreground/85`}>{Number(b.adjustments) ? `${Number(b.adjustments) > 0 ? '+' : ''}${trimNum(b.adjustments)}` : '—'}</td>
                    <td className={`${TD} text-right tabular-nums text-foreground/85`}>{trimNum(b.taken)}</td>
                    <td className={`${TD} text-right tabular-nums text-foreground/85`}>{trimNum(b.scheduled)}</td>
                    <td className={`${TD} text-right tabular-nums text-foreground/85`}>{trimNum(b.pending)}</td>
                    <td className={`${TD} text-right font-medium tabular-nums ${Number(b.remaining) < 0 ? 'text-red-600 dark:text-red-300' : 'text-foreground'}`}>{trimNum(b.remaining)}</td>
                    <td className={`${TD} text-right`}>
                      {adjusting !== key && <button type="button" className={BTN_QUIET} onClick={() => setAdjusting(key)} aria-label={`Adjust ${person.name || person.email} ${b.name}`}>Adjust</button>}
                    </td>
                  </tr>
                );
              }))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
