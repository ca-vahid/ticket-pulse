import { Ticket as TicketIcon, Cloud, CloudOff, CloudUpload, UserRound } from 'lucide-react';
import { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS } from '../tech-detail/constants';

export { PRIORITY_STRIP_COLORS, PRIORITY_LABELS, STATUS_COLORS };

export function timeAgo(value) {
  if (!value) return '—';
  const date = new Date(value);
  const seconds = Math.round((Date.now() - date.getTime()) / 1000);
  if (Number.isNaN(seconds)) return '—';
  if (seconds < 45) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: date.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' });
}

export function initials(name) {
  return String(name || '?')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0])
    .join('')
    .toUpperCase() || '?';
}

export function StatusPill({ status, className = '' }) {
  const tone = STATUS_COLORS[status] || 'bg-slate-100 text-slate-600 border border-slate-200';
  return (
    <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold whitespace-nowrap ${tone} ${className}`}>
      {status}
    </span>
  );
}

export function PriorityDot({ priority, withLabel = false }) {
  const color = PRIORITY_STRIP_COLORS[priority] || 'bg-slate-300';
  const label = PRIORITY_LABELS[priority] || `P${priority}`;
  return (
    <span className="inline-flex items-center gap-1.5" title={`Priority: ${label}`}>
      <span aria-hidden="true" className={`w-2 h-2 rounded-full ${color}`} />
      {withLabel && <span className="text-xs font-medium text-slate-600">{label}</span>}
      {!withLabel && <span className="sr-only">{label} priority</span>}
    </span>
  );
}

/** Where a ticket was born: Ticket Pulse or FreshService. */
export function OriginChip({ origin }) {
  if (origin === 'ticketpulse') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-sky-50 text-sky-700 border border-sky-200">
        <TicketIcon className="w-3 h-3" aria-hidden="true" />
        Ticket Pulse
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200">
      FreshService
    </span>
  );
}

/** Fallback-mirror state for TP-born tickets. */
export function MirrorChip({ ticket }) {
  if (ticket?.origin !== 'ticketpulse') return null;
  const state = ticket.mirrorState;
  if (state === 'mirrored') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-50 text-emerald-700 border border-emerald-200" title="A fallback copy exists in FreshService">
        <Cloud className="w-3 h-3" aria-hidden="true" /> Mirrored
      </span>
    );
  }
  if (state === 'error') {
    return (
      <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-red-50 text-red-700 border border-red-200" title={ticket.mirrorError || 'Mirroring to FreshService failed'}>
        <CloudOff className="w-3 h-3" aria-hidden="true" /> Mirror error
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-slate-50 text-slate-500 border border-slate-200" title="Queued for the FreshService fallback mirror (arrives with the mirror phase)">
      <CloudUpload className="w-3 h-3" aria-hidden="true" /> Mirror pending
    </span>
  );
}

export function PersonAvatar({ name, photoUrl, size = 'h-6 w-6', textSize = 'text-[10px]' }) {
  if (photoUrl) {
    return <img src={photoUrl} alt="" className={`${size} rounded-full object-cover ring-1 ring-slate-200`} />;
  }
  if (!name) {
    return (
      <span className={`${size} rounded-full bg-slate-100 text-slate-400 inline-flex items-center justify-center`}>
        <UserRound className="w-3.5 h-3.5" aria-hidden="true" />
      </span>
    );
  }
  return (
    <span className={`${size} rounded-full bg-blue-50 text-blue-700 border border-blue-100 inline-flex items-center justify-center font-semibold ${textSize}`}>
      {initials(name)}
    </span>
  );
}
