import { useEffect, useId, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { ArrowRight, ChevronDown, MoreHorizontal } from 'lucide-react';
import { agoWords, formatPacificWhen } from '../../utils/ticketDates';
import { defaultRequester, describeSuggestion, fmtRef, isAcceptable, needsPerson, suggestionSentence } from './mailReviewText';
import TicketPickPopover from './TicketPickPopover';

/**
 * One held e-mail on Mail review → Waiting (UI Design, 11 Nov 2026):
 *   line 1  sender → mailbox · subject · time (Pacific, relative on hover)
 *   line 2  the snippet
 *   line 3  the suggestion: verb first, then the ticket, then what else happens
 *   line 4  why, one line (the rest is in Details)
 * then one primary button, one quiet one and a More menu. Which button is
 * primary follows how sure the AI is. No box per row; the list divides them.
 */

const PRIMARY = 'tp-focus-ring inline-flex h-8 flex-1 items-center justify-center gap-1.5 rounded-lg bg-primary px-3.5 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50 sm:flex-none';
const QUIET_BASE = 'tp-focus-ring h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-foreground/85 hover:bg-muted disabled:opacity-50';
// On a phone only the first button of the row shows; the rest are in More.
const QUIET = `${QUIET_BASE} hidden sm:inline-flex`;
const QUIET_LEAD = `${QUIET_BASE} inline-flex`;

const LABEL = { accept: 'Accept', pick: 'Pick another ticket', new: 'New ticket', none: 'No ticket needed', details: 'Details' };

/**
 * Which action leads: Accept when the AI is sure or likely, otherwise the
 * choice a person has to make. Discarding is the one exception: "No ticket
 * needed" gets a blue Accept only when the AI is sure; at likely or unsure
 * the row has no primary button at all, so nobody discards mail by reflex.
 */
export function planActions(s) {
  if (!s) return { primary: 'new', quiet: ['pick'] };
  const acceptable = isAcceptable(s);
  if (!acceptable) return { primary: 'pick', quiet: ['new'] };
  if (s.action === 'no_ticket' && s.confidence !== 'sure') return { primary: null, quiet: ['accept', 'pick'] };
  if (s.confidence === 'unsure') return { primary: 'pick', quiet: ['accept'] };
  return { primary: 'accept', quiet: ['pick'] };
}

/** The ticket number as a real link: the Tickets peek, in a new tab, so the review list stays put. */
export function TicketRefLink({ ticket, className = '' }) {
  if (!ticket) return null;
  return (
    <Link
      to={`/tickets?peek=${ticket.id}`}
      target="_blank"
      rel="noopener"
      title="Opens a preview of the ticket in a new tab"
      onClick={(e) => e.stopPropagation()}
      className={`tp-focus-ring rounded font-medium tabular-nums text-primary hover:underline ${className}`}
    >
      {fmtRef(ticket)}
    </Link>
  );
}

/** "AI suggests: Add to #249132 · Monitor arm (Closed 27 Oct) → reopens it · sure". */
export function SuggestionLine({ suggestion, mode, compactOnPhone = false }) {
  const d = describeSuggestion(suggestion);
  const shadow = (suggestion?.mode || mode) === 'shadow';
  if (!suggestion && mode === 'off') {
    return (
      <p className="text-sm text-muted-foreground" data-testid="mr-suggestion">
        Not judged: AI review is off for this workspace.
      </p>
    );
  }
  return (
    <p className="text-sm text-foreground [overflow-wrap:anywhere]" data-testid="mr-suggestion">
      <span className="text-muted-foreground">AI suggests: </span>
      <span className={d.kind === 'none' || d.kind === 'unsure' ? 'text-foreground/85' : 'font-medium'}>{d.verb}</span>
      {d.ticket && (
        <>
          {' '}<TicketRefLink ticket={d.ticket} />
          {d.ticket.subject && <span className={`text-foreground/85 ${compactOnPhone ? 'hidden sm:inline' : ''}`} data-testid="mr-suggestion-subject"> · {d.ticket.subject}</span>}
          {d.closed && <span className="text-muted-foreground"> {d.closed}</span>}
        </>
      )}
      {d.effects.length > 0 && (
        <span className="font-medium">
          {' '}<ArrowRight className="inline h-3.5 w-3.5 -translate-y-px text-muted-foreground" aria-label="which" />{' '}
          {d.effects.join(' and ')}
        </span>
      )}
      {d.confidence && <span className="text-muted-foreground"> · {d.confidence}</span>}
      {shadow && <span className="text-muted-foreground"> · Shadow: shown, not applied</span>}
    </p>
  );
}

function MoreMenu({ items, onChoose, disabled }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const menuId = useId();
  useEffect(() => {
    if (!open) return undefined;
    const onDoc = (e) => { if (!rootRef.current?.contains(e.target)) setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);
  useEffect(() => {
    if (open) rootRef.current?.querySelector('[role="menuitem"]')?.focus();
  }, [open]);
  const onKey = (e) => {
    if (!open) return;
    const all = [...(rootRef.current?.querySelectorAll('[role="menuitem"]') || [])].filter((el) => el.offsetParent !== null || el === document.activeElement);
    const list = all.length ? all : [...(rootRef.current?.querySelectorAll('[role="menuitem"]') || [])];
    const at = list.indexOf(document.activeElement);
    if (e.key === 'Escape') {
      e.stopPropagation();
      setOpen(false);
      rootRef.current?.querySelector('button')?.focus();
    } else if (e.key === 'ArrowDown') { e.preventDefault(); list[(at + 1) % list.length]?.focus(); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); list[(at - 1 + list.length) % list.length]?.focus(); }
  };
  return (
    <div ref={rootRef} className="relative" data-mr-popover onKeyDown={onKey}>
      <button
        type="button"
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((v) => !v)}
        className="tp-focus-ring inline-flex h-8 items-center gap-1 rounded-lg px-2.5 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground disabled:opacity-50"
        data-testid="mr-more"
      >
        <MoreHorizontal className="h-4 w-4" aria-hidden="true" /> More
      </button>
      {open && (
        <ul id={menuId} role="menu" className="absolute right-0 z-20 mt-1 min-w-[12rem] rounded-lg border border-border bg-card py-1 shadow-soft sm:left-0 sm:right-auto">
          {items.map((it) => (
            <li key={it.key} role="none" className={it.phoneOnly ? 'sm:hidden' : ''}>
              <button
                type="button"
                role="menuitem"
                onClick={() => { setOpen(false); onChoose(it.key); }}
                className="block w-full px-3 py-1.5 text-left text-sm text-foreground hover:bg-muted focus:bg-muted focus:outline-none"
              >
                {LABEL[it.key]}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function NewTicketForm({ initial, busy, onCreate, onCancel }) {
  const [email, setEmail] = useState(initial);
  const id = useId();
  const valid = /^\S+@\S+\.\S+$/.test(email.trim());
  return (
    <form
      data-mr-popover
      data-testid="mr-new-form"
      className="mt-2 flex flex-wrap items-center gap-2"
      onSubmit={(e) => { e.preventDefault(); if (valid) onCreate(email.trim().toLowerCase()); }}
    >
      <label htmlFor={id} className="text-sm text-muted-foreground">New ticket for</label>
      <input
        id={id}
        type="email"
        autoFocus
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        placeholder="requester@example.com"
        className="tp-focus-ring h-8 min-w-0 flex-1 rounded-lg border border-input bg-card px-2.5 text-sm text-foreground placeholder:text-muted-foreground/75 sm:max-w-xs"
      />
      <button type="submit" disabled={busy || !valid} className={PRIMARY.replace('flex-1 ', '')}>Make the ticket</button>
      <button type="button" onClick={onCancel} className="tp-focus-ring h-8 rounded-lg px-2 text-sm text-muted-foreground hover:bg-muted hover:text-foreground">Cancel</button>
    </form>
  );
}

export default function WaitingRow({
  item, mode = 'off', focused = false, error = null, openForm = null, detail = null, detailError = null, viewerEmail = '',
  onFocus, onAccept, onOpenForm, onPick, onCreate, onNoTicket, onDetails,
}) {
  const s = item.suggestion;
  const plan = planActions(s);
  const sender = item.from?.name || item.from?.email || 'Unknown sender';
  const mailbox = item.mailbox || (item.to || [])[0] || '';
  const others = Math.max(0, (item.to || []).length - 1);
  const run = (key) => {
    if (key === 'accept') onAccept?.(item);
    else if (key === 'pick') onOpenForm?.(item, openForm === 'pick' ? null : 'pick');
    else if (key === 'new') onOpenForm?.(item, openForm === 'new' ? null : 'new');
    else if (key === 'none') onNoTicket?.(item);
    else if (key === 'details') onDetails?.(item);
  };
  // On a phone the first button of the row stays; every other quiet one is in More.
  const lead = plan.primary || plan.quiet[0];
  const more = ['accept', 'pick', 'new', 'none', 'details']
    .filter((k) => k !== lead && (k !== 'accept' || plan.quiet.includes('accept')))
    .map((k) => ({ key: k, phoneOnly: plan.quiet.includes(k) }));
  const expanded = (key) => (key === 'pick' || key === 'new' ? openForm === key : undefined);
  const acceptLabel = s && isAcceptable(s) ? `Accept: ${suggestionSentence(s)}` : undefined;
  const label = (key) => (key === 'accept' ? acceptLabel : undefined);

  return (
    <li
      data-held-id={item.heldId}
      data-testid="mr-row"
      tabIndex={focused ? 0 : -1}
      aria-current={focused ? 'true' : undefined}
      aria-label={`${sender}: ${item.subject || '(no subject)'}`}
      onFocus={() => onFocus?.(item)}
      className={`relative px-3 py-3 outline-none hover:bg-muted/40 focus-visible:bg-muted/40 sm:px-4 ${focused ? 'shadow-[inset_2px_0_0_hsl(var(--primary))]' : ''}`}
    >
      <div className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5">
        <span className="min-w-0 shrink-0 truncate text-sm text-muted-foreground max-sm:flex-1">
          <span className="text-foreground/85" title={item.from?.email || undefined}>{sender}</span>
          {mailbox && (
            <>
              {' '}<ArrowRight className="inline h-3 w-3 -translate-y-px" aria-label="to" />{' '}
              <span title={(item.to || []).join(', ') || undefined}>{mailbox}{others ? ` +${others}` : ''}</span>
            </>
          )}
        </span>
        <span className="min-w-0 text-sm font-medium text-foreground max-sm:order-3 max-sm:basis-full max-sm:[overflow-wrap:anywhere] sm:flex-1 sm:truncate">
          {item.subject || '(no subject)'}
        </span>
        <time
          dateTime={item.receivedAt || undefined}
          title={agoWords(item.receivedAt) || undefined}
          className="shrink-0 whitespace-nowrap text-xs tabular-nums text-muted-foreground"
        >
          {formatPacificWhen(item.receivedAt)}
        </time>
      </div>
      {item.snippet && <p className="mt-0.5 truncate text-sm text-muted-foreground">{item.snippet}</p>}

      <div className="mt-1.5">
        <SuggestionLine suggestion={s} mode={mode} compactOnPhone />
        {s?.reason && <p className="mt-0.5 line-clamp-1 text-sm text-muted-foreground" data-testid="mr-why">Why: {s.reason}</p>}
        {needsPerson(s).length > 0 && (
          <p className="mt-0.5 text-sm text-muted-foreground [overflow-wrap:anywhere]" data-testid="mr-needs-person">Needs a person: {needsPerson(s).join(' · ')}</p>
        )}
      </div>

      {error && <p role="alert" className="mt-1.5 text-sm text-red-700 dark:text-red-300">{error}</p>}

      <div className="relative mt-2 flex items-center gap-1.5" data-testid="mr-actions">
        {plan.primary && (
          <button type="button" onClick={() => run(plan.primary)} aria-label={label(plan.primary)} aria-expanded={expanded(plan.primary)} className={PRIMARY} data-testid="mr-primary" data-action={plan.primary}>
            {LABEL[plan.primary]}
            {plan.primary === 'pick' && <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        )}
        {plan.quiet.map((k) => (
          <button key={k} type="button" onClick={() => run(k)} aria-label={label(k)} aria-expanded={expanded(k)} className={k === lead ? QUIET_LEAD : QUIET} data-testid="mr-secondary" data-action={k}>
            {LABEL[k]}
            {k === 'pick' && <ChevronDown className="h-3.5 w-3.5" aria-hidden="true" />}
          </button>
        ))}
        <MoreMenu items={more} onChoose={run} />
      </div>

      {openForm === 'pick' && (
        <div className="sm:relative">
          <TicketPickPopover
            suggested={s?.ticket || null}
            candidates={detail ? detail.candidates || [] : null}
            error={detailError}
            onPick={(ticket, reopen) => onPick?.(item, ticket, reopen)}
            onClose={() => onOpenForm?.(item, null)}
          />
        </div>
      )}
      {openForm === 'new' && (
        <NewTicketForm
          initial={defaultRequester(item, viewerEmail)}
          onCreate={(email) => onCreate?.(item, email)}
          onCancel={() => onOpenForm?.(item, null)}
        />
      )}
    </li>
  );
}
