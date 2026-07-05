import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Activity, AlertCircle, CheckCircle2, MessageCircleQuestion, ShieldCheck, XCircle } from 'lucide-react';
import { publicApprovalAPI } from '../services/api';

/**
 * Public approval decision page (magic link — no login).
 * Self-contained styling like the other /public token pages.
 */
export default function PublicApprovalDecision() {
  const { token } = useParams();
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [isLoading, setIsLoading] = useState(true);
  const [note, setNote] = useState('');
  const [deciding, setDeciding] = useState(null);
  const [decided, setDecided] = useState(null);

  useEffect(() => {
    let cancelled = false;
    publicApprovalAPI.get(token)
      .then((res) => { if (!cancelled) { setData(res.data); setError(null); } })
      .catch((err) => { if (!cancelled) setError(err.response?.data?.message || 'This approval link is not valid.'); })
      .finally(() => { if (!cancelled) setIsLoading(false); });
    return () => { cancelled = true; };
  }, [token]);

  const decide = async (decision) => {
    if (decision === 'clarify' && !note.trim()) {
      setError('Add a note so the requester knows what to provide.');
      return;
    }
    setDeciding(decision);
    setError(null);
    try {
      if (decision === 'clarify') await publicApprovalAPI.clarify(token, note.trim());
      else await publicApprovalAPI.decide(token, decision, note.trim() || null);
      setDecided(decision);
    } catch (err) {
      setError(err.response?.data?.message || 'Could not record your decision.');
    } finally {
      setDeciding(null);
    }
  };

  const approval = data?.approval;
  const ticket = data?.ticket;
  const alreadyDecided = approval && approval.status !== 'pending';

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-100 via-blue-50 to-slate-100 flex items-center justify-center p-4">
      <div className="w-full max-w-lg bg-white rounded-2xl shadow-xl border border-slate-100 overflow-hidden">
        <div className="px-6 py-4 bg-slate-900 text-white flex items-center gap-2.5">
          <ShieldCheck className="w-5 h-5 text-emerald-400" aria-hidden="true" />
          <div>
            <p className="text-sm font-bold">Approval requested</p>
            <p className="text-[11px] text-slate-300">{ticket?.workspaceName ? `${ticket.workspaceName} · ` : ''}Ticket Pulse</p>
          </div>
        </div>

        <div className="p-6">
          {isLoading ? (
            <div className="py-10 text-center">
              <Activity className="w-8 h-8 animate-spin mx-auto text-blue-600" aria-label="Loading" />
            </div>
          ) : error && !data ? (
            <div className="py-8 text-center">
              <AlertCircle className="w-9 h-9 text-red-400 mx-auto mb-2" aria-hidden="true" />
              <p className="text-slate-700 font-medium">{error}</p>
            </div>
          ) : (
            <>
              <p className="text-xs font-mono font-bold text-slate-400 mb-1">{ticket?.displayRef}</p>
              <h1 className="text-lg font-bold text-slate-900 leading-snug">{ticket?.subject || '(no subject)'}</h1>
              <p className="text-xs text-slate-500 mt-1">
                {ticket?.requesterName ? `Requested for ${ticket.requesterName} · ` : ''}
                status {ticket?.status}
              </p>
              {approval?.requestNote && (
                <div className="mt-3 p-3 bg-blue-50 border border-blue-100 rounded-lg text-sm text-slate-700">
                  <span className="font-semibold">{approval.requestedBy}:</span> {approval.requestNote}
                </div>
              )}
              {ticket?.summary && (
                <p className="mt-3 text-sm text-slate-600 whitespace-pre-wrap border-l-2 border-slate-200 pl-3">{ticket.summary}</p>
              )}

              <div className="mt-5">
                {decided === 'clarify' ? (
                  <div className="p-4 rounded-xl text-center font-semibold bg-violet-50 text-violet-700 border border-violet-200">
                    <MessageCircleQuestion className="w-6 h-6 mx-auto mb-1" aria-hidden="true" />
                    Sent back to the requester for more information.
                    <p className="text-xs font-normal mt-1 opacity-80">They’ll add the details and resubmit — you can close this page.</p>
                  </div>
                ) : decided || alreadyDecided ? (
                  <div className={`p-4 rounded-xl text-center font-semibold ${
                    (decided || approval.status) === 'approved'
                      ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                      : (decided || approval.status) === 'rejected'
                        ? 'bg-red-50 text-red-700 border border-red-200'
                        : 'bg-slate-50 text-slate-600 border border-slate-200'
                  }`}>
                    {(decided || approval.status) === 'approved' && <CheckCircle2 className="w-6 h-6 mx-auto mb-1" aria-hidden="true" />}
                    {(decided || approval.status) === 'rejected' && <XCircle className="w-6 h-6 mx-auto mb-1" aria-hidden="true" />}
                    This request {decided ? `is now ${decided}` : `was already ${approval.status}`}.
                    <p className="text-xs font-normal mt-1 opacity-80">The team has been notified — you can close this page.</p>
                  </div>
                ) : (
                  <>
                    <label htmlFor="approval-note" className="block text-xs font-semibold text-slate-500 mb-1">
                      Optional note
                    </label>
                    <textarea
                      id="approval-note"
                      rows={2}
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      placeholder="Context for your decision…"
                      className="w-full text-sm border border-slate-200 rounded-lg px-3 py-2 mb-3 focus:outline-none focus:ring-2 focus:ring-blue-500/40"
                    />
                    {error && (
                      <p className="text-sm text-red-600 mb-3" role="alert">{error}</p>
                    )}
                    <div className="grid grid-cols-2 gap-2.5">
                      <button
                        onClick={() => decide('approved')}
                        disabled={Boolean(deciding)}
                        className="py-3 rounded-xl bg-emerald-600 hover:bg-emerald-700 disabled:opacity-60 text-white font-bold text-sm"
                      >
                        {deciding === 'approved' ? 'Saving…' : 'Approve'}
                      </button>
                      <button
                        onClick={() => decide('rejected')}
                        disabled={Boolean(deciding)}
                        className="py-3 rounded-xl bg-red-600 hover:bg-red-700 disabled:opacity-60 text-white font-bold text-sm"
                      >
                        {deciding === 'rejected' ? 'Saving…' : 'Reject'}
                      </button>
                    </div>
                    <button
                      onClick={() => decide('clarify')}
                      disabled={Boolean(deciding)}
                      className="w-full mt-2.5 py-2.5 rounded-xl bg-white border border-violet-200 text-violet-700 hover:bg-violet-50 disabled:opacity-60 font-semibold text-sm inline-flex items-center justify-center gap-1.5"
                    >
                      <MessageCircleQuestion className="w-4 h-4" aria-hidden="true" />
                      {deciding === 'clarify' ? 'Sending…' : 'Request clarification'}
                    </button>
                    <p className="text-[11px] text-slate-400 mt-3 text-center">
                      This link was sent to {approval?.approverEmail} and expires {approval?.expiresAt ? new Date(approval.expiresAt).toLocaleDateString() : 'in 30 days'}.
                    </p>
                  </>
                )}
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
