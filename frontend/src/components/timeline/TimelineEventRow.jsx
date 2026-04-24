import { useState } from 'react';
import { ArrowRight, ExternalLink, GitBranch, RotateCcw } from 'lucide-react';
import { FRESHSERVICE_DOMAIN } from './constants';

function formatEventTime(value, showFullDate) {
  const d = new Date(value);
  const time = d.toLocaleTimeString([], {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
    timeZone: 'America/Los_Angeles',
  });
  if (!showFullDate) {
    return `${d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' })} ${time}`;
  }
  const mo = d.toLocaleDateString('en-US', { month: 'numeric', timeZone: 'America/Los_Angeles' });
  const day = d.toLocaleDateString('en-US', { day: 'numeric', timeZone: 'America/Los_Angeles' });
  const wd = d.toLocaleDateString('en-US', { weekday: 'short', timeZone: 'America/Los_Angeles' });
  return `${mo}/${day} ${wd}. ${time}`;
}

function initials(name) {
  return (name || '?')
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part.charAt(0).toUpperCase())
    .join('') || '?';
}

function EventAvatar({ name, photoUrl, tone }) {
  const [failed, setFailed] = useState(false);
  const bgClass = tone === 'queue' ? 'bg-slate-200 text-slate-600' : 'bg-white text-slate-700';

  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt={name}
        title={name}
        className="w-5 h-5 rounded-full object-cover flex-shrink-0 border border-white shadow-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      title={name}
      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border border-white shadow-sm text-[8px] font-bold ${bgClass}`}
    >
      {initials(name)}
    </div>
  );
}

export default function TimelineEventRow({ event, showFullDate }) {
  const isRejected = event.eventType === 'rejected';
  const Icon = isRejected ? RotateCcw : GitBranch;
  const fromName = event.fromTechName || 'Previous holder';
  const toName = isRejected ? 'Queue' : event.toTechName || 'Next holder';

  return (
    <div className={`border rounded overflow-hidden ${
      isRejected
        ? 'bg-red-50/80 border-red-200'
        : 'bg-amber-50/80 border-amber-200'
    }`}>
      <div className="flex items-stretch">
        <div className={`w-1.5 flex-shrink-0 ${isRejected ? 'bg-red-500' : 'bg-amber-500'}`} />
        <div className="flex-1 px-2 py-1.5 flex items-center gap-1.5 min-w-0">
          <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isRejected ? 'text-red-600' : 'text-amber-700'}`} />
          <span className={`text-slate-500 text-[10px] flex-shrink-0 whitespace-nowrap ${showFullDate ? 'w-[105px]' : 'w-[68px]'}`}>
            {formatEventTime(event.createdAt, showFullDate)}
          </span>
          {event.freshserviceTicketId && (
            <a
              href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${event.freshserviceTicketId}`}
              target="_blank"
              rel="noopener noreferrer"
              className="text-blue-600 hover:text-blue-800 flex-shrink-0"
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${
            isRejected
              ? 'bg-red-100 text-red-700 border border-red-200'
              : 'bg-amber-100 text-amber-800 border border-amber-200'
          }`}>
            {isRejected ? 'Rejected' : 'Handoff'}
          </span>
          <span className="font-medium text-xs text-slate-900 truncate min-w-0">
            {event.subject}
          </span>
          <div className="flex items-center gap-1.5 flex-shrink-0 min-w-0">
            <EventAvatar name={fromName} photoUrl={event.fromTechPhotoUrl} />
            <span className="text-[11px] font-semibold text-slate-700 truncate max-w-[120px]" title={fromName}>
              {fromName}
            </span>
            <ArrowRight className={`w-3.5 h-3.5 flex-shrink-0 ${isRejected ? 'text-red-500' : 'text-amber-600'}`} />
            <EventAvatar name={toName} photoUrl={event.toTechPhotoUrl} tone={isRejected ? 'queue' : undefined} />
            <span className="text-[11px] font-semibold text-slate-700 truncate max-w-[120px]" title={toName}>
              {toName}
            </span>
          </div>
          {event.by && (
            <span className="text-[10px] text-slate-500 flex-shrink-0 truncate max-w-[140px]" title={`Changed by ${event.by}`}>
              by {event.by}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
