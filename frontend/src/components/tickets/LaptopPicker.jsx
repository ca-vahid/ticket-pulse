import { useEffect, useMemo, useState } from 'react';
import { ArrowDown, ArrowUp, ArrowUpDown, Check, ChevronDown, ChevronLeft, ChevronRight, Loader2, Search, UserRound, X } from 'lucide-react';
import { ticketsAPI } from '../../services/api';

/**
 * Assetron device finder (approval redesign D1 + E1, 29 Sep 2026).
 *
 *  - Loads every NEW device once (GET /tickets/assetron/devices, ≤ 1,000) and
 *    filters in the browser: no call per filter change (Assetron guide B6),
 *    and every filter value shows how many devices it would leave.
 *  - Left: filters built from the devices themselves (office, make, model,
 *    RAM, storage, CPU, GPU, screen) with counts; values that would leave
 *    nothing fade out. Top: search, touch screen, active filters.
 *  - Right: a sortable table with paging (25 / 50 / 100).
 *  - New devices only for now (Vahid); one device per request.
 *
 * Props: recipient {email,name}, onRecipient(r), value (asset|null), onChange(asset|null).
 */
const FACETS = [
  ['location', 'Office'], ['make', 'Make'], ['model', 'Model'], ['ram', 'RAM'], ['storage', 'Storage'],
  ['cpu', 'CPU'], ['gpu', 'GPU'], ['screenSize', 'Screen'],
];
const SIZE_FIELDS = new Set(['ram', 'storage', 'screenSize']);
const FACET_PREVIEW = 6;
const PAGE_SIZES = [25, 50, 100];
const COLUMNS = [
  ['model', 'Device'], ['cpu', 'CPU'], ['ram', 'RAM'], ['storage', 'Storage'], ['gpu', 'GPU'],
  ['screenSize', 'Screen'], ['location', 'Office'], ['warrantyEndDate', 'Warranty'],
];

export function assetTitle(a) {
  if (!a) return '';
  return [a.make, a.model].filter(Boolean).join(' ') || 'Device';
}
export function assetSpec(a) {
  if (!a) return '';
  return [a.cpu, a.ram, a.storage, a.screenSize, a.gpu].filter(Boolean).join(' · ');
}
/** "2029-05-02" → "May 2029" (warranty end; the day adds nothing when picking). */
export function warrantyLabel(d) {
  const m = /^([0-9]{4})-([0-9]{2})/.exec(String(d || ''));
  if (!m) return d || '—';
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 15)).toLocaleDateString('en-CA', { month: 'short', year: 'numeric', timeZone: 'UTC' });
}
/** "64 GB" → 64, "2 TB" → 2048, '16"' → 16 — so sizes sort as sizes. */
function sizeValue(v) {
  const m = /[0-9]+([.][0-9]+)?/.exec(String(v || ''));
  if (!m) return -1;
  return Number(m[0]) * (/TB/i.test(String(v)) ? 1024 : 1);
}
const idOf = (a) => a?.id ?? null;
/**
 * One row per device (8 Oct 2026). Assetron's list is read page by page, and a
 * device can come back on two pages; two rows with the same id left rows from
 * the previous filter in the table (a Dell filter still showing Lenovo rows).
 */
export function uniqueDevices(items) {
  const seen = new Set();
  return (Array.isArray(items) ? items : []).filter((d) => {
    if (!d) return false;
    if (d.id === null || d.id === undefined || d.id === '') return true;
    if (seen.has(d.id)) return false;
    seen.add(d.id);
    return true;
  });
}

export function RecipientField({ recipient, onRecipient }) {
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
    <div className="min-w-0">
      {!editing ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
          <UserRound className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
          <span className="text-muted-foreground">For</span>
          {recipient?.email ? (
            <span className="text-foreground"><span className="font-medium">{recipient.name || recipient.email}</span>{recipient.name ? <span className="text-muted-foreground"> · {recipient.email}</span> : null}</span>
          ) : <span className="text-muted-foreground">nobody picked yet</span>}
          <button type="button" onClick={() => { setEditing(true); setQ(''); }} className="tp-focus-ring text-xs font-medium text-primary hover:underline">Change</button>
        </div>
      ) : (
        <div className="relative max-w-md">
          <input
            autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Type a name or e-mail…" aria-label="Who is the device for"
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

function TouchFilter({ value, onChange, available }) {
  if (!available) return null;
  const opts = [{ v: null, t: 'Any' }, { v: true, t: 'Touch' }, { v: false, t: 'No touch' }];
  return (
    <span className="inline-flex overflow-hidden rounded-lg border border-input text-xs" role="radiogroup" aria-label="Touch screen">
      {opts.map((o) => {
        const on = value === o.v;
        return (
          <button key={o.t} type="button" role="radio" aria-checked={on} onClick={() => onChange(o.v)}
            className={`tp-focus-ring px-2.5 py-1.5 ${on ? 'bg-primary/10 font-semibold text-primary' : 'bg-card text-muted-foreground hover:bg-muted/50'}`}>
            {o.t}
          </button>
        );
      })}
    </span>
  );
}

/**
 * Extra props (multi-device requests, 29 Sep 2026): `hideRecipient` when the
 * step shows the recipient once for every item; `excludeIds` = devices already
 * picked on another item of the same request (hidden here).
 */
export default function LaptopPicker({ recipient, onRecipient, value, onChange, onLoaded, hideRecipient = false, excludeIds = [] }) {
  const [status, setStatus] = useState({ loading: true, configured: false, error: null });
  const [devices, setDevices] = useState([]);
  const [truncated, setTruncated] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState({});
  const [touch, setTouch] = useState(null);
  const [sort, setSort] = useState({ key: 'model', dir: 1 });
  const [page, setPage] = useState(1);
  const [per, setPer] = useState(25);
  const [expanded, setExpanded] = useState({});
  // Which filter sections are open. Unset = the default (see isOpen below).
  const [openFacets, setOpenFacets] = useState({});

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const s = await ticketsAPI.assetronStatus();
        if (!alive) return;
        if (!s?.data?.configured) { setStatus({ loading: false, configured: false, error: null }); return; }
        const r = await ticketsAPI.assetronDevices();
        if (!alive) return;
        const items = uniqueDevices(r?.data?.items);
        setDevices(items);
        setTruncated(Boolean(r?.data?.truncated));
        setStatus({ loading: false, configured: true, error: null });
        onLoaded?.(items.length);
      } catch (err) {
        if (alive) setStatus({ loading: false, configured: true, error: err?.response?.data?.message || err.message || 'Assetron did not answer' });
      }
    })();
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const facets = useMemo(() => FACETS.map(([f, label]) => {
    const values = [...new Set(devices.map((d) => d[f]).filter((v) => v !== null && v !== undefined && v !== ''))];
    values.sort(SIZE_FIELDS.has(f) ? (a, b) => sizeValue(a) - sizeValue(b) : (a, b) => String(a).localeCompare(String(b)));
    return { f, label, values };
  }).filter((x) => x.values.length > 0), [devices]);
  const touchAvailable = useMemo(() => devices.some((d) => d.touchScreen === true) && devices.some((d) => d.touchScreen === false), [devices]);

  const matches = (d, skip = null) => {
    for (const [f] of FACETS) {
      if (f === skip) continue;
      const s = sel[f];
      if (s && s.length && !s.includes(d[f])) return false;
    }
    if (touch !== null && d.touchScreen !== touch) return false;
    if (q.trim()) {
      const hay = [d.make, d.model, d.serialNumber, d.assetTag, d.cpu, d.gpu, d.ram, d.storage, d.location].filter(Boolean).join(' ').toLowerCase();
      if (!q.trim().toLowerCase().split(/ +/).every((w) => hay.includes(w))) return false;
    }
    return true;
  };
  const excluded = useMemo(() => new Set((excludeIds || []).filter(Boolean)), [excludeIds]);
  const pool = useMemo(() => devices.filter((d) => !excluded.has(d.id)), [devices, excluded]);
  const filtered = useMemo(() => pool.filter((d) => matches(d)), // eslint-disable-line react-hooks/exhaustive-deps
    [pool, sel, touch, q]);
  const sorted = useMemo(() => {
    const k = sort.key;
    const val = (d) => (k === 'model' ? assetTitle(d) : SIZE_FIELDS.has(k) ? sizeValue(d[k]) : String(d[k] ?? ''));
    return [...filtered].sort((a, b) => {
      const x = val(a); const y = val(b);
      const c = typeof x === 'number' ? x - y : String(x).localeCompare(String(y));
      return (c || String(a.serialNumber || '').localeCompare(String(b.serialNumber || ''))) * sort.dir;
    });
  }, [filtered, sort]);

  const pages = Math.max(1, Math.ceil(sorted.length / per));
  const safePage = Math.min(page, pages);
  const rows = sorted.slice((safePage - 1) * per, safePage * per);
  const from = sorted.length ? (safePage - 1) * per + 1 : 0;
  const to = Math.min(sorted.length, safePage * per);

  const toggle = (f, v) => {
    setSel((prev) => {
      const cur = new Set(prev[f] || []);
      if (cur.has(v)) cur.delete(v); else cur.add(v);
      return { ...prev, [f]: [...cur] };
    });
    setPage(1);
  };
  const clearAll = () => { setSel({}); setTouch(null); setQ(''); setPage(1); };
  const activeTokens = [];
  for (const { f, label } of facets) for (const v of sel[f] || []) activeTokens.push({ f, v, text: `${label}: ${v}` });
  const sortBy = (key) => { setSort((s) => (s.key === key ? { key, dir: -s.dir } : { key, dir: 1 })); setPage(1); };

  if (status.loading) return <p className="text-xs text-muted-foreground"><Loader2 className="mr-1 inline h-3.5 w-3.5 animate-spin" aria-hidden="true" />Loading new devices from Assetron…</p>;
  if (!status.configured) return <p className="text-xs text-muted-foreground">Assetron is not connected yet, so a device can’t be reserved from here. Choose “Manual entry” instead.</p>;
  if (status.error) return <p role="alert" className="text-xs text-red-700 dark:text-red-200">Assetron: {status.error}</p>;

  const pageButtons = [];
  for (let p = 1; p <= pages; p += 1) {
    if (p === 1 || p === pages || Math.abs(p - safePage) <= 1) pageButtons.push(p);
    else if (pageButtons[pageButtons.length - 1] !== '…') pageButtons.push('…');
  }

  return (
    <div className="space-y-3" data-testid="laptop-picker">
      {!hideRecipient && <RecipientField recipient={recipient} onRecipient={onRecipient} />}

      {devices.length === 0 ? (
        <p className="text-xs text-muted-foreground" data-testid="laptop-no-stock">
          Assetron has no new devices available right now. Choose “Manual entry” to send the request without one, or ask the Assetron team to add stock.
        </p>
      ) : (
        <>
          {value && (
            <div className="flex items-center gap-2.5 rounded-lg border border-primary/50 bg-primary/5 px-3 py-2 text-sm" data-testid="picked-device">
              <Check className="h-4 w-4 flex-shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span className="font-medium text-foreground">{assetTitle(value)}</span>
                <span className="text-muted-foreground">{value.serialNumber ? ` · S/N ${value.serialNumber}` : ''}{value.location ? ` · ${value.location}` : ''}</span>
                {recipient?.name || recipient?.email ? <span className="text-muted-foreground"> will be held for {recipient.name || recipient.email}</span> : null}
              </span>
              <button type="button" onClick={() => onChange(null)} className="tp-focus-ring text-xs font-medium text-primary hover:underline">Clear</button>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <label className="relative min-w-[220px] flex-1">
              <Search className="absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-muted-foreground" aria-hidden="true" />
              <input
                value={q} onChange={(e) => { setQ(e.target.value); setPage(1); }}
                placeholder="Search model, serial, CPU or office" aria-label="Search devices"
                className="tp-focus-ring w-full rounded-lg border border-input bg-card py-1.5 pl-8 pr-2.5 text-sm"
              />
            </label>
            <TouchFilter value={touch} onChange={(v) => { setTouch(v); setPage(1); }} available={touchAvailable} />
            <span className="text-xs text-muted-foreground" data-testid="device-count"><span className="font-semibold tabular-nums text-foreground">{filtered.length}</span> of {pool.length} new devices</span>
          </div>
          {(activeTokens.length > 0 || touch !== null || q.trim()) && (
            <div className="flex flex-wrap items-center gap-1.5">
              {activeTokens.map((t) => (
                <span key={`${t.f}:${t.v}`} className="inline-flex items-center gap-1 rounded-md border border-input bg-card py-0.5 pl-2 pr-1 text-xs text-foreground/85">
                  {t.text}
                  <button type="button" onClick={() => toggle(t.f, t.v)} aria-label={`Remove ${t.text}`} className="tp-focus-ring rounded px-0.5 text-muted-foreground hover:text-foreground"><X className="h-3 w-3" aria-hidden="true" /></button>
                </span>
              ))}
              <button type="button" onClick={clearAll} className="tp-focus-ring text-xs font-medium text-primary hover:underline">Clear all</button>
            </div>
          )}

          <div className="grid gap-4 md:grid-cols-[200px_minmax(0,1fr)]">
            <div className="max-h-[460px] overflow-y-auto settings-scrollbar rounded-lg border border-border bg-muted/20" aria-label="Filters" role="group">
              <div className="sticky top-0 z-[1] flex items-center justify-between border-b border-border bg-card/95 px-2.5 py-1.5 backdrop-blur-sm">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">Filters</span>
                {activeTokens.length > 0 && <button type="button" onClick={clearAll} className="tp-focus-ring text-[11px] font-medium text-primary hover:underline">Clear</button>}
              </div>
              {facets.map(({ f, label, values }, idx) => {
                const picked = (sel[f] || []).length;
                // Open by default: a section with a choice to make (2+ values) among the first
                // three, or one with a value ticked. One-value sections start folded.
                const multi = facets.filter((x) => x.values.length > 1).map((x) => x.f);
                const isOpen = openFacets[f] ?? (picked > 0 || (values.length > 1 && multi.indexOf(f) < 3));
                const shown = expanded[f] ? values : values.slice(0, FACET_PREVIEW);
                const bodyId = `facet-${f}`;
                return (
                  <div key={f} className={`px-2.5 ${idx > 0 ? 'border-t border-border/70' : ''}`}>
                    <button
                      type="button" aria-expanded={isOpen} aria-controls={bodyId}
                      onClick={() => setOpenFacets((o) => ({ ...o, [f]: !isOpen }))}
                      className="tp-focus-ring flex w-full items-center gap-1.5 rounded py-2 text-left"
                    >
                      <ChevronDown className={`h-3.5 w-3.5 flex-shrink-0 text-muted-foreground transition-transform duration-200 ${isOpen ? '' : '-rotate-90'}`} aria-hidden="true" />
                      <span className="text-xs font-semibold text-foreground/85">{label}</span>
                      <span className="ml-auto truncate pl-2 text-[11px] text-muted-foreground">
                        {picked > 0 ? <span className="font-semibold text-primary">{picked} selected</span> : !isOpen ? (values.length === 1 ? String(values[0]) : `${values.length} options`) : null}
                      </span>
                    </button>
                    <div id={bodyId} className="tp-collapse" data-open={isOpen ? 'true' : 'false'} aria-hidden={!isOpen}>
                      <div>
                        <div className="pb-2">
                          {shown.map((v) => {
                            const on = (sel[f] || []).includes(v);
                            const c = pool.filter((d) => matches(d, f) && d[f] === v).length;
                            return (
                              <label key={String(v)} className={`flex cursor-pointer items-center gap-2 rounded px-1 py-0.5 text-xs transition-colors hover:bg-muted/60 ${c === 0 && !on ? 'opacity-45' : ''}`}>
                                <input type="checkbox" checked={on} onChange={() => toggle(f, v)} tabIndex={isOpen ? 0 : -1} className="tp-focus-ring h-3.5 w-3.5 rounded border-input text-blue-600 dark:text-blue-300" />
                                <span className="min-w-0 flex-1 truncate text-foreground/85" title={String(v)}>{String(v)}</span>
                                <span className="tabular-nums text-muted-foreground/75">{c}</span>
                              </label>
                            );
                          })}
                          {values.length > FACET_PREVIEW && (
                            <button type="button" onClick={() => setExpanded((x) => ({ ...x, [f]: !x[f] }))} tabIndex={isOpen ? 0 : -1} className="tp-focus-ring mt-0.5 px-1 text-[11px] font-medium text-primary hover:underline">
                              {expanded[f] ? 'Show fewer' : `Show all ${values.length}`}
                            </button>
                          )}
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>

            <div className="min-w-0">
              {filtered.length === 0 ? (
                <p className="rounded-lg border border-dashed border-border px-3 py-6 text-center text-xs text-muted-foreground">No new device matches. Remove a filter.</p>
              ) : (
                <>
                  <div className="max-h-[440px] overflow-auto rounded-lg border border-border settings-scrollbar">
                    <table className="w-full text-xs">
                      <thead className="sticky top-0 z-[1] bg-muted text-left text-[11px] text-muted-foreground">
                        <tr>
                          <th className="w-8 px-2 py-2"><span className="sr-only">Chosen</span></th>
                          {COLUMNS.map(([k, t]) => {
                            const on = sort.key === k;
                            const Icon = on ? (sort.dir > 0 ? ArrowUp : ArrowDown) : ArrowUpDown;
                            return (
                              <th key={k} className="whitespace-nowrap px-2 py-2 font-medium" aria-sort={on ? (sort.dir > 0 ? 'ascending' : 'descending') : 'none'}>
                                <button type="button" onClick={() => sortBy(k)} className={`tp-focus-ring inline-flex items-center gap-1 rounded ${on ? 'text-primary' : ''}`}>
                                  {t}<Icon className={`h-3 w-3 ${on ? '' : 'opacity-40'}`} aria-hidden="true" />
                                </button>
                              </th>
                            );
                          })}
                        </tr>
                      </thead>
                      <tbody>
                        {rows.map((a, i) => {
                          const chosen = idOf(value) === a.id;
                          return (
                            <tr key={a.id ?? `row-${i}`} onClick={() => onChange(a)} aria-selected={chosen}
                              className={`cursor-pointer border-t border-border/60 ${chosen ? 'bg-primary/10' : 'hover:bg-muted/50'}`}>
                              <td className="px-2 py-1.5">
                                <button type="button" onClick={(e) => { e.stopPropagation(); onChange(a); }} aria-label={`Choose ${assetTitle(a)} ${a.serialNumber || ''}`}
                                  className={`tp-focus-ring block h-3.5 w-3.5 rounded-full border ${chosen ? 'border-primary bg-primary shadow-[inset_0_0_0_3px_hsl(var(--card))]' : 'border-input bg-card'}`} />
                              </td>
                              <td className="px-2 py-1.5"><span className="block whitespace-nowrap font-medium text-foreground">{assetTitle(a)}</span><span className="block whitespace-nowrap text-muted-foreground">{a.assetTag || (a.serialNumber ? `S/N ${a.serialNumber}` : '')}</span></td>
                              <td className="px-2 py-1.5 text-foreground/85">{a.cpu || '—'}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-foreground/85">{a.ram || '—'}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-foreground/85">{a.storage || '—'}</td>
                              <td className="px-2 py-1.5 text-foreground/85">{a.gpu || '—'}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-foreground/85">{a.screenSize || '—'}{a.touchScreen ? ' · touch' : ''}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 text-foreground/85">{a.location || '—'}</td>
                              <td className="whitespace-nowrap px-2 py-1.5 tabular-nums text-muted-foreground" title={a.warrantyEndDate || undefined}>{warrantyLabel(a.warrantyEndDate)}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                  <div className="mt-2 flex flex-wrap items-center justify-between gap-2 text-xs text-muted-foreground" data-testid="device-pager">
                    <span>Showing <span className="font-semibold tabular-nums text-foreground">{from}–{to}</span> of <span className="font-semibold tabular-nums text-foreground">{sorted.length}</span></span>
                    <span className="flex items-center gap-1">
                      <button type="button" onClick={() => setPage(safePage - 1)} disabled={safePage <= 1} aria-label="Previous page" className="tp-focus-ring rounded-md border border-input px-1.5 py-1 disabled:opacity-40"><ChevronLeft className="h-3.5 w-3.5" aria-hidden="true" /></button>
                      {pageButtons.map((p, i) => (p === '…'
                        ? <span key={`gap-${i}`} className="px-1">…</span>
                        : <button key={p} type="button" onClick={() => setPage(p)} aria-current={p === safePage ? 'page' : undefined}
                          className={`tp-focus-ring min-w-[28px] rounded-md border px-2 py-1 tabular-nums ${p === safePage ? 'border-primary bg-primary font-semibold text-primary-foreground' : 'border-input bg-card hover:bg-muted/50'}`}>{p}</button>))}
                      <button type="button" onClick={() => setPage(safePage + 1)} disabled={safePage >= pages} aria-label="Next page" className="tp-focus-ring rounded-md border border-input px-1.5 py-1 disabled:opacity-40"><ChevronRight className="h-3.5 w-3.5" aria-hidden="true" /></button>
                    </span>
                    <label className="flex items-center gap-1.5">Per page
                      <select value={per} onChange={(e) => { setPer(Number(e.target.value)); setPage(1); }} className="tp-focus-ring rounded-md border border-input bg-card px-1.5 py-1">
                        {PAGE_SIZES.map((n) => <option key={n} value={n}>{n}</option>)}
                      </select>
                    </label>
                  </div>
                </>
              )}
              {truncated && <p className="mt-1 text-[11px] text-muted-foreground">Showing the first 1,000 new devices. Narrow the search to find others.</p>}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
