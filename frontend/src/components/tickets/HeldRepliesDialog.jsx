import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link } from 'react-router-dom';
import {
  AlertCircle, ArrowRight, CheckCircle, Inbox, Info, Link2, Loader2, MailQuestion, Paperclip, Plus, Search, Trash2, X,
} from 'lucide-react';
import { ticketsAPI } from '../../services/api';
import { HOLD_REASON_META, ReasonChip, TicketPicker } from './HeldRepliesPanel';

/**
 * Unmatched replies, as a popup (Vahid, 17 Oct 2026). The pill used to unfold
 * a long card above the list with too little to decide on. Now: the waiting
 * emails on the left; on the right the selected one — why it is waiting in
 * plain words, the suggested ticket with the one-click choice, the other
 * choices, and the email itself in a sandboxed white frame (mail-client
 * convention, never inverted in dark mode). After a decision the next email
 * opens; when none are left it says so.
 */

function fmtWhen(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

function relative(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (!Number.isFinite(mins)) return '';
  if (mins < 60) return `${Math.max(1, mins)} min ago`;
  const h = Math.round(mins / 60);
  if (h < 48) return `${h} h ago`;
  return `${Math.round(h / 24)} d ago`;
}

/** Why this email is waiting, in plain words, with the details the hold recorded. */
function whyHeld(row) {
  const d = row?.decision?.details || {};
  const sender = d.sender || row?.fromEmail || 'the sender';
  switch (row?.reason) {
  case 'sender_burst':
    return `${sender} sent more than ${d.cap || 'the allowed number of'} new emails in a single mailbox check. To avoid a flood of tickets, Ticket Pulse opened tickets for the first ones and held the rest for a person to sort.`;
  case 'unknown_reference':
    return 'It looks like a reply, but the email it answers is not one Ticket Pulse sent or received, so it could not tell which ticket it belongs to.';
  case 'agent_reply_no_requester':
    return 'An agent sent this with the ticket mailbox copied, but no outside requester could be identified. Pick who the ticket is for.';
  case 'ambiguous_sender':
    return 'The sender could not be matched to one requester safely.';
  case 'ambiguous_ticket':
    return 'Two or more tickets match this sender and subject, so Ticket Pulse did not choose one for you.';
  case 'policy_replies_only':
    return 'This mailbox is set to never open new tickets from emails it cannot match.';
  case 'ingest_error':
    return 'Ticket Pulse tried to file it and the step failed. Nothing was lost.';
  default:
    return HOLD_REASON_META[row?.reason]?.help || 'It could not be filed automatically.';
  }
}

/** The email in a sandboxed frame: no scripts, links open in a new tab. */
function EmailFrame({ html, text }) {
  // Mail-client convention: white paper in light mode; in dark mode the same
  // dimmed slate the conversation's email wells use (.tp-rich-body--paper),
  // never pure white and never inverted.
  const dark = typeof document !== 'undefined' && document.documentElement.classList.contains('dark');
  const doc = useMemo(() => {
    const body = html || `<pre style="white-space:pre-wrap;font:13px/1.5 system-ui,sans-serif;margin:0">${String(text || '').replace(/&/g, '&amp;').replace(/</g, '&lt;')}</pre>`;
    return `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>body{margin:16px;font:14px/1.5 system-ui,-apple-system,Segoe UI,sans-serif;color:#0f172a;background:${dark ? '#dbe2ec' : '#ffffff'};word-wrap:break-word}img{max-width:100%;height:auto}table{max-width:100%}</style></head><body>${body}</body></html>`;
  }, [html, text, dark]);
  return (
    <iframe
      title="Email"
      sandbox="allow-popups allow-popups-to-escape-sandbox"
      srcDoc={doc}
      className="h-full min-h-[16rem] w-full rounded-lg border border-border"
      data-testid="held-email-frame"
    />
  );
}

export default function HeldRepliesDialog({ open, onClose, onCountChange = null }) {
  const [rows, setRows] = useState(null);
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [detailError, setDetailError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [notice, setNotice] = useState(null);
  const [attaching, setAttaching] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [chosen, setChosen] = useState('');
  const dialogRef = useRef(null);

  const load = useCallback(async (preferId = null) => {
    try {
      const res = await ticketsAPI.listHeldMessages('held');
      const list = res.data || [];
      setRows(list);
      onCountChange?.(res.meta?.heldCount ?? list.length);
      setSelectedId((cur) => {
        const keep = preferId ?? cur;
        return list.some((r) => r.id === keep) ? keep : (list[0]?.id ?? null);
      });
    } catch (err) {
      setError(err.response?.data?.message || err.message);
      setRows([]);
    }
  }, [onCountChange]);

  useEffect(() => {
    if (!open) return undefined;
    setNotice(null);
    setError(null);
    load();
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.(); };
    document.addEventListener('keydown', onKey);
    dialogRef.current?.focus();
    return () => document.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    setDetail(null);
    setDetailError(null);
    setAttaching(false);
    setChoosing(false);
    if (!open || !selectedId) return undefined;
    let alive = true;
    Promise.resolve()
      .then(() => ticketsAPI.getHeldMessage(selectedId))
      .then((res) => { if (alive) setDetail(res?.data?.data ?? res?.data ?? null); })
      .catch((err) => { if (alive) setDetailError(err.response?.data?.message || err.message); });
    return () => { alive = false; };
  }, [open, selectedId]);

  if (!open) return null;

  const row = detail && detail.id === selectedId ? detail : (rows || []).find((r) => r.id === selectedId) || null;
  const best = row?.bestGuessTicket || null;
  const candidates = (() => {
    if (!row) return [];
    const seen = new Set([String(row.connectionAddress || '').toLowerCase()]);
    const out = [];
    for (const a of [...(row.candidates || []), ...(row.toEmails || []), ...(row.ccEmails || []), row.fromEmail]) {
      const v = String(a || '').trim().toLowerCase();
      if (v && v.includes('@') && !seen.has(v)) { seen.add(v); out.push(v); }
    }
    return out;
  })();

  const run = async (fn, text) => {
    if (!row) return;
    const index = (rows || []).findIndex((r) => r.id === row.id);
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fn();
      setNotice(typeof text === 'function' ? text(res) : text);
      // Open the email that took this one's place in the list.
      const next = (rows || []).filter((r) => r.id !== row.id)[Math.max(0, index)] || null;
      await load(next?.id ?? null);
    } catch (err) {
      setError(err.response?.data?.message || err.message);
    } finally {
      setBusy(false);
    }
  };
  const attach = (ticket) => run(() => ticketsAPI.attachHeldMessage(row.id, ticket.id), `Added to ${ticket.displayRef} as a reply.`);
  const create = (requesterEmail = null) => run(
    () => ticketsAPI.createTicketFromHeld(row.id, requesterEmail ? { requesterEmail } : {}),
    (res) => `Created ${res?.data?.ticket?.displayRef || res?.data?.data?.ticket?.displayRef || 'a ticket'}${requesterEmail ? ` for ${requesterEmail}` : ''}.`,
  );
  const discard = () => run(() => ticketsAPI.discardHeldMessage(row.id), 'Discarded.');

  const count = rows?.length ?? 0;
  const btn = 'tp-focus-ring inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm font-semibold disabled:opacity-50';

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 animate-fadeIn" role="dialog" aria-modal="true" aria-labelledby="held-title">
      <div className="absolute inset-0 bg-slate-900/40 backdrop-blur-[2px]" onClick={() => !busy && onClose?.()} aria-hidden="true" />
      <div
        ref={dialogRef}
        tabIndex={-1}
        className="relative flex h-[min(86vh,52rem)] w-full max-w-6xl flex-col overflow-hidden rounded-xl border border-border bg-card shadow-soft"
        data-testid="held-dialog"
      >
        <div className="flex items-start gap-3 border-b border-border px-5 py-4">
          <span className="inline-flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg bg-amber-50 text-amber-600 dark:bg-amber-500/15 dark:text-amber-300">
            <MailQuestion className="h-5 w-5" aria-hidden="true" />
          </span>
          <div className="min-w-0 flex-1">
            <h2 id="held-title" className="text-base font-bold text-foreground">
              Unmatched replies{rows ? ` · ${count} waiting` : ''}
            </h2>
            <p className="mt-0.5 text-xs text-muted-foreground">
              Emails Ticket Pulse could not file on its own. For each one: add it to a ticket, open a new ticket, or discard it.
            </p>
          </div>
          <button type="button" onClick={() => !busy && onClose?.()} className="tp-focus-ring rounded-lg p-1.5 text-muted-foreground hover:bg-muted" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        {(error || notice) && (
          <div className={`flex items-center gap-2 border-b px-5 py-2 text-sm ${error ? 'border-red-200 bg-red-50 text-red-800 dark:border-red-500/30 dark:bg-red-500/15 dark:text-red-200' : 'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-500/30 dark:bg-emerald-500/15 dark:text-emerald-200'}`} role={error ? 'alert' : 'status'}>
            {error ? <AlertCircle className="h-4 w-4" aria-hidden="true" /> : <CheckCircle className="h-4 w-4" aria-hidden="true" />}
            {error || notice}
          </div>
        )}

        <div className="flex min-h-0 flex-1">
          {/* Left: the waiting emails */}
          <ul className="w-72 flex-shrink-0 overflow-y-auto settings-scrollbar border-r border-border bg-muted/30" aria-label="Waiting emails" data-testid="held-dialog-list">
            {rows === null && <li className="p-6 text-center text-muted-foreground"><Loader2 className="mx-auto h-5 w-5 animate-spin" aria-hidden="true" /></li>}
            {(rows || []).map((r) => {
              const on = r.id === selectedId;
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedId(r.id)}
                    aria-current={on ? 'true' : undefined}
                    className={`tp-focus-ring block w-full border-l-2 px-4 py-3 text-left ${on ? 'border-l-primary bg-card' : 'border-l-transparent hover:bg-card/70'}`}
                  >
                    <span className="flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
                      <span className="font-semibold text-amber-700 dark:text-amber-300">{HOLD_REASON_META[r.reason]?.label || r.reason}</span>
                      <span className="whitespace-nowrap">{relative(r.receivedAt)}</span>
                    </span>
                    <span className="mt-1 block truncate text-xs text-muted-foreground">{r.fromName || r.fromEmail || 'Unknown sender'}</span>
                    <span className="mt-0.5 line-clamp-2 text-sm font-medium text-foreground">{r.subject || '(no subject)'}</span>
                  </button>
                </li>
              );
            })}
          </ul>

          {/* Right: the selected email */}
          <div className="min-w-0 flex-1 overflow-y-auto settings-scrollbar">
            {rows && rows.length === 0 ? (
              <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center" data-testid="held-dialog-empty">
                <Inbox className="h-8 w-8 text-emerald-500" aria-hidden="true" />
                <p className="text-sm font-semibold text-foreground">Nothing is waiting</p>
                <p className="text-xs text-muted-foreground">Every email found its ticket.</p>
                <button type="button" onClick={onClose} className={`${btn} border border-border bg-card text-foreground hover:bg-muted`}>Close</button>
              </div>
            ) : row ? (
              <div className="flex min-h-full flex-col gap-4 p-5" data-testid="held-dialog-detail">
                <div>
                  <div className="flex flex-wrap items-center gap-2">
                    <ReasonChip reason={row.reason} />
                    <span className="text-xs text-muted-foreground">{fmtWhen(row.receivedAt)}{row.connectionAddress ? ` · to ${row.connectionAddress}` : ''}</span>
                    {detail?.hasAttachments && <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Paperclip className="h-3 w-3" aria-hidden="true" /> attachments</span>}
                  </div>
                  <h3 className="mt-2 text-lg font-semibold text-foreground [overflow-wrap:anywhere]">{row.subject || '(no subject)'}</h3>
                  <p className="mt-1 text-xs text-muted-foreground [overflow-wrap:anywhere]">
                    <span className="text-foreground/85">From</span> {row.fromName ? `${row.fromName} <${row.fromEmail}>` : row.fromEmail || '—'}
                    {row.toEmails?.length ? <> · <span className="text-foreground/85">To</span> {row.toEmails.join(', ')}</> : null}
                    {row.ccEmails?.length ? <> · <span className="text-foreground/85">Cc</span> {row.ccEmails.join(', ')}</> : null}
                  </p>
                </div>

                <div className="grid gap-3 lg:grid-cols-2">
                  <div className="rounded-lg border border-amber-200 bg-amber-50/70 p-3 dark:border-amber-500/30 dark:bg-amber-500/10" data-testid="held-why">
                    <p className="flex items-center gap-1.5 text-xs font-bold uppercase tracking-wide text-amber-800 dark:text-amber-200">
                      <Info className="h-3.5 w-3.5" aria-hidden="true" /> Why it is waiting
                    </p>
                    <p className="mt-1.5 text-sm text-foreground/85">{whyHeld(row)}</p>
                  </div>

                  <div className="rounded-lg border border-border p-3" data-testid="held-suggestion">
                    <p className="text-xs font-bold uppercase tracking-wide text-muted-foreground">
                      {best ? 'Probably belongs to' : 'No ticket suggested'}
                    </p>
                    {best ? (
                      <>
                        <Link to={`/tickets/${best.id}`} target="_blank" className="tp-focus-ring mt-1.5 block rounded text-sm font-semibold text-foreground hover:text-primary">
                          <span className="font-mono text-xs text-primary">{best.displayRef}</span> {best.subject}
                        </Link>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {best.status}{best.requesterName ? ` · ${best.requesterName}` : ''}{best.createdAt ? ` · opened ${fmtWhen(best.createdAt)}` : ''}{best.assigneeName ? ` · ${best.assigneeName}` : ''}
                        </p>
                        <button type="button" disabled={busy} onClick={() => attach(best)} className={`${btn} mt-2.5 bg-primary text-primary-foreground hover:bg-blue-700`} data-testid="held-attach-best">
                          {busy ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Link2 className="h-4 w-4" aria-hidden="true" />}
                          Add to {best.displayRef} as a reply
                        </button>
                      </>
                    ) : (
                      <p className="mt-1.5 text-sm text-muted-foreground">Find the ticket it belongs to, or open a new one.</p>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap items-center gap-2" data-testid="held-other-choices">
                  <button type="button" disabled={busy} onClick={() => { setAttaching((v) => !v); setChoosing(false); }} className={`${btn} border border-border bg-card text-foreground hover:bg-muted`}>
                    <Search className="h-4 w-4" aria-hidden="true" /> Add to another ticket…
                  </button>
                  {row.reason === 'agent_reply_no_requester' && candidates.length > 0 ? (
                    <button type="button" disabled={busy} onClick={() => { setChoosing((v) => !v); setChosen(candidates[0] || ''); setAttaching(false); }} className={`${btn} border border-border bg-card text-foreground hover:bg-muted`}>
                      <Plus className="h-4 w-4" aria-hidden="true" /> New ticket for…
                    </button>
                  ) : (
                    <button type="button" disabled={busy} onClick={() => create()} className={`${btn} border border-border bg-card text-foreground hover:bg-muted`}>
                      <Plus className="h-4 w-4" aria-hidden="true" /> Open a new ticket
                    </button>
                  )}
                  <button type="button" disabled={busy} onClick={discard} className={`${btn} ml-auto text-muted-foreground hover:bg-red-50 hover:text-red-600 dark:hover:bg-red-500/15 dark:hover:text-red-300`} aria-label="Discard this email">
                    <Trash2 className="h-4 w-4" aria-hidden="true" /> Discard
                  </button>
                </div>
                {attaching && <TicketPicker onPick={(t) => attach(t)} onCancel={() => setAttaching(false)} />}
                {choosing && (
                  <div className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-muted/50 p-2" data-testid="held-dialog-chooser">
                    <label className="text-xs text-muted-foreground" htmlFor="held-dialog-requester">New ticket for</label>
                    <select id="held-dialog-requester" value={chosen} onChange={(e) => setChosen(e.target.value)} className="h-9 rounded-lg border border-border bg-card px-2 text-sm">
                      {candidates.map((c) => <option key={c} value={c}>{c}</option>)}
                    </select>
                    <button type="button" disabled={busy || !chosen} onClick={() => create(chosen)} className={`${btn} bg-primary text-primary-foreground hover:bg-blue-700`}>
                      <ArrowRight className="h-4 w-4" aria-hidden="true" /> Create
                    </button>
                    <button type="button" onClick={() => setChoosing(false)} className="tp-focus-ring rounded px-1 text-xs text-muted-foreground hover:text-foreground">Cancel</button>
                  </div>
                )}

                <div className="flex min-h-[18rem] flex-1 flex-col">
                  <p className="mb-1.5 text-xs font-bold uppercase tracking-wide text-muted-foreground">The email</p>
                  {detailError ? (
                    <p className="text-sm text-red-600 dark:text-red-300">{detailError}</p>
                  ) : detail && detail.id === row.id ? (
                    <EmailFrame html={detail.bodyHtml} text={detail.bodyText} />
                  ) : (
                    <div className="flex flex-1 items-center justify-center rounded-lg border border-border"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" aria-hidden="true" /></div>
                  )}
                </div>

                <details className="text-xs text-muted-foreground">
                  <summary className="cursor-pointer select-none font-semibold text-foreground/85">How agents should send email to the ticket mailbox</summary>
                  <ol className="mt-1.5 list-decimal space-y-0.5 pl-4">
                    <li><b>Forward</b> the email to the ticket mailbox: the original sender stays the requester.</li>
                    <li><b>Reply all</b> with the ticket mailbox in <b>Cc</b>: the ticket is opened for the requester, your reply is the first response, and you are assigned.</li>
                  </ol>
                  <p className="mt-1">Never Bcc the mailbox, and do not copy it on emails between agents.</p>
                </details>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
