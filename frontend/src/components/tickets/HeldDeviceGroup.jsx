import { useState } from 'react';
import { Link } from 'react-router-dom';
import { AlertTriangle, HardDrive, Link2, Loader2, Search, Sparkles, Trash2 } from 'lucide-react';
import { TicketPicker } from './HeldTicketPicker';

/**
 * One device's alert burst in the hold queue (QA 10-26 #3). A NAS that has a
 * bad hour mails sixty alerts in minutes; the queue used to show sixty lines.
 * Here it is one block: the device, how many, over what time, and one line per
 * alert KIND (numbers masked) with its count and the ticket that kind already
 * has. Broken-sounding kinds and kinds with no ticket yet come first and are
 * marked, so "Storage Pool crashed" is never buried under sixty "drive not on
 * the compatibility list". One click adds them all to a ticket (one note and
 * a count on the ticket, never sixty replies) or discards them.
 */

export const BURST_MODE_META = {
  off: { label: 'Hold each one', help: 'Every extra alert in a burst waits here on its own.' },
  shadow: { label: 'Shadow', help: 'Every extra alert still waits here, marked with the ticket it would have been counted on. Nothing is filed automatically.' },
  on: { label: 'Count on the device’s ticket', help: 'An alert whose kind already has a ticket from the same device in the last 24 hours is counted on that ticket instead of waiting here. New kinds, and broken-sounding kinds whose ticket is closed, still wait here.' },
};

function fmtShort(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

function fmtTime(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function spanText(group) {
  if (!group?.firstAt) return '';
  const a = new Date(group.firstAt);
  const b = new Date(group.lastAt || group.firstAt);
  if (a.toDateString() === b.toDateString()) return `${fmtShort(group.firstAt)}–${fmtTime(group.lastAt)}`;
  return `${fmtShort(group.firstAt)} – ${fmtShort(group.lastAt)}`;
}

const btn = 'tp-focus-ring inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-xs font-semibold disabled:opacity-50';
const textBtn = 'tp-focus-ring rounded px-1 text-xs font-medium disabled:opacity-50';

export default function HeldDeviceGroup({ group, mode = 'shadow', busy = false, onBulk }) {
  const [picking, setPicking] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  if (!group) return null;
  const suggested = group.suggestedTicket;
  const kinds = group.kinds || [];
  const shadowTotal = kinds.reduce((n, k) => n + (k.shadowFolds || 0), 0);

  const act = (ids, action, ticket = null) => {
    setPicking(false);
    setConfirmDiscard(false);
    return onBulk?.(ids, action, ticket);
  };

  return (
    <section className="space-y-3" aria-label={`${group.device}: ${group.count} held alerts`} data-testid={`held-group-${group.sender}`}>
      <div className="flex items-start gap-3">
        <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground">
          <HardDrive className="h-4 w-4" aria-hidden="true" />
        </span>
        <div className="min-w-0 flex-1">
          <h3 className="text-base font-semibold text-foreground [overflow-wrap:anywhere]">
            {group.device}
            <span className="font-normal text-muted-foreground"> · {group.count} alerts · {kinds.length} {kinds.length === 1 ? 'kind' : 'kinds'}</span>
          </h3>
          <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
            {group.sender} · {spanText(group)}
          </p>
          {group.attention && (
            <p className="mt-1 flex items-center gap-1 text-xs font-semibold text-red-700 dark:text-red-300" data-testid="held-group-attention">
              <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" /> Something on this device reads like a failure. Look at the marked kinds first.
            </p>
          )}
        </div>
      </div>

      <ul className="divide-y divide-border/60 rounded-lg border border-border" data-testid="held-group-kinds">
        {kinds.map((k) => (
          <li key={k.key} className="flex flex-wrap items-start gap-x-3 gap-y-1 px-3 py-2" data-testid="held-group-kind">
            <span className="w-10 flex-shrink-0 text-right font-mono text-sm tabular-nums text-foreground">{k.count}×</span>
            <div className="min-w-0 flex-1">
              <p className={`text-sm [overflow-wrap:anywhere] ${k.attention ? 'font-semibold text-red-700 dark:text-red-300' : 'text-foreground'}`}>
                {k.attention && <AlertTriangle className="mr-1 inline h-3.5 w-3.5 align-[-2px]" aria-label="Reads like a failure" />}
                {k.label}
              </p>
              <p className="text-xs text-muted-foreground">
                {k.ticket ? (
                  <>Ticket <Link to={`/tickets/${k.ticket.id}`} className="tp-focus-ring rounded font-mono text-primary hover:underline">{k.ticket.displayRef}</Link> ({k.ticket.status})</>
                ) : (
                  <span className="font-semibold text-amber-700 dark:text-amber-300">New kind, no ticket yet</span>
                )}
                {' · newest '}{fmtTime(k.newestAt)}
                {mode === 'shadow' && k.shadowFolds > 0 && k.ticket && (
                  <span data-testid="held-kind-shadow"> · Shadow: {k.shadowFolds} would have been counted on {k.ticket.displayRef}</span>
                )}
              </p>
            </div>
            <div className="flex items-center gap-1">
              {k.ticket && (
                <button type="button" disabled={busy} onClick={() => act(k.ids, 'attach', k.ticket)} className={`${textBtn} text-primary hover:bg-primary/10`}>
                  Add to {k.ticket.displayRef}
                </button>
              )}
              <button type="button" disabled={busy} onClick={() => act(k.ids, 'discard')} className={`${textBtn} text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300`} aria-label={`Discard ${k.count} ${k.label}`}>
                Discard
              </button>
            </div>
          </li>
        ))}
      </ul>

      {mode === 'shadow' && shadowTotal > 0 && (
        <p className="flex items-start gap-1.5 text-xs text-muted-foreground" data-testid="held-group-shadow">
          <Sparkles className="mt-0.5 h-3.5 w-3.5 flex-shrink-0" aria-hidden="true" />
          Shadow: with burst grouping on, {shadowTotal} of these would have been counted on their kind&rsquo;s ticket and not waited here.
        </p>
      )}

      <div className="flex flex-wrap items-center gap-2" data-testid="held-group-actions">
        {suggested && (
          <button type="button" disabled={busy} onClick={() => act(group.ids, 'attach', suggested)} className={`${btn} bg-primary text-primary-foreground hover:bg-primary/90`} data-testid="held-group-attach-all">
            {busy ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Link2 className="h-3.5 w-3.5" aria-hidden="true" />}
            Add all {group.count} to {suggested.displayRef}
          </button>
        )}
        <button type="button" disabled={busy} onClick={() => { setPicking((v) => !v); setConfirmDiscard(false); }} className={`${btn} border border-border bg-card text-foreground hover:bg-muted`}>
          <Search className="h-3.5 w-3.5" aria-hidden="true" /> Add all to another ticket…
        </button>
        {confirmDiscard ? (
          <span className="ml-auto inline-flex items-center gap-2 text-xs text-foreground" data-testid="held-group-confirm-discard">
            Discard all {group.count}?
            <button type="button" disabled={busy} onClick={() => act(group.ids, 'discard')} className={`${btn} bg-red-600 text-white hover:bg-red-700`}>Discard</button>
            <button type="button" onClick={() => setConfirmDiscard(false)} className={`${textBtn} text-muted-foreground hover:text-foreground`}>Cancel</button>
          </span>
        ) : (
          <button type="button" disabled={busy} onClick={() => { setConfirmDiscard(true); setPicking(false); }} className={`${btn} ml-auto text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300`} data-testid="held-group-discard-all">
            <Trash2 className="h-3.5 w-3.5" aria-hidden="true" /> Discard all {group.count}
          </button>
        )}
      </div>
      {picking && <TicketPicker onPick={(t) => act(group.ids, 'attach', t)} onCancel={() => setPicking(false)} />}
      <p className="text-[11px] text-muted-foreground">
        Adding several to a ticket writes one internal note listing them and counts them on the ticket; it does not post them as replies.
      </p>
    </section>
  );
}
