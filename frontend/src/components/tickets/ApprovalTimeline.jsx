import { useMemo, useState } from 'react';
import {
  Ban, CheckCircle2, ChevronRight, Clock, MessageCircleQuestion, RefreshCw, Send, Stamp, Trash2, XCircle,
} from 'lucide-react';
import { PersonAvatar, SafeHtml, formatDayTime, timeAgo } from './ticketUi';

// Per-approver / verdict status → color-coded look (dot, chip, text, header tint).
const STATUS = {
  approved: { label: 'Approved', verb: 'Approved', Icon: CheckCircle2, dot: 'bg-emerald-500', chip: 'bg-emerald-50 text-emerald-700 border-emerald-200', text: 'text-emerald-700', head: 'bg-emerald-50/70 border-emerald-100' },
  rejected: { label: 'Rejected', verb: 'Rejected', Icon: XCircle, dot: 'bg-red-500', chip: 'bg-red-50 text-red-700 border-red-200', text: 'text-red-700', head: 'bg-red-50/70 border-red-100' },
  info_requested: { label: 'Needs info', verb: 'Clarification requested', Icon: MessageCircleQuestion, dot: 'bg-violet-500', chip: 'bg-violet-50 text-violet-700 border-violet-200', text: 'text-violet-700', head: 'bg-violet-50/70 border-violet-100' },
  cancelled: { label: 'Cancelled', verb: 'Cancelled', Icon: Ban, dot: 'bg-slate-300', chip: 'bg-slate-100 text-slate-500 border-slate-200', text: 'text-slate-500', head: 'bg-slate-50 border-slate-100' },
  pending: { label: 'Pending', verb: 'Pending', Icon: Clock, dot: 'bg-amber-400', chip: 'bg-amber-50 text-amber-700 border-amber-200', text: 'text-amber-700', head: 'bg-amber-50/60 border-amber-100' },
};
const statusMeta = (s) => STATUS[s] || STATUS.pending;

// Any-one-approves: the group verdict is the strongest outcome present.
const VERDICT_ORDER = ['approved', 'rejected', 'info_requested', 'pending', 'cancelled'];
const groupVerdict = (rows) => VERDICT_ORDER.find((s) => rows.some((r) => r.status === s)) || 'pending';
// A decided group needs no interaction — collapse it to a one-line summary.
const TERMINAL = new Set(['approved', 'rejected', 'cancelled']);

// A cancelled row that was auto-cancelled by a sibling decision reads as
// "Superseded"; a requester-cancelled one stays "Cancelled".
const rowLabel = (ap) => {
  if (ap.status === 'cancelled' && /^superseded/i.test(ap.decisionNote || '')) return 'Superseded';
  return statusMeta(ap.status).label;
};

/**
 * Polished, grouped approval timeline. Each request (one category fanned out to
 * its managers, tied by requestGroupId) is one card: a header with the category,
 * overall verdict and requester, then a vertical rail of approver rows with live
 * status, decision notes, and the approver/requester actions.
 */
export default function ApprovalTimeline({
  approvals = [], meta, savingField,
  clarifyingId, setClarifyingId, clarifyNote, setClarifyNote,
  onDecide, onClarify, onResubmit, onCancel, onChangeDecision, onDeleteRequest,
}) {
  const actorEmail = String(meta?.actor?.email || '').toLowerCase();
  const actorIsAdmin = meta?.actor?.kind === 'admin' || meta?.actor?.workspaceRole === 'admin';
  // Requester replies to a needs-info question, keyed per approval row (QA 07-14 #1).
  const [resubmitNotes, setResubmitNotes] = useState({});
  const groups = useMemo(() => {
    const map = new Map();
    for (const ap of approvals) {
      const key = ap.requestGroupId || `single-${ap.id}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(ap);
    }
    for (const rows of map.values()) rows.sort((a, b) => a.id - b.id);
    return [...map.values()].sort((a, b) => new Date(b[0].createdAt) - new Date(a[0].createdAt));
  }, [approvals]);

  return (
    <ul className="space-y-3 mb-4">
      {groups.map((rows) => {
        const head = rows[0];
        const verdict = groupVerdict(rows);
        const vMeta = statusMeta(verdict);
        const category = head.approvalCategory?.name;
        const decided = TERMINAL.has(verdict);
        // The approver whose decision set the verdict (for the decided summary).
        const decider = decided ? (rows.find((r) => r.status === verdict) || null) : null;
        const otherCount = decider ? rows.length - 1 : 0;
        const groupBusy = savingField === `approval-${head.id}`;
        const canRequesterManage = actorIsAdmin || (actorEmail && head.requestedBy === actorEmail);
        const canChangeVerdict = decider && (actorIsAdmin || actorEmail === String(decider.approverEmail || '').toLowerCase());
        const flipTo = verdict === 'approved' ? 'rejected' : 'approved';
        return (
          <li key={head.requestGroupId || head.id} className="rounded-xl border border-slate-200 bg-white shadow-subtle overflow-hidden animate-fadeIn">
            {/* Group header — category + overall verdict, tinted to match */}
            <div className={`flex flex-wrap items-center gap-2 px-3.5 py-2.5 border-b ${vMeta.head}`}>
              <span className="inline-flex items-center justify-center h-6 w-6 rounded-lg bg-white/80 border border-white text-slate-500">
                <Stamp className="w-3.5 h-3.5" aria-hidden="true" />
              </span>
              {category && (
                <span className="text-sm font-semibold text-slate-800">{category}</span>
              )}
              <span className={`inline-flex items-center gap-1 text-[10px] font-bold uppercase tracking-wide rounded-full px-2 py-0.5 border ${vMeta.chip}`}>
                <vMeta.Icon className="w-3 h-3" aria-hidden="true" /> {vMeta.label}
              </span>
              <span className="ml-auto text-[11px] text-slate-400 whitespace-nowrap" title={new Date(head.createdAt).toLocaleString()}>
                {formatDayTime(head.createdAt)}
                {' · '}{timeAgo(head.createdAt)}
              </span>
            </div>

            {/* Decided → compact summary (who decided, when). No dated rail.
                Actions sit on the RIGHT so they read as secondary to the verdict. */}
            {decided ? (
              <div className="px-3.5 py-3 flex items-start gap-3">
                <div className="min-w-0 flex-1">
                  {decider ? (
                    <div className="flex items-center gap-2.5">
                      <div className="relative flex-shrink-0">
                        <PersonAvatar name={decider.approverName || decider.approverEmail} size="h-8 w-8" textSize="text-[10px]" />
                        <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${vMeta.dot} flex items-center justify-center`}>
                          <vMeta.Icon className="w-2 h-2 text-white" aria-hidden="true" />
                        </span>
                      </div>
                      <div className="min-w-0">
                        <p className="text-sm text-slate-700">
                          <span className={`font-semibold ${vMeta.text}`}>{vMeta.verb}</span> by <span className="font-semibold text-slate-800">{decider.approverName || decider.approverEmail}</span>
                          {decider.decidedAt && <span className="text-slate-400" title={new Date(decider.decidedAt).toLocaleString()}> · {formatDayTime(decider.decidedAt)} · {timeAgo(decider.decidedAt)}</span>}
                        </p>
                        <p className="text-[11px] text-slate-400">
                          Requested by {head.requestedBy}
                          {otherCount > 0 && <> · {otherCount} other approver{otherCount === 1 ? '' : 's'} auto-cancelled</>}
                        </p>
                      </div>
                    </div>
                  ) : (
                    <p className="text-sm text-slate-500">Cancelled · requested by {head.requestedBy}</p>
                  )}
                  {decider?.decisionNoteHtml && !/^superseded/i.test(decider.decisionNote || '') ? (
                    <div className="mt-1.5"><SafeHtml html={decider.decisionNoteHtml} className="text-xs text-slate-500" /></div>
                  ) : decider?.decisionNote && !/^superseded/i.test(decider.decisionNote) && (
                    <p className="text-xs text-slate-500 mt-1.5 italic">“{decider.decisionNote}”</p>
                  )}
                </div>
                {(canChangeVerdict || canRequesterManage) && (verdict === 'approved' || verdict === 'rejected') && (
                  <div className="flex flex-col items-end gap-1.5 flex-shrink-0">
                    {canChangeVerdict && (
                      <button
                        onClick={() => onChangeDecision?.({ approvalId: decider.id, from: verdict, to: flipTo, categoryName: category, approverName: decider.approverName || decider.approverEmail })}
                        disabled={groupBusy || savingField === `approval-${decider.id}`}
                        title={`Change this decision to ${flipTo}`}
                        className={`tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg border disabled:opacity-50 ${
                          flipTo === 'approved'
                            ? 'bg-white text-emerald-700 border-emerald-200 hover:bg-emerald-50'
                            : 'bg-white text-red-700 border-red-200 hover:bg-red-50'
                        }`}
                      >
                        <RefreshCw className="w-3 h-3" aria-hidden="true" /> Change to {flipTo}
                      </button>
                    )}
                    {canRequesterManage && (
                      <button
                        onClick={() => onDeleteRequest?.(head)}
                        disabled={groupBusy}
                        className="tp-focus-ring inline-flex items-center gap-1 px-2 py-1 text-[11px] font-medium rounded-lg text-slate-400 hover:bg-red-50 hover:text-red-600"
                      >
                        <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                      </button>
                    )}
                  </div>
                )}
              </div>
            ) : (
              <div className="px-3.5 py-3">
                <p className="text-xs text-slate-500">
                Requested by <span className="font-medium text-slate-600">{head.requestedBy}</span>
                  {rows.length > 1 && <span className="text-slate-400"> · {rows.length} approvers · any one decides</span>}
                </p>
                {head.requestNoteHtml ? (
                  <div className="mt-1 text-xs text-slate-500 border-l-2 border-slate-200 pl-2">
                    <SafeHtml html={head.requestNoteHtml} className="text-xs text-slate-500" />
                  </div>
                ) : head.requestNote && (
                  <p className="mt-1 text-xs text-slate-500 italic border-l-2 border-slate-200 pl-2">“{head.requestNote}”</p>
                )}

                {/* Approver rail */}
                <ol className="mt-3 space-y-3">
                  {rows.map((ap, i) => {
                    const sm = statusMeta(ap.status);
                    const isApprover = meta?.actor && (meta.actor.email === ap.approverEmail || meta.actor.kind === 'admin' || meta.actor.workspaceRole === 'admin');
                    const isRequester = meta?.actor && (meta.actor.email === ap.requestedBy || meta.actor.kind === 'admin' || meta.actor.workspaceRole === 'admin');
                    const busy = savingField === `approval-${ap.id}`;
                    const last = i === rows.length - 1;
                    return (
                      <li key={ap.id} className="relative flex gap-3">
                        {/* rail: avatar + status dot + connector */}
                        <div className="relative flex flex-col items-center">
                          <div className="relative">
                            <PersonAvatar name={ap.approverName || ap.approverEmail} size="h-8 w-8" textSize="text-[10px]" />
                            <span className={`absolute -bottom-0.5 -right-0.5 h-3.5 w-3.5 rounded-full border-2 border-white ${sm.dot} flex items-center justify-center`} title={sm.label}>
                              <sm.Icon className="w-2 h-2 text-white" aria-hidden="true" />
                            </span>
                          </div>
                          {!last && <span className="flex-1 w-px bg-slate-200 mt-1" aria-hidden="true" />}
                        </div>

                        <div className="min-w-0 flex-1 pb-0.5">
                          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                            <span className="text-sm font-medium text-slate-800 truncate">{ap.approverName || ap.approverEmail}</span>
                            <span className={`inline-flex items-center gap-1 text-[10px] font-semibold rounded-full px-1.5 py-0.5 border ${sm.chip}`}>
                              {rowLabel(ap)}
                            </span>
                            {ap.decidedAt && (
                              <span className="text-[11px] text-slate-400" title={new Date(ap.decidedAt).toLocaleString()}>{formatDayTime(ap.decidedAt)} · {timeAgo(ap.decidedAt)}</span>
                            )}
                          </div>
                          {ap.status === 'info_requested'
                            ? ap.decisionNote && <p className={`text-xs mt-0.5 ${sm.text}`}>Clarification needed: “{ap.decisionNote}”</p>
                            : ap.decisionNote && <p className="text-xs text-slate-500 mt-0.5">{ap.decisionNote}</p>}

                          {/* Answered clarifications survive resubmits — show the Q&A trail. */}
                          {Array.isArray(ap.clarificationLog) && ap.clarificationLog.some((c) => c?.answer) && (
                            <div className="mt-1.5 space-y-1">
                              {ap.clarificationLog.filter((c) => c?.answer).map((c, i) => (
                                <div key={i} className="text-[11px] rounded-lg border border-violet-100 bg-violet-50/50 px-2 py-1.5">
                                  {c.question && <p className="text-violet-700">Asked: “{c.question}”</p>}
                                  <p className="text-slate-600">Reply: “{c.answer}”</p>
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Approver actions (pending) */}
                          {ap.status === 'pending' && isApprover && (
                            clarifyingId === ap.id ? (
                              <div className="mt-2 space-y-1.5">
                                <textarea
                                  rows={2}
                                  autoFocus
                                  value={clarifyNote}
                                  onChange={(e) => setClarifyNote(e.target.value)}
                                  placeholder="What extra info do you need from the requester?"
                                  className="tp-focus-ring w-full text-xs bg-white border border-violet-200 rounded-lg px-2.5 py-1.5 placeholder:text-slate-400 resize-y"
                                />
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={() => { const n = clarifyNote.trim(); if (n) onClarify(ap.id, n); }}
                                    disabled={busy || !clarifyNote.trim()}
                                    className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700 disabled:opacity-50"
                                  >
                                    <Send className="w-3 h-3" aria-hidden="true" /> Send to requester
                                  </button>
                                  <button onClick={() => { setClarifyingId(null); setClarifyNote(''); }} className="tp-focus-ring px-2 py-1 text-[11px] font-medium rounded-lg text-slate-500 hover:bg-slate-100">Cancel</button>
                                </div>
                              </div>
                            ) : (
                              <div className="flex items-center gap-1.5 mt-2 flex-wrap">
                                <button
                                  onClick={() => onDecide(ap.id, 'approved')}
                                  disabled={busy}
                                  className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                                >
                                  <CheckCircle2 className="w-3 h-3" aria-hidden="true" /> Approve
                                </button>
                                <button
                                  onClick={() => onDecide(ap.id, 'rejected')}
                                  disabled={busy}
                                  className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-red-600 text-white hover:bg-red-700 disabled:opacity-50"
                                >
                                  <XCircle className="w-3 h-3" aria-hidden="true" /> Reject
                                </button>
                                <button
                                  onClick={() => { setClarifyingId(ap.id); setClarifyNote(''); }}
                                  disabled={busy}
                                  className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-white text-violet-700 border border-violet-200 hover:bg-violet-50 disabled:opacity-50"
                                >
                                  <MessageCircleQuestion className="w-3 h-3" aria-hidden="true" /> Clarify
                                </button>
                              </div>
                            )
                          )}

                          {/* Requester actions: type the requested info right here,
                              it travels with the resubmit (QA 07-14 #1). */}
                          {ap.status === 'info_requested' && isRequester && (
                            <div className="mt-2 space-y-1.5">
                              <textarea
                                rows={2}
                                value={resubmitNotes[ap.id] || ''}
                                onChange={(e) => setResubmitNotes((m) => ({ ...m, [ap.id]: e.target.value }))}
                                placeholder="Reply with the requested info — sent to the approver with the resubmit…"
                                className="tp-focus-ring w-full text-xs bg-white border border-violet-200 rounded-lg px-2.5 py-1.5 placeholder:text-slate-400 resize-y"
                              />
                              <div className="flex items-center gap-1.5 flex-wrap">
                                <button
                                  onClick={() => onResubmit(ap.id, (resubmitNotes[ap.id] || '').trim() || null)}
                                  disabled={busy}
                                  className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-semibold rounded-lg bg-primary text-primary-foreground hover:bg-blue-700 disabled:opacity-50"
                                >
                                  <ChevronRight className="w-3 h-3" aria-hidden="true" /> Resubmit for approval
                                </button>
                                <span className="text-[11px] text-slate-400">Your reply is kept on the request and emailed to the approver.</span>
                              </div>
                            </div>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ol>

                {/* Group-level requester actions: cancel keeps an audit record;
                    delete removes it entirely (parent shows a warning first). */}
                {canRequesterManage && (
                  <div className="flex items-center gap-1.5 mt-3 pt-3 border-t border-slate-100">
                    <button
                      onClick={() => onCancel(head.id)}
                      disabled={groupBusy}
                      className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-slate-500 border border-slate-200 hover:bg-slate-100 disabled:opacity-50"
                    >
                      <Ban className="w-3 h-3" aria-hidden="true" /> Cancel request
                    </button>
                    <button
                      onClick={() => onDeleteRequest?.(head)}
                      disabled={groupBusy}
                      className="tp-focus-ring inline-flex items-center gap-1 px-2.5 py-1 text-[11px] font-medium rounded-lg text-slate-500 hover:bg-red-50 hover:text-red-600"
                    >
                      <Trash2 className="w-3 h-3" aria-hidden="true" /> Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
