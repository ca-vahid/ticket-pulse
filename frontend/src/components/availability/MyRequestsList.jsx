import { useState } from 'react';
import { ChevronDown, Loader2, Pencil } from 'lucide-react';
import {
  BTN_QUIET, ColorSwatch, REQUEST_STATUS, SectionTitle, StatusDot, fmtAmount, fmtRange, leaveLabel, sitePlace, todayKey,
} from './availabilityUi';
import { pastRequests, upcomingRequests } from './bookingModel';

/**
 * (My time no longer shows this list since QA 11-25 #1 — see ComingUpCard;
 * it is kept for other callers.)
 * My requests: upcoming first (soonest at the top), then past (latest first).
 * Each row: type, range, amount, status dot + word. The decision reason and
 * the approver note open underneath. Pending and future approved requests can
 * be cancelled after an inline confirmation; a request still waiting for
 * approval can be changed (Nov 2026) and says who it is waiting for.
 * Leave that came from Vacation Tracker can be cancelled here too while it
 * is approved and not over (QA 11-09); if Vacation Tracker could not be told,
 * the cancelled row says to cancel it there as well.
 */

function RequestRow({ r, type, onCancel, onEdit, isEditing, offices = [] }) {
  const [open, setOpen] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const status = REQUEST_STATUS[r.status] || REQUEST_STATUS.cancelled;
  // Leave synced from Vacation Tracker is changed there while people use both,
  // but it can be cancelled here once approved (QA 11-09 #2).
  const fromVt = r.source === 'vacation_tracker';
  // 26 Nov 2026: Vacation Tracker retired — its bookings are ordinary bookings now.
  const handedOver = fromVt && r.vtRetired === true;
  // QA 11-16: imported from the shared calendar; cancel only, never changed here.
  const fromCal = r.source === 'shared_calendar';
  const imported = (fromVt && !handedOver) || fromCal;
  const cancellable = (imported ? r.status === 'approved' : (r.status === 'pending' || r.status === 'approved')) && r.endDate >= todayKey();
  const stillInVt = fromVt && r.status === 'cancelled' && r.stillInVacationTracker === true;
  const editable = Boolean(onEdit) && !imported && r.status === 'pending' && r.editable !== false;
  const waitingOn = r.status === 'pending' ? (r.waitingOn || []).map((p) => p.name || p.email).filter(Boolean) : [];
  const reason = r.decision?.reason || null;
  const fired = (r.decision?.fired || []).filter((f) => f.message);
  const hasDetail = Boolean(reason || fired.length || r.note || r.decisionNote);

  const doCancel = async () => {
    setBusy(true);
    try { await onCancel(r); } finally { setBusy(false); setConfirming(false); }
  };

  return (
    <li className={`py-2.5 ${isEditing ? '-mx-2 rounded-lg bg-primary/5 px-2 dark:bg-primary/10' : ''}`} data-testid={`my-request-${r.id}`}>
      <div className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 sm:grid-cols-[minmax(0,12rem)_minmax(0,1fr)_6rem_11rem_auto]">
        <span className="flex min-w-0 items-center gap-2 text-sm text-foreground">
          <ColorSwatch color={type?.color} />
          <span className="truncate">{leaveLabel(type?.name, sitePlace(r, offices))}</span>
          {fromVt && !handedOver && <span className="shrink-0 text-xs text-muted-foreground" title="Booked in Vacation Tracker; change it there or cancel it here">· Vacation Tracker</span>}
          {handedOver && <span className="shrink-0 text-xs text-muted-foreground" title="Booked in Vacation Tracker before it was retired; it is a Vacation Pulse booking now">· Booked in Vacation Tracker</span>}
          {!fromVt && r.inVacationTracker && r.status === 'approved' && <span className="shrink-0 text-xs text-muted-foreground" title="Ticket Pulse added this to Vacation Tracker when it was approved">· also in Vacation Tracker</span>}
        </span>
        <span className="order-3 col-span-2 min-w-0 sm:order-none sm:col-span-1">
          <span className="block text-sm text-foreground/85">
            {fmtRange(r)}
            {fromCal && <span className="text-xs text-muted-foreground" title="Added from the shared calendar; change it there or cancel it here"> · From the shared calendar</span>}
          </span>
          {waitingOn.length > 0 && <span className="block truncate text-xs text-muted-foreground">Waiting for {waitingOn.join(' or ')}</span>}
          {stillInVt && <span className="block text-xs text-amber-700 dark:text-amber-300" data-testid={`still-in-vt-${r.id}`}>Cancelled in Ticket Pulse. Cancel it in Vacation Tracker too.</span>}
        </span>
        <span className="hidden text-sm tabular-nums text-muted-foreground sm:block">{fmtAmount(r, type?.unit)}</span>
        <span title={reason || undefined}><StatusDot tone={status.tone} label={status.label} /></span>
        <span className="order-4 col-span-2 flex items-center justify-end gap-1 sm:order-none sm:col-span-1">
          {hasDetail && (
            <button type="button" className={BTN_QUIET} onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-label={`Details for ${type?.name || 'request'} ${fmtRange(r)}`}>
              <ChevronDown className={`h-4 w-4 transition-transform ${open ? 'rotate-180' : ''}`} aria-hidden="true" />
            </button>
          )}
          {isEditing && <span className="px-2 text-xs font-medium text-primary">Changing…</span>}
          {editable && !isEditing && !confirming && (
            <button type="button" className={BTN_QUIET} onClick={() => onEdit(r)} aria-label={`Change ${type?.name || 'request'} ${fmtRange(r)}`}>
              <Pencil className="h-3.5 w-3.5" aria-hidden="true" />Change
            </button>
          )}
          {cancellable && !confirming && (
            <button type="button" className={BTN_QUIET} onClick={() => setConfirming(true)}>Cancel</button>
          )}
        </span>
      </div>
      {confirming && (
        <div role="group" aria-label="Confirm cancel" className="mt-2 flex flex-wrap items-center justify-end gap-2 text-sm">
          <span className="mr-auto text-foreground/85">
            Cancel {type?.name?.toLowerCase() || 'this request'} for {fmtRange(r)}?
            {fromVt && !handedOver && <span className="block text-xs text-muted-foreground">It came from Vacation Tracker. Ticket Pulse cancels it there too when it can.</span>}
            {handedOver && <span className="block text-xs text-muted-foreground">Booked in Vacation Tracker, which is retired: it is cancelled here only.</span>}
            {fromCal && <span className="block text-xs text-muted-foreground">It came from the shared calendar. It stays cancelled here; the calendar entry is not changed.</span>}
          </span>
          <button type="button" className={BTN_QUIET} onClick={() => setConfirming(false)} disabled={busy}>Keep it</button>
          <button
            type="button"
            onClick={doCancel}
            disabled={busy}
            className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
          >
            {busy && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Cancel request
          </button>
        </div>
      )}
      {open && (
        <div className="mt-2 space-y-1 border-l-2 border-border pl-3 text-xs text-muted-foreground animate-fadeIn">
          {r.note && <p><span className="text-foreground/85">Your note:</span> {r.note}</p>}
          {reason && <p><span className="text-foreground/85">Why:</span> {reason}</p>}
          {fired.map((f) => <p key={`${f.ruleId}-${f.name}`}>{f.message}</p>)}
          {r.decisionNote && <p><span className="text-foreground/85">Approver:</span> {r.decisionNote}</p>}
        </div>
      )}
    </li>
  );
}

export default function MyRequestsList({ requests, typeById, onCancel, onEdit = null, editingId = null, offices = [] }) {
  if (requests === null) {
    return <p className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />Loading your requests…</p>;
  }
  const today = todayKey();
  // QA 11-25 #1: only approved and waiting requests are upcoming; a cancelled or
  // denied one, even in the future, is listed with the past ones.
  const upcoming = upcomingRequests(requests, today);
  const past = pastRequests(requests, today);

  const list = (rows) => (
    <ul className="divide-y divide-border">
      {rows.map((r) => <RequestRow key={r.id} r={r} type={typeById.get(r.leaveTypeId)} onCancel={onCancel} onEdit={onEdit} isEditing={editingId === r.id} offices={offices} />)}
    </ul>
  );

  return (
    <section aria-label="My requests">
      <SectionTitle>My requests</SectionTitle>
      {!requests.length && <p className="text-sm text-muted-foreground">Nothing booked this year yet.</p>}
      {upcoming.length > 0 && (
        <>
          <h3 className="mt-2 text-xs font-medium text-muted-foreground">Upcoming</h3>
          {list(upcoming)}
        </>
      )}
      {past.length > 0 && (
        <>
          <h3 className="mt-4 text-xs font-medium text-muted-foreground">Past and cancelled</h3>
          {list(past)}
        </>
      )}
    </section>
  );
}
