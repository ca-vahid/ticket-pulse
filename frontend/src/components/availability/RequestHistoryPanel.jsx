import { useEffect, useMemo, useState } from 'react';
import { ChevronDown, Loader2 } from 'lucide-react';
import { PersonAvatar } from '../tickets/ticketUi';
import { availabilityAPI } from '../../services/api';
import {
  BTN_QUIET, ColorSwatch, ErrorNote, Field, INPUT, Loading, REQUEST_STATUS, SectionTitle, StatusDot, fmtAmount, fmtRange, nameFromEmail,
} from './availabilityUi';

/**
 * History (QA 10-21 #1, admins): look up anyone's time-away requests in the
 * workspace on screen, past and present, in any status. Each row says how it
 * reached Vacation Tracker (or why it did not), and opens to its full trail:
 * who booked it, who decided, and every Vacation Tracker attempt.
 */

const EVENT_WORDS = {
  created: 'Booked',
  auto_approved: 'Approved by the rules',
  sent_for_approval: 'Sent for approval',
  approved: 'Approved',
  denied: 'Denied',
  cancelled: 'Cancelled',
  imported: 'Imported from Vacation Tracker',
  updated: 'Changed',
  vt_written: 'Added to Vacation Tracker',
  vt_write_skipped: 'Not added to Vacation Tracker',
  vt_write_failed: 'Vacation Tracker refused it',
  vt_cancelled: 'Cancelled in Vacation Tracker',
  vt_cancel_failed: 'Vacation Tracker refused the cancel',
};

const VT_DOT = {
  blue: 'bg-blue-500 dark:bg-blue-400',
  green: 'bg-emerald-500 dark:bg-emerald-400',
  amber: 'bg-amber-500 dark:bg-amber-400',
  red: 'bg-red-500 dark:bg-red-400',
  grey: 'bg-muted-foreground/50',
};
const VT_TONE = { imported: 'blue', written: 'green', cancelled: 'grey', skipped: 'amber', failed: 'red', not_sent: 'grey', waiting: 'amber' };

const STATUS_CHOICES = [
  { value: '', label: 'Any status' },
  { value: 'approved', label: 'Approved' },
  { value: 'pending', label: 'Waiting for approval' },
  { value: 'denied', label: 'Denied' },
  { value: 'cancelled', label: 'Cancelled' },
];

function when(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString([], { month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function actorName(actor, nameOf) {
  if (!actor) return null;
  if (actor === 'rules') return 'the rules';
  if (actor === 'vacation_tracker') return 'Vacation Tracker';
  if (String(actor).includes('@')) return nameOf(actor);
  return actor;
}

function eventDetail(e) {
  const d = e.details || {};
  return d.reason || d.note || d.error || null;
}

function HistoryRow({ r, type, nameOf }) {
  const [open, setOpen] = useState(false);
  const name = r.name || nameOf(r.email);
  const status = REQUEST_STATUS[r.status] || { tone: 'grey', label: r.status };
  const vt = r.vacationTracker || {};
  const booked = (r.events || []).find((e) => e.kind === 'created' || e.kind === 'imported');
  const bookedBy = booked ? actorName(booked.actor, nameOf) : null;
  return (
    <li className="py-3" data-testid={`history-${r.id}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span className="inline-flex min-w-[11rem] flex-1 items-center gap-2">
          <PersonAvatar name={name} size="h-7 w-7" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{r.email}</span>
          </span>
        </span>
        <span className="min-w-[13rem] flex-[2] text-sm">
          <span className="flex items-center gap-1.5 text-foreground"><ColorSwatch color={type?.color} />{type?.name || 'Time away'} · {fmtAmount(r, type?.unit)}</span>
          <span className="block text-foreground/85">{fmtRange(r)}</span>
        </span>
        <span className="min-w-[10rem] flex-1 space-y-1">
          <StatusDot tone={status.tone} label={status.label} />
          <span className="flex items-start gap-1.5 text-xs text-foreground/85" data-testid="history-vt">
            <span className={`mt-1 h-2 w-2 shrink-0 rounded-full ${VT_DOT[VT_TONE[vt.state] || 'grey']}`} aria-hidden="true" />
            {vt.label || 'Vacation Tracker: unknown'}
          </span>
        </span>
        <button
          type="button"
          className={`${BTN_QUIET} ml-auto`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-label={`${open ? 'Hide' : 'Show'} the history of ${name}'s request`}
        >
          {open ? 'Hide' : 'Details'}
          <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
        </button>
      </div>
      <p className="mt-1 pl-9 text-xs text-muted-foreground">
        {bookedBy ? `Booked by ${bookedBy}` : 'Booked'}{booked?.createdAt || r.createdAt ? ` · ${when(booked?.createdAt || r.createdAt)}` : ''}
        {r.note ? ` · Note: ${r.note}` : ''}
      </p>
      {open && (
        <ol className="mt-2 space-y-1 border-l border-border pl-4 ml-9 text-xs" aria-label="Request history">
          {(r.events || []).map((e, i) => {
            const detail = eventDetail(e);
            const by = actorName(e.actor, nameOf);
            return (
              <li key={`${e.kind}-${i}`} className="text-muted-foreground">
                <span className="font-medium text-foreground/85">{EVENT_WORDS[e.kind] || String(e.kind).replace(/_/g, ' ')}</span>
                {by && e.kind !== 'imported' && <span> by {by}</span>}
                <span> · {when(e.createdAt)}</span>
                {detail && <span className="block text-foreground/75">{detail}</span>}
              </li>
            );
          })}
          {!(r.events || []).length && <li className="text-muted-foreground">No history was kept for this request.</li>}
        </ol>
      )}
    </li>
  );
}

export default function RequestHistoryPanel({ me, config }) {
  const [email, setEmail] = useState('');
  const [status, setStatus] = useState('');
  const [leaveTypeId, setLeaveTypeId] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const types = useMemo(() => (config?.leaveTypes || me?.leaveTypes || []), [config, me]);
  const typeById = useMemo(() => new Map(types.map((t) => [t.id, t])), [types]);
  const people = useMemo(
    () => (config?.people || []).filter((p) => p.inWorkspace !== false).sort((a, b) => String(a.name || a.email).localeCompare(String(b.name || b.email))),
    [config],
  );
  const nameByEmail = useMemo(() => new Map((config?.people || []).map((p) => [String(p.email).toLowerCase(), p.name])), [config]);
  const nameOf = (e) => nameByEmail.get(String(e || '').toLowerCase()) || nameFromEmail(e);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const params = {};
    if (email) params.email = email;
    if (status) params.status = status;
    if (leaveTypeId) params.leaveTypeId = leaveTypeId;
    if (from) params.from = from;
    if (to) params.to = to;
    availabilityAPI.requestHistory(params)
      .then((res) => { if (!cancelled) setData(res?.data || { requests: [] }); })
      .catch((err) => { if (!cancelled) { setData({ requests: [] }); setError(err?.message || 'Could not load the history'); } })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [email, status, leaveTypeId, from, to]);

  const rows = data?.requests || [];
  return (
    <section aria-label="Request history" className="space-y-4">
      <SectionTitle hint="Every request of the people in this team, in any status, newest first. Open one to see who booked it, who decided and how it reached Vacation Tracker.">
        Request history
      </SectionTitle>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-5">
        <Field label="Person" className="lg:col-span-2">
          <select className={INPUT} value={email} onChange={(e) => setEmail(e.target.value)} aria-label="Person">
            <option value="">Everyone in this team</option>
            {people.map((p) => <option key={p.email} value={p.email}>{p.name || p.email}</option>)}
          </select>
        </Field>
        <Field label="Status">
          <select className={INPUT} value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
            {STATUS_CHOICES.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </Field>
        <Field label="Type">
          <select className={INPUT} value={leaveTypeId} onChange={(e) => setLeaveTypeId(e.target.value)} aria-label="Type">
            <option value="">Any type</option>
            {types.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
        <div className="grid grid-cols-2 gap-2">
          <Field label="From">
            <input type="date" className={INPUT} value={from} onChange={(e) => setFrom(e.target.value)} aria-label="From" />
          </Field>
          <Field label="To">
            <input type="date" className={INPUT} value={to} onChange={(e) => setTo(e.target.value)} aria-label="To" />
          </Field>
        </div>
      </div>
      <ErrorNote>{error}</ErrorNote>
      {data === null ? (
        <Loading label="Loading the history…" />
      ) : (
        <>
          <p className="flex items-center gap-2 text-xs text-muted-foreground" aria-live="polite">
            {loading && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}
            {rows.length === 1 ? '1 request' : `${rows.length} requests`}{data.truncated ? ' (the newest; narrow the dates to see older ones)' : ''}
          </p>
          {!rows.length ? (
            <p className="py-6 text-sm text-muted-foreground">No requests match.</p>
          ) : (
            <ul className="divide-y divide-border">
              {rows.map((r) => <HistoryRow key={r.id} r={r} type={typeById.get(r.leaveTypeId)} nameOf={nameOf} />)}
            </ul>
          )}
        </>
      )}
    </section>
  );
}
