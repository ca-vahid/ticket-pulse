import { useEffect, useMemo, useState } from 'react';
import { Check, Loader2, X } from 'lucide-react';
import { PersonAvatar } from '../tickets/ticketUi';
import { availabilityAPI } from '../../services/api';
import {
  BTN_PRIMARY, BTN_QUIET, ColorSwatch, ErrorNote, Loading, SectionTitle, TEXTAREA, fmtAmount, fmtRange, nameFromEmail,
} from './availabilityUi';

/**
 * Approvals: pending requests the caller may decide. Each row says who, what,
 * when, how much, their note, and why it needs a person (the decision reason
 * plus the rule messages that fired). Deny needs a note — the requester sees it.
 */

function ApprovalRow({ r, type, nameOf, onDecided }) {
  const [denying, setDenying] = useState(false);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const name = nameOf(r.email);
  const fired = (r.decision?.fired || []).filter((f) => f.message);

  const decide = async (action) => {
    if (action === 'deny' && !note.trim()) { setError('Add a note so they know why'); return; }
    setBusy(action);
    setError(null);
    try {
      await availabilityAPI.decide(r.id, action, note.trim() || undefined);
      onDecided(r, action);
    } catch (err) {
      setError(err?.message || 'Could not save the decision');
      setBusy(null);
    }
  };

  return (
    <li className="py-3" data-testid={`approval-${r.id}`}>
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <span className="inline-flex min-w-[12rem] flex-1 items-center gap-2">
          <PersonAvatar name={name} size="h-7 w-7" />
          <span className="min-w-0">
            <span className="block truncate text-sm font-medium text-foreground">{name}</span>
            <span className="block truncate text-xs text-muted-foreground">{r.email}</span>
          </span>
        </span>
        <span className="min-w-[14rem] flex-[2] text-sm">
          <span className="flex items-center gap-1.5 text-foreground"><ColorSwatch color={type?.color} />{type?.name || 'Time away'} · {fmtAmount(r, type?.unit)}</span>
          <span className="block text-foreground/85">{fmtRange(r)}</span>
        </span>
        <span className="ml-auto flex items-center gap-1">
          {!denying && (
            <>
              <button type="button" className={BTN_QUIET} onClick={() => { setDenying(true); setError(null); }} disabled={Boolean(busy)} aria-label={`Deny ${name}'s request`}>
                <X className="h-4 w-4" aria-hidden="true" />Deny
              </button>
              <button type="button" className={BTN_PRIMARY} onClick={() => decide('approve')} disabled={Boolean(busy)} aria-label={`Approve ${name}'s request`}>
                {busy === 'approve' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Check className="h-4 w-4" aria-hidden="true" />}Approve
              </button>
            </>
          )}
        </span>
      </div>
      <div className="mt-1.5 space-y-0.5 pl-9 text-xs text-muted-foreground">
        {r.note && <p><span className="text-foreground/85">Note:</span> {r.note}</p>}
        {r.decision?.reason && <p><span className="text-foreground/85">Needs approval:</span> {r.decision.reason}</p>}
        {fired.map((f) => <p key={`${f.ruleId}-${f.name}`}>{f.message}</p>)}
      </div>
      {denying && (
        <div className="mt-2 space-y-2 pl-9">
          <textarea
            rows={2}
            className={TEXTAREA}
            value={note}
            onChange={(e) => { setNote(e.target.value); setError(null); }}
            placeholder="Why — they will see this"
            aria-label={`Reason for denying ${name}'s request`}
            autoFocus
          />
          <div className="flex justify-end gap-2">
            <button type="button" className={BTN_QUIET} onClick={() => { setDenying(false); setNote(''); setError(null); }} disabled={Boolean(busy)}>Back</button>
            <button
              type="button"
              onClick={() => decide('deny')}
              disabled={Boolean(busy)}
              className="tp-focus-ring inline-flex items-center gap-1.5 rounded-md bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
            >
              {busy === 'deny' && <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" />}Deny request
            </button>
          </div>
        </div>
      )}
      {error && <div className="mt-2 pl-9"><ErrorNote>{error}</ErrorNote></div>}
    </li>
  );
}

export default function ApprovalsPanel({ me, nameByEmail = null, toast, onChanged }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const typeById = useMemo(() => new Map((me.leaveTypes || []).map((t) => [t.id, t])), [me.leaveTypes]);
  // The server sends each requester's name with the pending list.
  const nameOf = (email) => (rows || []).find((x) => x.email === email && x.name)?.name || nameByEmail?.get(email) || nameFromEmail(email);

  useEffect(() => {
    availabilityAPI.approvals()
      .then((res) => setRows(Array.isArray(res?.data) ? res.data : []))
      .catch((err) => { setRows([]); setError(err?.message || 'Could not load approvals'); });
  }, []);

  const decided = (r, action) => {
    setRows((list) => list.filter((x) => x.id !== r.id));
    toast?.(action === 'approve' ? `Approved ${nameOf(r.email)}'s request` : `Denied ${nameOf(r.email)}'s request`);
    onChanged?.();
  };

  if (rows === null) return <Loading label="Loading approvals…" />;
  return (
    <section aria-label="Waiting for your decision">
      <SectionTitle hint="Requests that need a person. Denying needs a note — the requester sees it.">Waiting for your decision</SectionTitle>
      <ErrorNote>{error}</ErrorNote>
      {!rows.length ? (
        <p className="py-6 text-sm text-muted-foreground">Nothing waiting for you.</p>
      ) : (
        <ul className="divide-y divide-border">
          {rows.map((r) => <ApprovalRow key={r.id} r={r} type={typeById.get(r.leaveTypeId)} nameOf={nameOf} onDecided={decided} />)}
        </ul>
      )}
    </section>
  );
}
