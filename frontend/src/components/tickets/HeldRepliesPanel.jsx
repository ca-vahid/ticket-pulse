import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, CheckCircle, Inbox, Link2, Loader2, MailQuestion, Plus, Search, Trash2, X,
} from 'lucide-react';
import { searchAPI, ticketsAPI } from '../../services/api';

/**
 * Hold reasons (Phase RL, RL-4) → chip copy. Mirrors mailboxHoldService.
 */
export const HOLD_REASON_META = {
  unknown_reference: {
    label: 'Unknown reference',
    tone: 'amber',
    help: 'Looks like a reply, but the message it answers is not one Ticket Pulse sent or received (token stripped, or a thread we never saw).',
  },
  agent_reply_no_requester: {
    label: 'Agent reply, no requester',
    tone: 'violet',
    help: 'An agent sent this with the mailbox in Cc/Bcc but no external requester could be identified — pick who the ticket is for.',
  },
  ambiguous_sender: {
    label: 'Ambiguous sender',
    tone: 'sky',
    help: 'The sender could not be attributed to one requester safely.',
  },
  policy_replies_only: {
    label: 'Policy: replies only',
    tone: 'slate',
    help: 'This mailbox is set to never create tickets from unmatched mail.',
  },
};

const TONE = {
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  violet: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/30',
  sky: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30',
  slate: 'bg-muted text-muted-foreground border-border',
};

function ReasonChip({ reason }) {
  const meta = HOLD_REASON_META[reason] || { label: reason, tone: 'slate', help: '' };
  return (
    <span
      className={`inline-flex items-center px-1.5 py-0.5 rounded-md text-[11px] font-medium border ${TONE[meta.tone] || TONE.slate}`}
      title={meta.help}
      data-testid="held-reason-chip"
    >
      {meta.label}
    </span>
  );
}

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

/** Ticket typeahead for "Attach to ticket" — global search, tickets only. */
function TicketPicker({ onPick, onCancel, initialQuery = '' }) {
  const [q, setQ] = useState(initialQuery);
  const [results, setResults] = useState([]);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) { setResults([]); return undefined; }
    let alive = true;
    setBusy(true);
    const t = setTimeout(() => {
      searchAPI.global(term, 'tickets')
        .then((res) => { if (alive) setResults(res.data?.sections?.tickets || []); })
        .catch(() => { if (alive) setResults([]); })
        .finally(() => { if (alive) setBusy(false); });
    }, 200);
    return () => { alive = false; clearTimeout(t); };
  }, [q]);

  return (
    <div className="mt-2 p-2 rounded-lg border border-border bg-muted/50 space-y-2" data-testid="held-ticket-picker">
      <div className="flex items-center gap-2">
        <Search className="w-3.5 h-3.5 text-muted-foreground/75" aria-hidden="true" />
        <input
          autoFocus
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tickets — TP-1204, subject, requester…"
          aria-label="Search tickets to attach to"
          className="flex-1 text-sm bg-card border border-border rounded-md px-2 py-1.5"
        />
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin text-muted-foreground/75" aria-hidden="true" />}
        <button type="button" onClick={onCancel} aria-label="Cancel attach" className="p-1 rounded-md text-muted-foreground/75 hover:text-foreground hover:bg-muted tp-focus-ring">
          <X className="w-3.5 h-3.5" />
        </button>
      </div>
      {results.length > 0 && (
        <ul className="max-h-48 overflow-y-auto settings-scrollbar divide-y divide-border/60 rounded-md border border-border bg-card">
          {results.map((t) => (
            <li key={t.id}>
              <button
                type="button"
                onClick={() => onPick(t)}
                className="w-full text-left px-2.5 py-1.5 text-sm hover:bg-muted tp-focus-ring flex items-center gap-2"
              >
                <span className="font-mono text-xs text-primary">{t.displayRef}</span>
                <span className="truncate text-foreground">{t.subject}</span>
                <span className="ml-auto text-[11px] text-muted-foreground/75 whitespace-nowrap">{t.status}{t.requesterName ? ` · ${t.requesterName}` : ''}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
      {q.trim().length >= 2 && !busy && results.length === 0 && (
        <p className="text-xs text-muted-foreground/75 px-1">No tickets match.</p>
      )}
    </div>
  );
}

/**
 * The hold queue ("Unmatched replies") — Phase RL, RL-4. Rendered on
 * Settings → Ticket Mailboxes and behind the pill on the Tickets queue.
 * Each row: reason chip, From/To/Cc, subject, snippet, best-guess ticket
 * link, and the three actions (Attach to ticket / Create ticket / Discard).
 * `agent_reply_no_requester` rows get the "Create ticket for <address>"
 * chooser over the addresses seen on the mail.
 */
export default function HeldRepliesPanel({ onCountChange = null, compact = false, showGuidance = true }) {
  const [rows, setRows] = useState(null);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [busyId, setBusyId] = useState(null);
  const [attaching, setAttaching] = useState(null); // held id with the picker open
  const [choosing, setChoosing] = useState(null); // held id with the address chooser open
  const [chosen, setChosen] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await ticketsAPI.listHeldMessages('held');
      const list = res.data || [];
      setRows(list);
      setError(null);
      onCountChange?.(res.meta?.heldCount ?? list.length);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setRows([]);
    }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  const run = async (row, fn, successText) => {
    setBusyId(row.id);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      setNotice(typeof successText === 'function' ? successText(res) : successText);
      setAttaching(null);
      setChoosing(null);
      setChosen('');
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusyId(null);
    }
  };

  const attach = (row, ticket) => run(
    row,
    () => ticketsAPI.attachHeldMessage(row.id, ticket.id),
    () => `Attached to ${ticket.displayRef} as a reply.`,
  );
  const create = (row, requesterEmail = null) => run(
    row,
    () => ticketsAPI.createTicketFromHeld(row.id, requesterEmail ? { requesterEmail } : {}),
    (res) => `Created ${res?.data?.ticket?.displayRef || 'a ticket'}${requesterEmail ? ` for ${requesterEmail}` : ''}.`,
  );
  const discard = (row) => run(row, () => ticketsAPI.discardHeldMessage(row.id), 'Discarded.');

  // Addresses the "Create ticket for…" chooser offers: the ingest's own
  // candidates first, then every To/Cc and the sender — never the mailbox
  // itself (a ticket "for patickets@" would loop).
  const candidatesFor = (row) => {
    const seen = new Set([String(row.connectionAddress || '').toLowerCase()]);
    const out = [];
    for (const a of [...(row.candidates || []), ...(row.toEmails || []), ...(row.ccEmails || []), row.fromEmail]) {
      const v = String(a || '').trim().toLowerCase();
      if (v && v.includes('@') && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  };

  return (
    <div className="space-y-3" data-testid="held-replies-panel">
      {!compact && (
        <div className="flex items-center gap-3">
          <div className="p-2 bg-amber-100 dark:bg-amber-500/20 rounded-lg">
            <MailQuestion className="w-5 h-5 text-amber-600 dark:text-amber-300" aria-hidden="true" />
          </div>
          <div>
            <h3 className="text-base font-semibold text-foreground">Unmatched replies</h3>
            <p className="text-sm text-muted-foreground">
              Emails that looked like replies to a conversation Ticket Pulse does not know, or came from an agent with no
              identifiable requester. They were held instead of becoming new tickets — decide what each one is.
            </p>
          </div>
        </div>
      )}

      {showGuidance && (
        <div className="p-3 rounded-lg border border-border bg-muted/50 text-xs text-muted-foreground space-y-1" data-testid="held-guidance">
          <p className="font-medium text-foreground">Two supported ways for an agent to file a direct email as a ticket:</p>
          <ol className="list-decimal pl-4 space-y-0.5">
            <li><b>Forward</b> the email to the ticket mailbox — the original sender stays the requester.</li>
            <li><b>Reply-all</b> to the requester with the ticket mailbox in <b>Cc</b> — the ticket is created for the requester, your reply is the first response, and you are assigned.</li>
          </ol>
          <p>Never <b>Bcc</b> the mailbox (nothing in the headers → held for review), and do not Cc it on internal agent-to-agent threads (held with the address chooser).</p>
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 p-3 bg-red-50 dark:bg-red-500/15 border border-red-200 dark:border-red-500/30 rounded-lg" role="alert">
          <AlertCircle className="w-4 h-4 text-red-600 dark:text-red-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-red-800 dark:text-red-200">{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 p-3 bg-emerald-50 dark:bg-emerald-500/15 border border-emerald-200 dark:border-emerald-500/30 rounded-lg" role="status">
          <CheckCircle className="w-4 h-4 text-emerald-600 dark:text-emerald-300 mt-0.5 flex-shrink-0" />
          <span className="text-sm text-emerald-800 dark:text-emerald-200">{notice}</span>
        </div>
      )}

      {rows === null ? (
        <div className="p-6 text-center text-muted-foreground/75"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : rows.length === 0 ? (
        <div className="bg-muted/50 border border-border rounded-lg p-6 text-center text-sm text-muted-foreground flex items-center justify-center gap-2" data-testid="held-empty">
          <Inbox className="w-4 h-4 text-muted-foreground/75" aria-hidden="true" />
          Nothing waiting — every inbound email found its ticket.
        </div>
      ) : (
        <ul className="bg-card border border-border rounded-lg divide-y divide-border/60" data-testid="held-list">
          {rows.map((row) => {
            const busy = busyId === row.id;
            const candidates = candidatesFor(row);
            return (
              <li key={row.id} className="px-4 py-3 space-y-2" data-testid={`held-row-${row.id}`}>
                <div className="flex flex-wrap items-center gap-2">
                  <ReasonChip reason={row.reason} />
                  <span className="text-xs text-muted-foreground/75">{fmtWhen(row.receivedAt)}</span>
                  {row.connectionAddress && <span className="text-xs text-muted-foreground/75">· via {row.connectionAddress}</span>}
                  {row.bestGuessTicket && (
                    <Link
                      to={`/tickets/${row.bestGuessTicket.id}`}
                      className="ml-auto inline-flex items-center gap-1 text-xs text-primary hover:underline tp-focus-ring rounded"
                      title={row.bestGuessTicket.subject || ''}
                      data-testid="held-best-guess"
                    >
                      <Link2 className="w-3 h-3" aria-hidden="true" />
                      Best guess: {row.bestGuessTicket.displayRef}
                    </Link>
                  )}
                </div>
                <p className="text-sm font-medium text-foreground truncate">{row.subject || '(no subject)'}</p>
                <p className="text-xs text-muted-foreground break-words">
                  <span className="text-foreground/85">From</span> {row.fromName ? `${row.fromName} <${row.fromEmail}>` : row.fromEmail || '—'}
                  {row.toEmails?.length ? <> · <span className="text-foreground/85">To</span> {row.toEmails.join(', ')}</> : null}
                  {row.ccEmails?.length ? <> · <span className="text-foreground/85">Cc</span> {row.ccEmails.join(', ')}</> : null}
                </p>
                {row.snippet && <p className="text-xs text-muted-foreground/75 line-clamp-2">{row.snippet}</p>}

                <div className="flex flex-wrap items-center gap-2 pt-1">
                  {row.bestGuessTicket && (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => attach(row, row.bestGuessTicket)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-primary/30 bg-primary/10 text-primary hover:bg-primary/15 tp-focus-ring disabled:opacity-50"
                    >
                      <Link2 className="w-3 h-3" aria-hidden="true" /> Attach to {row.bestGuessTicket.displayRef}
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => { setAttaching(attaching === row.id ? null : row.id); setChoosing(null); }}
                    className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-border bg-card text-foreground hover:bg-muted tp-focus-ring disabled:opacity-50"
                  >
                    <Search className="w-3 h-3" aria-hidden="true" /> Attach to ticket…
                  </button>
                  {row.reason === 'agent_reply_no_requester' && candidates.length > 0 ? (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => { setChoosing(choosing === row.id ? null : row.id); setChosen(candidates[0] || ''); setAttaching(null); }}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-violet-200 bg-violet-50 text-violet-700 hover:bg-violet-100 dark:border-violet-500/30 dark:bg-violet-500/15 dark:text-violet-200 dark:hover:bg-violet-500/20 tp-focus-ring disabled:opacity-50"
                    >
                      <Plus className="w-3 h-3" aria-hidden="true" /> Create ticket for…
                    </button>
                  ) : (
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => create(row)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg border border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200 dark:hover:bg-emerald-500/20 tp-focus-ring disabled:opacity-50"
                    >
                      <Plus className="w-3 h-3" aria-hidden="true" /> Create ticket
                    </button>
                  )}
                  <button
                    type="button"
                    disabled={busy}
                    onClick={() => discard(row)}
                    aria-label={`Discard held message ${row.id}`}
                    className="ml-auto inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg text-muted-foreground/75 hover:text-red-600 dark:hover:text-red-300 hover:bg-red-50 dark:hover:bg-red-500/15 tp-focus-ring disabled:opacity-50"
                  >
                    {busy ? <Loader2 className="w-3 h-3 animate-spin" aria-hidden="true" /> : <Trash2 className="w-3 h-3" aria-hidden="true" />} Discard
                  </button>
                </div>

                {attaching === row.id && (
                  <TicketPicker onPick={(t) => attach(row, t)} onCancel={() => setAttaching(null)} />
                )}
                {choosing === row.id && (
                  <div className="mt-2 p-2 rounded-lg border border-border bg-muted/50 flex flex-wrap items-center gap-2" data-testid="held-requester-chooser">
                    <label className="text-xs text-muted-foreground" htmlFor={`held-requester-${row.id}`}>Create ticket for</label>
                    <select
                      id={`held-requester-${row.id}`}
                      value={chosen}
                      onChange={(e) => setChosen(e.target.value)}
                      className="text-sm bg-card border border-border rounded-md px-2 py-1.5"
                    >
                      {candidates.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button
                      type="button"
                      disabled={busy || !chosen}
                      onClick={() => create(row, chosen)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 tp-focus-ring disabled:opacity-50"
                    >
                      <Plus className="w-3 h-3" aria-hidden="true" /> Create
                    </button>
                    <button type="button" onClick={() => setChoosing(null)} className="text-xs text-muted-foreground hover:text-foreground tp-focus-ring rounded px-1">Cancel</button>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
