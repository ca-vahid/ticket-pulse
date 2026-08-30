import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
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
  const bgClass = tone === 'queue' ? 'bg-secondary text-muted-foreground' : 'bg-card text-foreground/85';

  if (photoUrl && !failed) {
    return (
      <img
        src={photoUrl}
        alt={name}
        title={name}
        className="w-5 h-5 rounded-full object-cover flex-shrink-0 border border-card shadow-sm"
        onError={() => setFailed(true)}
      />
    );
  }

  return (
    <div
      title={name}
      className={`w-5 h-5 rounded-full flex items-center justify-center flex-shrink-0 border border-card shadow-sm text-[8px] font-bold ${bgClass}`}
    >
      {initials(name)}
    </div>
  );
}

export default function TimelineEventRow({ event, showFullDate }) {
  const location = useLocation();
  // Ticket Pulse's own ticket page is the primary destination (subject link);
  // FS is demoted to the small external icon. `state.from` gives /tickets/:id
  // a return address back to this exact timeline view.
  const internalHref = event.ticketId ? `/tickets/${event.ticketId}` : null;
  const linkState = { from: `${location.pathname}${location.search}` };
  const isRejected = event.eventType === 'rejected';
  const Icon = isRejected ? RotateCcw : GitBranch;
  const fromName = event.fromTechName || 'Previous holder';
  const toName = isRejected ? 'Queue' : event.toTechName || 'Next holder';

  return (
    <div className={`border rounded overflow-hidden ${
      isRejected
        ? 'bg-red-50/80 dark:bg-red-500/10 border-red-200 dark:border-red-500/30'
        : 'bg-amber-50/80 dark:bg-amber-500/10 border-amber-200 dark:border-amber-500/30'
    }`}>
      <div className="flex items-stretch">
        <div className={`w-1.5 flex-shrink-0 ${isRejected ? 'bg-red-500' : 'bg-amber-500'}`} />
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5 px-2 py-2 sm:py-1.5">
          <Icon className={`w-3.5 h-3.5 flex-shrink-0 ${isRejected ? 'text-red-600 dark:text-red-300' : 'text-amber-700 dark:text-amber-200'}`} />
          <span className={`text-muted-foreground text-[10px] flex-shrink-0 whitespace-nowrap ${showFullDate ? 'sm:w-[105px]' : 'sm:w-[68px]'}`}>
            {formatEventTime(event.createdAt, showFullDate)}
          </span>
          {event.freshserviceTicketId && (
            <a
              href={`https://${FRESHSERVICE_DOMAIN}/a/tickets/${event.freshserviceTicketId}`}
              target="_blank"
              rel="noopener noreferrer"
              title="Open in FreshService"
              className={`flex-shrink-0 ${internalHref ? 'text-muted-foreground/75 hover:text-blue-600 dark:hover:text-blue-300' : 'text-blue-600 dark:text-blue-300 hover:text-blue-800 dark:hover:text-blue-200'}`}
            >
              <ExternalLink className="w-3 h-3" />
            </a>
          )}
          <span className={`px-1.5 py-0.5 rounded text-[10px] font-semibold flex-shrink-0 ${
            isRejected
              ? 'bg-red-100 dark:bg-red-500/20 text-red-700 dark:text-red-200 border border-red-200 dark:border-red-500/30'
              : 'bg-amber-100 dark:bg-amber-500/20 text-amber-800 dark:text-amber-200 border border-amber-200 dark:border-amber-500/30'
          }`}>
            {isRejected ? 'Rejected' : 'Handoff'}
          </span>
          {internalHref ? (
            <Link
              to={internalHref}
              state={linkState}
              title="Open in Ticket Pulse"
              className="order-first min-w-0 w-full font-medium text-sm text-foreground hover:underline hover:text-blue-700 dark:hover:text-blue-200 sm:order-none sm:w-auto sm:text-xs"
            >
              {event.subject}
            </Link>
          ) : (
            <span className="order-first min-w-0 w-full font-medium text-sm text-foreground sm:order-none sm:w-auto sm:text-xs">
              {event.subject}
            </span>
          )}
          <div className="flex min-w-0 flex-wrap items-center gap-1.5 flex-shrink-0">
            <EventAvatar name={fromName} photoUrl={event.fromTechPhotoUrl} />
            <span className="max-w-[90px] truncate text-[11px] font-semibold text-foreground/85 sm:max-w-[120px]" title={fromName}>
              {fromName}
            </span>
            <ArrowRight className={`w-3.5 h-3.5 flex-shrink-0 ${isRejected ? 'text-red-500' : 'text-amber-600 dark:text-amber-300'}`} />
            <EventAvatar name={toName} photoUrl={event.toTechPhotoUrl} tone={isRejected ? 'queue' : undefined} />
            <span className="max-w-[90px] truncate text-[11px] font-semibold text-foreground/85 sm:max-w-[120px]" title={toName}>
              {toName}
            </span>
          </div>
          {event.by && (
            <span className="text-[10px] text-muted-foreground flex-shrink-0 truncate max-w-[140px]" title={`Changed by ${event.by}`}>
              by {event.by}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
