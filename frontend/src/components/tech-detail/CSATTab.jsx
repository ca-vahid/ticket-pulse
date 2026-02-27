import { useState } from 'react';
import { Star, User, ExternalLink, X } from 'lucide-react';
import { FRESHSERVICE_DOMAIN } from './constants';

// ── Score helpers ─────────────────────────────────────────────────────────────

function getCardTheme(score) {
  if (score >= 4) return 'border-emerald-200 bg-emerald-50/60';
  if (score === 3) return 'border-amber-200 bg-amber-50/50';
  if (score === 2) return 'border-orange-200 bg-orange-50/40';
  return 'border-red-200 bg-red-50/40';
}

function getScoreColor(score) {
  if (score >= 4) return 'text-emerald-700';
  if (score === 3) return 'text-amber-700';
  if (score === 2) return 'text-orange-700';
  return 'text-red-700';
}

function getEmoji(score) {
  if (score >= 4) return '😊';
  if (score === 3) return '😐';
  if (score === 2) return '😕';
  return '😞';
}

function formatDate(dateString) {
  if (!dateString) return 'N/A';
  return new Date(dateString).toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
}

// ── Stars ─────────────────────────────────────────────────────────────────────

function Stars({ score, total, size = 'sm' }) {
  const sizeClass = size === 'lg' ? 'w-7 h-7' : 'w-3.5 h-3.5';
  return (
    <div className="flex items-center gap-0.5">
      {Array.from({ length: total }, (_, i) => i + 1).map((i) => (
        <Star
          key={i}
          className={`${sizeClass} ${i <= score ? 'text-amber-400 fill-amber-400' : 'text-slate-200'}`}
        />
      ))}
    </div>
  );
}

// ── CSAT Card ─────────────────────────────────────────────────────────────────

function CSATCard({ ticket, onExpand }) {
  const score = ticket.csatScore || 0;
  const totalScore = ticket.csatTotalScore || 4;
  const hasFeedback = ticket.csatFeedback && ticket.csatFeedback.length > 0;
  const isLongFeedback = hasFeedback && ticket.csatFeedback.length > 150;

  return (
    <div className={`rounded-xl border shadow-sm hover:shadow-md transition-all p-3 flex flex-col ${getCardTheme(score)}`}>
      {/* Header */}
      <div className="flex items-center justify-between mb-2">
        <a
          href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
          target="_blank"
          rel="noopener noreferrer"
          className="text-blue-600 hover:text-blue-800 font-bold text-xs flex items-center gap-1"
        >
          #{ticket.freshserviceTicketId}
          <ExternalLink className="w-2.5 h-2.5" />
        </a>
        <span className="text-[10px] text-slate-400">{formatDate(ticket.csatSubmittedAt)}</span>
      </div>

      {/* Subject */}
      <h3 className="font-medium text-slate-800 mb-2 line-clamp-1 leading-tight text-xs">
        {ticket.subject}
      </h3>

      {/* Rating row */}
      <div className="flex items-center justify-between mb-2 py-1.5 border-y border-slate-200/60">
        <Stars score={score} total={totalScore} />
        <div className="flex items-center gap-2">
          <span className="text-xl">{getEmoji(score)}</span>
          <span className={`text-lg font-bold ${getScoreColor(score)}`}>
            {score}/{totalScore}
          </span>
        </div>
      </div>

      {/* Feedback */}
      {hasFeedback && (
        <div className="mt-1">
          <div className="text-[9px] font-bold text-slate-400 mb-1 uppercase tracking-wide">Feedback</div>
          <div className="text-xs text-slate-600 italic leading-snug bg-white/50 rounded-lg p-2 border border-slate-200/50">
            <span className={isLongFeedback ? 'line-clamp-2' : ''}>
              &ldquo;{ticket.csatFeedback}&rdquo;
            </span>
            {isLongFeedback && (
              <button
                onClick={(e) => { e.stopPropagation(); onExpand(ticket); }}
                className="mt-1 text-blue-600 hover:text-blue-800 font-semibold text-[10px] underline block"
              >
                Read more
              </button>
            )}
          </div>
        </div>
      )}

      {/* Requester */}
      {ticket.requesterName && (
        <div className="mt-auto pt-2 border-t border-slate-200/50 mt-2">
          <div className="flex items-center gap-1.5 text-[10px] text-slate-500">
            <User className="w-3 h-3" />
            <span className="font-medium truncate">{ticket.requesterName}</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ── Feedback Modal ────────────────────────────────────────────────────────────

function FeedbackModal({ ticket, onClose }) {
  if (!ticket) return null;
  const score = ticket.csatScore || 0;
  const totalScore = ticket.csatTotalScore || 4;

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm z-50 flex items-center justify-center p-4"
      onClick={onClose}
    >
      <div
        className="bg-white rounded-2xl shadow-2xl max-w-2xl w-full max-h-[80vh] overflow-auto"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Modal header */}
        <div className="sticky top-0 bg-white border-b border-slate-200 px-6 py-4 flex items-start justify-between">
          <div>
            <div className="flex items-center gap-2 mb-1">
              <a
                href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${ticket.freshserviceTicketId}`}
                target="_blank"
                rel="noopener noreferrer"
                className="text-blue-600 hover:text-blue-800 font-bold flex items-center gap-1 text-sm"
              >
                #{ticket.freshserviceTicketId}
                <ExternalLink className="w-3.5 h-3.5" />
              </a>
              <span className="text-xs text-slate-400">{formatDate(ticket.csatSubmittedAt)}</span>
            </div>
            <h3 className="font-semibold text-slate-900">{ticket.subject}</h3>
          </div>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 transition-colors p-1.5 ml-4">
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Modal body */}
        <div className="p-6">
          {/* Score display */}
          <div className="bg-slate-50 rounded-xl p-6 mb-6 text-center border border-slate-100">
            <div className="flex items-center justify-center mb-3">
              <Stars score={score} total={totalScore} size="lg" />
            </div>
            <div className="flex items-center justify-center gap-4">
              <span className="text-5xl">{getEmoji(score)}</span>
              <div>
                <div className={`text-5xl font-bold ${getScoreColor(score)}`}>{score}/{totalScore}</div>
                {ticket.csatRatingText && (
                  <div className="text-sm text-slate-500 uppercase font-semibold mt-1">
                    {ticket.csatRatingText}
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Full feedback */}
          {ticket.csatFeedback && (
            <div className="mb-6">
              <h4 className="text-xs font-bold text-slate-500 mb-2 uppercase tracking-wider">Customer Feedback</h4>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-4">
                <p className="text-slate-700 italic leading-relaxed whitespace-pre-wrap text-sm">
                  &ldquo;{ticket.csatFeedback}&rdquo;
                </p>
              </div>
            </div>
          )}

          {/* Requester */}
          {ticket.requesterName && (
            <div className="bg-slate-50 rounded-xl p-4 border border-slate-100">
              <div className="flex items-center gap-2 text-sm">
                <User className="w-4 h-4 text-slate-400" />
                <span className="font-semibold text-slate-800">{ticket.requesterName}</span>
                {ticket.requesterEmail && (
                  <span className="text-slate-400">· {ticket.requesterEmail}</span>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Modal footer */}
        <div className="border-t border-slate-200 px-6 py-4 bg-slate-50 flex justify-end rounded-b-2xl">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-lg font-medium transition-colors text-sm"
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────────

export default function CSATTab({ tickets, isLoading }) {
  const [expandedTicket, setExpandedTicket] = useState(null);

  if (isLoading) {
    return (
      <div className="text-center py-12">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-amber-500 mx-auto mb-3" />
        <p className="text-slate-400 text-sm">Loading CSAT responses…</p>
      </div>
    );
  }

  if (!tickets || tickets.length === 0) {
    return (
      <div className="text-center py-12">
        <Star className="w-8 h-8 text-slate-200 mx-auto mb-2" />
        <p className="text-slate-400 text-sm">No customer satisfaction responses recorded for this agent.</p>
      </div>
    );
  }

  return (
    <>
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
        {tickets.map((ticket) => (
          <CSATCard key={ticket.id} ticket={ticket} onExpand={setExpandedTicket} />
        ))}
      </div>
      {expandedTicket && (
        <FeedbackModal ticket={expandedTicket} onClose={() => setExpandedTicket(null)} />
      )}
    </>
  );
}
