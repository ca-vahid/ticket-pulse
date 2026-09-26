import { useEffect, useMemo, useState } from 'react';
import { Check, ChevronDown, Laptop, Loader2, Search, UserRound, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Assetron laptop picker (Assetron guide Part B, 24 Sep 2026).
 *
 *  - Filters come from Assetron's filter-options — never hard-coded; unknown
 *    keys render as generic multi-selects (their rule B5).
 *  - Search runs on the button, not per filter change (B6).
 *  - New laptops only for now (Vahid): status is fixed server-side.
 *  - One laptop per request.
 *
 * Props: recipient {email,name}, onRecipient(r), value (asset|null), onChange(asset|null).
 */
const LABELS = {
  make: 'Make', model: 'Model', location: 'Location', cpu: 'CPU', gpu: 'GPU', ram: 'RAM', storage: 'Storage', screenSize: 'Screen', touchScreen: 'Touch screen',
};
const ORDER = ['location', 'make', 'model', 'ram', 'storage', 'cpu', 'gpu', 'screenSize', 'touchScreen'];

const fmtValue = (v) => (v === true ? 'Yes' : v === false ? 'No' : String(v));
const label = (k) => LABELS[k] || k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase());

export function assetTitle(a) {
  if (!a) return '';
  return [a.make, a.model].filter(Boolean).join(' ') || 'Laptop';
}
export function assetSpec(a) {
  if (!a) return '';
  return [a.cpu, a.ram, a.storage, a.screenSize, a.gpu].filter(Boolean).join(' · ');
}

function FilterSelect({ id, name, values, selected, onChange }) {
  const [open, setOpen] = useState(false);
  const count = selected.length;
  return (
    <div className="relative">
      <button
        type="button" id={id} onClick={() => setOpen(!open)} aria-expanded={open}
        className={`tp-focus-ring inline-flex items-center gap-1 rounded-lg border px-2.5 py-1.5 text-xs ${count ? 'border-primary/50 text-foreground bg-primary/5' : 'border-input text-muted-foreground bg-card'} hover:bg-muted/50`}
      >
        {label(name)}{count ? <span className="font-semibold text-primary"> · {count}</span> : null}
        <ChevronDown className="w-3 h-3" aria-hidden="true" />
      </button>
      {open && (
        <div className="absolute z-20 mt-1 max-h-60 w-60 overflow-auto rounded-lg border border-border bg-card p-1.5 shadow-soft animate-fadeIn" role="group" aria-label={label(name)}>
          {values.map((v) => {
            const key = fmtValue(v);
            const on = selected.some((s) => fmtValue(s) === key);
            return (
              <label key={key} className="flex cursor-pointer items-center gap-2 rounded px-2 py-1 text-xs text-foreground/85 hover:bg-muted/50">
                <input
                  type="checkbox" checked={on}
                  onChange={() => onChange(on ? selected.filter((s) => fmtValue(s) !== key) : [...selected, v])}
                  className="tp-focus-ring h-3.5 w-3.5 rounded border-input text-blue-600 dark:text-blue-300"
                />
                {key}
              </label>
            );
          })}
          <button type="button" onClick={() => setOpen(false)} className="tp-focus-ring mt-1 w-full rounded px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted/50">Done</button>
        </div>
      )}
    </div>
  );
}

function RecipientField({ recipient, onRecipient }) {
  const [editing, setEditing] = useState(false);
  const [q, setQ] = useState('');
  const [results, setResults] = useState([]);
  useEffect(() => {
    if (!editing || q.trim().length < 2) { setResults([]); return undefined; }
    let alive = true;
    const t = setTimeout(() => {
      ticketsAPI.requesterSearch(q.trim()).then((res) => {
        if (!alive) return;
        const d = res?.data || {};
        const seen = new Set();
        const list = [...(d.requesters || []), ...(d.directory || [])].filter((p) => {
          const e = String(p.email || '').toLowerCase();
          if (!e || seen.has(e)) return false;
          seen.add(e); return true;
        }).slice(0, 8);
        setResults(list);
      }).catch(() => { if (alive) setResults([]); });
    }, 250);
    return () => { alive = false; clearTimeout(t); };
  }, [q, editing]);

  return (
    <div>
      <p className="mb-1 text-[11px] font-medium text-muted-foreground">For</p>
      {!editing ? (
        <div className="flex items-center gap-2 text-sm">
          <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          {recipient?.email ? (
            <span className="text-foreground"><span className="font-medium">{recipient.name || recipient.email}</span>{recipient.name ? <span className="text-muted-foreground"> · {recipient.email}</span> : null}</span>
          ) : <span className="text-muted-foreground">Nobody picked yet</span>}
          <button type="button" onClick={() => { setEditing(true); setQ(''); }} className="tp-focus-ring ml-1 text-xs font-medium text-primary hover:underline">Change</button>
        </div>
      ) : (
        <div className="relative">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or e-mail…" aria-label="Who is the laptop for"
            className="tp-focus-ring w-full rounded-lg border border-input bg-card px-2.5 py-1.5 text-sm"
          />
          <button type="button" onClick={() => setEditing(false)} aria-label="Stop changing" className="tp-focus-ring absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground"><X className="h-3.5 w-3.5" aria-hidden="true" /></button>
          {results.length > 0 && (
            <ul className="absolute z-20 mt-1 w-full rounded-lg border border-border bg-card p-1 shadow-soft" role="listbox" aria-label="People">
              {results.map((p) => (
                <li key={p.email}>
                  <button
                    type="button"
                    onClick={() => { onRecipient({ email: String(p.email).toLowerCase(), name: p.name || p.displayName || null }); setEditing(false); }}
                    className="tp-focus-ring w-full rounded px-2 py-1.5 text-left text-sm hover:bg-muted/50"
                  >
                    <span className="font-medium text-foreground">{p.name || p.displayName || p.email}</span>
                    <span className="text-muted-foreground"> · {p.email}{p.entraOfficeLocation || p.officeLocation ? ` · ${p.entraOfficeLocation || p.officeLocation}` : ''}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

/** "2029-05-02" → "May 2029" (warranty end; the day adds nothing when picking). */
export function warrantyLabel(d) {
  const m = /^(\d{4})-(\d{2})/.exec(String(d || ''));
  if (!m) return d || '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}

export default function LaptopPicker({ recipient, onRecipient, value, onChange }) {
  const [status, setStatus] = useState({ loading: true, configured: false, error: null });
  const [options, setOptions] = useState({});
  const [filters, setFilters] = useState({});
  const [results, setResults] = useState(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await ticketsAPI.assetronStatus();
        if (!alive) return;
        if (!s?.data?.configured) { setStatus({ loading: false, configured: false, error: null }); return; }
        const o = await ticketsAPI.assetronFilterOptions();
        if (!alive) return;
        setOptions(o?.data || {});
        setStatus({ loading: false, configured: true, error: null });
      } catch (err) {
        if (alive) setStatus({ loading: false, configured: true, error: err?.response?.data?.message || err.message || 'Assetron did not answer' });
      }
    })();
    return () => { alive = false; };
  }, []);

  const keys = useMemo(() => {
    const all = Object.keys(options).filter((k) => Array.isArray(options[k]) && options[k].length > 0);
    return [...ORDER.filter((k) => all.includes(k)), ...all.filter((k) => !ORDER.includes(k)).sort()];
  }, [options]);

  const search = async () => {
    setSearching(true); setError(null);
    try {
      // Raw values (true/false, "32 GB") — Assetron matches its canonical values exactly.
      const params = Object.fromEntries(Object.entries(filters).filter(([, v]) => v.length).map(([k, v]) => [k, v.map((x) => String(x)).join(',')]));
      const res = await ticketsAPI.assetronAssets({ ...params, pageSize: 50 });
      setResults(res?.data?.items || []);
    } catch (err) {
      setError(err?.response?.data?.message || err.message || 'Assetron did not answer');
    } finally { setSearching(false); }
  };

  if (status.loading) return <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Connecting to Assetron…</p>;
  if (!status.configured) return <p className="text-xs text-muted-foreground">Assetron is not connected yet, so a laptop can’t be reserved from here. The approval can still be requested.</p>;
  if (status.error) return <p role="alert" className="text-xs text-red-700 dark:text-red-200">Assetron: {status.error}</p>;

  return (
    <div className="space-y-3" data-testid="laptop-picker">
      <RecipientField recipient={recipient} onRecipient={onRecipient} />

      {value ? (
        <div className="flex items-start gap-2 rounded-lg border border-primary/40 bg-primary/5 px-3 py-2">
          <Laptop className="mt-0.5 h-4 w-4 text-primary" aria-hidden="true" />
          <div className="min-w-0 flex-1 text-sm">
            <p className="font-medium text-foreground">{assetTitle(value)}{value.serialNumber ? <span className="font-normal text-muted-foreground"> · S/N {value.serialNumber}</span> : null}</p>
            <p className="text-xs text-muted-foreground">{assetSpec(value)}{value.location ? ` · ${value.location}` : ''}</p>
          </div>
          <button type="button" onClick={() => onChange(null)} className="tp-focus-ring text-xs font-medium text-primary hover:underline">Pick another</button>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {keys.map((k) => (
              <FilterSelect key={k} id={`laptop-filter-${k}`} name={k} values={options[k]} selected={filters[k] || []} onChange={(v) => setFilters({ ...filters, [k]: v })} />
            ))}
            <button type="button" onClick={search} disabled={searching} className="tp-focus-ring inline-flex items-center gap-1 rounded-lg bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-blue-700 disabled:opacity-60">
              {searching ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Search className="h-3.5 w-3.5" aria-hidden="true" />} Search new laptops
            </button>
          </div>
          {error && <p role="alert" className="text-xs text-red-700 dark:text-red-200">Assetron: {error}</p>}
          {results && results.length === 0 && <p className="text-xs text-muted-foreground">No new laptop matches these filters — loosen one and search again.</p>}
          {results && results.length > 0 && (
            <div className="max-h-64 overflow-auto rounded-lg border border-border">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-muted/80 text-left text-[11px] text-muted-foreground">
                  <tr><th className="px-2 py-1.5 font-medium">Laptop</th><th className="px-2 py-1.5 font-medium">Spec</th><th className="px-2 py-1.5 font-medium">Location</th><th className="px-2 py-1.5 font-medium">Warranty</th><th className="px-2 py-1.5"><span className="sr-only">Pick</span></th></tr>
                </thead>
                <tbody>
                  {results.map((a) => (
                    <tr key={a.id} className="border-t border-border/60 hover:bg-muted/40">
                      <td className="px-2 py-1.5"><span className="whitespace-nowrap font-medium text-foreground">{assetTitle(a)}</span><br /><span className="whitespace-nowrap text-muted-foreground">{a.assetTag || (a.serialNumber ? `S/N ${a.serialNumber}` : '')}</span></td>
                      <td className="px-2 py-1.5 text-foreground/85">{assetSpec(a)}{a.touchScreen ? ' · touch' : ''}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 text-foreground/85">{a.location || '—'}</td>
                      <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground" title={a.warrantyEndDate || undefined}>{warrantyLabel(a.warrantyEndDate)}</td>
                      <td className="px-2 py-1.5 text-right">
                        <button type="button" onClick={() => onChange(a)} className="tp-focus-ring inline-flex items-center gap-1 rounded border border-border px-2 py-0.5 font-medium text-primary hover:bg-primary/5">
                          <Check className="h-3 w-3" aria-hidden="true" /> Pick
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
