import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { Activity, RefreshCw, RotateCcw } from 'lucide-react';
import { assignmentAPI, handBacksAPI } from '../../services/api';
import { formatDateTimeInTimezone } from '../../utils/dateHelpers';
import { HAND_BACK_OPTIONS, handBackLabel } from '../../utils/handBack';
import { PersonAvatar } from '../tickets/ticketUi';
import FancySelect from '../common/FancySelect';

/**
 * Assignment Review → Hand-backs (QA 09-25 item 3). Why tickets were given
 * back, so the team can tune the skills matrix and routing. Summary is by
 * reason and by category only — a process signal, never a per-person tally.
 */
const REASON_FILTERS = [
  { value: '', label: 'All reasons' },
  ...HAND_BACK_OPTIONS.map((o) => ({ value: o.code, label: o.label })),
  { value: 'skipped', label: 'No reason given' },
];

function isoDay(offsetDays = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offsetDays);
  return d.toISOString().slice(0, 10);
}

function CountList({ title, rows }) {
  const max = Math.max(1, ...rows.map((r) => r.count));
  return (
    <div className="min-w-0">
      <h4 className="mb-1.5 text-xs font-medium text-muted-foreground">{title}</h4>
      {rows.length === 0 ? (
        <p className="text-xs text-muted-foreground/75">Nothing yet.</p>
      ) : (
        <ul className="space-y-1">
          {rows.map((r) => (
            <li key={r.key} className="flex items-center gap-2 text-xs">
              <span className="w-40 truncate text-foreground/85" title={r.label}>{r.label}</span>
              <span className="h-1.5 flex-1 rounded-full bg-muted" aria-hidden="true">
                <span className="block h-full rounded-full bg-primary/60" style={{ width: `${Math.round((r.count / max) * 100)}%` }} />
              </span>
              <span className="w-8 text-right tabular-nums text-muted-foreground">{r.count}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/**
 * Avatars: one team-roster fetch per mount (the same list the review queue
 * uses for its photos) → { [techId]: { photoUrl } }. Photos are never
 * selected per hand-back row; a missing/failed photo falls back to initials.
 * `techPhotos` may be passed in to skip the fetch.
 */
export default function HandBacksTab({ workspaceTimezone = 'America/Los_Angeles', isAdmin = false, techPhotos: techPhotosProp = null }) {
  const [fetchedPhotos, setFetchedPhotos] = useState(null);
  useEffect(() => {
    if (techPhotosProp) return undefined;
    let cancelled = false;
    Promise.resolve()
      .then(() => assignmentAPI.getCompetencyTechnicians())
      .then((res) => {
        if (cancelled) return;
        const map = {};
        for (const t of (res?.data || [])) if (t?.id != null) map[t.id] = { photoUrl: t.photoUrl || null };
        setFetchedPhotos(map);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [techPhotosProp]);
  const techPhotos = techPhotosProp || fetchedPhotos;
  const [reason, setReason] = useState('');
  const [from, setFrom] = useState(() => isoDay(-30));
  const [to, setTo] = useState(() => isoDay(0));
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const params = {
        ...(reason ? { reason } : {}),
        ...(from ? { from: new Date(`${from}T00:00:00`).toISOString() } : {}),
        ...(to ? { to: new Date(`${to}T23:59:59`).toISOString() } : {}),
      };
      const res = await handBacksAPI.list(params);
      setData(res?.data || { items: [], summary: { total: 0, byReason: [], byCategory: [] } });
    } catch (err) {
      setError(err.response?.data?.message || err.message || 'Could not load hand-backs');
    }
    setLoading(false);
  }, [reason, from, to]);
  useEffect(() => { load(); }, [load]);

  const items = data?.items || [];
  const summary = data?.summary || { total: 0, byReason: [], byCategory: [] };
  const reasonRows = useMemo(() => summary.byReason.map((r) => ({ key: r.code, label: r.label || handBackLabel(r.code) || r.code, count: r.count })), [summary.byReason]);
  const categoryRows = useMemo(() => summary.byCategory.map((c) => ({ key: c.name, label: c.name, count: c.count })), [summary.byCategory]);

  return (
    <div className="space-y-4" data-testid="hand-backs-tab">
      <div className="flex flex-wrap items-end gap-3">
        <div className="mr-auto min-w-0">
          <h3 className="flex items-center gap-1.5 text-sm font-semibold text-foreground">
            <RotateCcw className="h-4 w-4 text-muted-foreground" aria-hidden="true" /> Hand-backs
          </h3>
          <p className="text-xs text-muted-foreground">Why tickets went back to the queue — use it to tune skills and routing, not to rank people.</p>
        </div>
        <div className="w-44 text-xs text-muted-foreground">
          <span className="mb-0.5 block">Reason</span>
          <FancySelect value={reason} onChange={setReason} options={REASON_FILTERS} aria-label="Filter by reason" className="h-8 py-1" />
        </div>
        <label className="text-xs text-muted-foreground">
          <span className="mb-0.5 block">From</span>
          <input type="date" value={from} max={to || undefined} onChange={(e) => setFrom(e.target.value)} aria-label="From date"
            className="tp-focus-ring h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground" />
        </label>
        <label className="text-xs text-muted-foreground">
          <span className="mb-0.5 block">To</span>
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} aria-label="To date"
            className="tp-focus-ring h-8 rounded-lg border border-input bg-card px-2 text-sm text-foreground" />
        </label>
        <button type="button" onClick={load} aria-label="Refresh" className="tp-focus-ring inline-flex h-8 w-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-muted">
          {loading ? <Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> : <RefreshCw className="h-4 w-4" aria-hidden="true" />}
        </button>
      </div>

      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}

      <div className="grid gap-4 rounded-xl border border-border bg-muted/30 p-3 sm:grid-cols-2">
        <CountList title={`By reason · ${summary.total} total`} rows={reasonRows} />
        <CountList title="By category" rows={categoryRows} />
      </div>

      {loading && !data ? (
        <p className="flex items-center justify-center gap-2 py-6 text-sm text-muted-foreground" role="status"><Activity className="h-4 w-4 animate-spin" aria-hidden="true" /> Loading hand-backs…</p>
      ) : items.length === 0 ? (
        <div className="py-8 text-center">
          <RotateCcw className="mx-auto mb-2 h-6 w-6 text-muted-foreground/50" aria-hidden="true" />
          <p className="text-sm text-muted-foreground">No hand-backs in this range.</p>
          <p className="mt-0.5 text-xs text-muted-foreground/75">They appear when someone gives a ticket back or a coordinator releases it, with the reason they chose.</p>
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left text-sm">
            <thead className="text-[11px] text-muted-foreground">
              <tr className="border-b border-border">
                <th className="px-2 py-1.5 font-medium">When</th>
                <th className="px-2 py-1.5 font-medium">Ticket</th>
                <th className="px-2 py-1.5 font-medium">Category</th>
                <th className="px-2 py-1.5 font-medium">Handed back by</th>
                <th className="px-2 py-1.5 font-medium">Reason</th>
                <th className="px-2 py-1.5 font-medium">Where the AI sent it next</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border/60">
              {items.map((it) => (
                <tr key={it.id} className="align-top" data-testid="hand-back-row">
                  <td className="whitespace-nowrap px-2 py-2 text-xs text-muted-foreground">
                    {formatDateTimeInTimezone(it.createdAt, workspaceTimezone)}
                  </td>
                  <td className="max-w-[18rem] px-2 py-2">
                    <Link to={`/tickets/${it.ticket.id}`} className="tp-focus-ring rounded font-mono text-xs text-primary hover:underline">
                      {it.ticket.displayRef}
                    </Link>
                    {it.ticket.subject && <span className="block truncate text-xs text-foreground/85" title={it.ticket.subject}>{it.ticket.subject}</span>}
                  </td>
                  <td className="px-2 py-2 text-xs text-foreground/85">{it.ticket.categoryName || <span className="text-muted-foreground/75">—</span>}</td>
                  <td className="px-2 py-2 text-xs text-foreground/85">
                    {it.technician?.name ? (
                      <span className="flex min-w-0 items-center gap-1.5" data-testid="hand-back-person">
                        <PersonAvatar
                          name={it.technician.name}
                          photoUrl={techPhotos?.[it.technician.id]?.photoUrl || null}
                          size="h-5 w-5"
                          textSize="text-[9px]"
                        />
                        <span className="truncate">{it.technician.name}</span>
                      </span>
                    ) : '—'}
                    {!it.selfHandBack && it.actor?.name && (
                      <span className="mt-0.5 block text-[11px] text-muted-foreground">released by {it.actor.name}</span>
                    )}
                  </td>
                  <td className="max-w-[20rem] px-2 py-2 text-xs">
                    <span className={it.reasonCode === 'skipped' ? 'text-muted-foreground' : 'text-foreground'}>{it.reasonLabel || handBackLabel(it.reasonCode)}</span>
                    {it.reasonNote && <span className="block text-muted-foreground" title={it.reasonNote}>&ldquo;{it.reasonNote}&rdquo;</span>}
                    {it.reasonCode === 'competency' && isAdmin && it.technician?.id && (
                      <Link
                        to={`/assignments/competencies?tech=${it.technician.id}`}
                        className="tp-focus-ring mt-0.5 inline-block rounded text-[11px] text-primary hover:underline"
                      >
                        Review skills matrix
                      </Link>
                    )}
                  </td>
                  <td className="px-2 py-2 text-xs text-muted-foreground">{it.next?.text || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
