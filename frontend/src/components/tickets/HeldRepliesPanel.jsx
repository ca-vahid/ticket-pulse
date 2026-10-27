import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  AlertCircle, CheckCircle, Inbox, Link2, Loader2, MailQuestion, Plus, Search, Trash2,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import HeldDeviceGroup, { BURST_MODE_META } from './HeldDeviceGroup';
import { TicketPicker } from './HeldTicketPicker';

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
  // 17 Oct 2026: the three reasons the helpdesk mailbox added had no wording
  // and showed their raw codes ("sender_burst").
  ambiguous_ticket: {
    label: 'Two tickets match',
    tone: 'sky',
    help: 'Two or more tickets match this sender and subject, so Ticket Pulse did not pick one for you.',
  },
  sender_burst: {
    label: 'Burst from one sender',
    tone: 'amber',
    help: 'One sender sent more new emails in a single check than the limit, so the extra ones were held instead of each opening a ticket.',
  },
  ingest_error: {
    label: 'Could not file',
    tone: 'slate',
    help: 'Creating the ticket or adding the reply failed. Nothing was lost; a person decides.',
  },
};

const TONE = {
  amber: 'bg-amber-50 text-amber-700 border-amber-200 dark:bg-amber-500/15 dark:text-amber-200 dark:border-amber-500/30',
  violet: 'bg-violet-50 text-violet-700 border-violet-200 dark:bg-violet-500/15 dark:text-violet-200 dark:border-violet-500/30',
  sky: 'bg-sky-50 text-sky-700 border-sky-200 dark:bg-sky-500/15 dark:text-sky-200 dark:border-sky-500/30',
  slate: 'bg-muted text-muted-foreground border-border',
};

export function ReasonChip({ reason }) {
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

export { TicketPicker } from './HeldTicketPicker';

/**
 * The queue as { groups, singles, total, mode }: alert bursts grouped by
 * device when the server offers that (QA 10-26 #3), the flat list otherwise.
 */
export async function loadHeldQueue() {
  try {
    if (typeof ticketsAPI.listHeldGroups === 'function') {
      const res = await ticketsAPI.listHeldGroups();
      const data = res?.data;
      if (data && Array.isArray(data.groups) && Array.isArray(data.singles)) {
        const total = data.total ?? (data.singles.length + data.groups.reduce((n, g) => n + (g.count || 0), 0));
        return { groups: data.groups, singles: data.singles, total, mode: data.mode || null };
      }
    }
  } catch {
    // An older server without the grouped list: fall through to the flat one.
  }
  const res = await ticketsAPI.listHeldMessages('held');
  const list = res.data || [];
  return { groups: [], singles: list, total: res.meta?.heldCount ?? list.length, mode: null };
}

/** "Repeat alerts in a burst" — the per-workspace switch (admins). */
function BurstModeControl({ mode, onChange, busy }) {
  if (!mode) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground" data-testid="held-burst-mode">
      <label htmlFor="held-burst-mode" className="font-medium text-foreground">Repeat alerts in a burst</label>
      <select
        id="held-burst-mode"
        value={mode}
        disabled={busy}
        onChange={(e) => onChange(e.target.value)}
        className="h-8 rounded-md border border-input bg-card px-2 text-xs text-foreground tp-focus-ring"
      >
        {Object.entries(BURST_MODE_META).map(([value, meta]) => <option key={value} value={value}>{meta.label}</option>)}
      </select>
      <span className="min-w-0 flex-1">{BURST_MODE_META[mode]?.help}</span>
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
  const [groups, setGroups] = useState([]);
  const [mode, setMode] = useState(null);
  const [groupBusy, setGroupBusy] = useState(null); // sender whose bulk action is running

  const load = useCallback(async () => {
    try {
      const queue = await loadHeldQueue();
      setRows(queue.singles);
      setGroups(queue.groups);
      setMode(queue.mode);
      setError(null);
      onCountChange?.(queue.total);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setRows([]);
      setGroups([]);
    }
  }, [onCountChange]);

  useEffect(() => { load(); }, [load]);

  const bulk = async (group, ids, action, ticket) => {
    setGroupBusy(group.sender);
    setError(null);
    setNotice(null);
    try {
      const res = await ticketsAPI.bulkHeldMessages(ids, action, ticket?.id || null);
      const n = res?.data?.count ?? ids.length;
      setNotice(action === 'discard'
        ? `Discarded ${n} ${n === 1 ? 'email' : 'emails'} from ${group.device}.`
        : `Added ${n} ${n === 1 ? 'email' : 'emails'} from ${group.device} to ${ticket?.displayRef || 'the ticket'}.`);
      await load();
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setGroupBusy(null);
    }
  };

  const changeMode = async (next) => {
    const before = mode;
    setMode(next);
    try {
      await ticketsAPI.setBurstGrouping(next);
      setNotice(`Repeat alerts in a burst: ${BURST_MODE_META[next]?.label || next}.`);
    } catch (err) {
      setMode(before);
      setError(err.response?.data?.message || err.message);
    }
  };

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
              Emails Ticket Pulse could not file on its own: replies to a conversation it does not know, agent mail with no
              identifiable requester, and alert bursts from one device (grouped by device below). Decide what each one is.
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

      {!compact && <BurstModeControl mode={mode} onChange={changeMode} busy={Boolean(groupBusy)} />}

      {groups.length > 0 && (
        <ul className="space-y-3" aria-label="Alert bursts by device" data-testid="held-groups">
          {groups.map((g) => (
            <li key={g.sender} className="bg-card border border-border rounded-lg p-4">
              <HeldDeviceGroup group={g} mode={mode || 'shadow'} busy={groupBusy === g.sender} onBulk={(ids, action, ticket) => bulk(g, ids, action, ticket)} />
            </li>
          ))}
        </ul>
      )}

      {rows === null ? (
        <div className="p-6 text-center text-muted-foreground/75"><Loader2 className="w-5 h-5 animate-spin mx-auto" /></div>
      ) : rows.length === 0 && groups.length > 0 ? null : rows.length === 0 ? (
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
