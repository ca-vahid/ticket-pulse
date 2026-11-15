import { useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AtSign } from 'lucide-react';
import { formatPacificWhen } from '../../utils/ticketDates';

/**
 * The @ mark on a ticket row that mentions me (MEGA 11-14 Part H).
 *
 * One small icon, no pill: blue while a mention is not opened yet, quiet once
 * seen. Hovering (or focusing) it shows who mentioned me and when — the three
 * newest, Pacific time. The data comes with the list (`ticket.mentionsOfMe`,
 * one query per page), so the mark costs no request of its own.
 *
 * The card is drawn in a portal at a fixed position so the row's overflow
 * never clips it. `open` forces it shown (screenshots, tests).
 */
function mentionLines(mentions) {
  return (mentions?.latest || []).map((m) => ({
    by: m.by || 'A colleague',
    when: formatPacificWhen(m.at),
    seen: Boolean(m.seen),
  }));
}

function mentionLabel(mentions) {
  const lines = mentionLines(mentions);
  if (!lines.length) return '';
  const first = lines[0];
  const more = lines.length > 1 ? ` and ${lines.length - 1} more` : '';
  const unseen = Number(mentions?.unseen) || 0;
  return `Mentioned you: ${first.by}, ${first.when}${more}${unseen ? ` · ${unseen} not opened yet` : ''}`;
}

function Card({ mentions, style, className = '' }) {
  const lines = mentionLines(mentions);
  const unseen = Number(mentions?.unseen) || 0;
  return (
    <div
      role="tooltip"
      data-testid="mention-card"
      style={style}
      className={`z-[300] w-64 rounded-lg border border-border bg-card p-2.5 text-left shadow-soft ${className}`}
    >
      <p className="mb-1.5 flex items-center gap-1.5 text-[11px] font-semibold text-foreground">
        <AtSign className="h-3.5 w-3.5 text-blue-500 dark:text-blue-300" aria-hidden="true" />
        Mentioned you
        {unseen > 0 && <span className="ml-auto font-medium text-blue-600 dark:text-blue-300">{unseen} not opened yet</span>}
      </p>
      <ul className="space-y-1">
        {lines.map((l, i) => (
          <li key={`${l.by}-${i}`} className="flex items-baseline gap-1.5 text-xs">
            <span aria-hidden="true" className={`mt-1 h-1.5 w-1.5 flex-none rounded-full ${l.seen ? 'bg-muted-foreground/40' : 'bg-blue-500'}`} />
            <span className="min-w-0 flex-1">
              <span className="font-medium text-foreground">{l.by}</span>
              <span className="text-muted-foreground"> · {l.when}</span>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MentionMark({ mentions, open = false, className = '' }) {
  const ref = useRef(null);
  const [rect, setRect] = useState(null);
  if (!mentions?.latest?.length) return null;
  const unseen = Number(mentions.unseen) > 0;
  const label = mentionLabel(mentions);
  const show = () => {
    const r = ref.current?.getBoundingClientRect?.();
    if (r) setRect({ left: r.left, top: r.bottom, right: r.right });
  };
  const hide = () => setRect(null);
  const fixedStyle = rect && typeof window !== 'undefined'
    ? { position: 'fixed', top: Math.round(rect.top + 6), left: Math.round(Math.min(rect.left - 8, (window.innerWidth || 1024) - 272)) }
    : null;
  return (
    <span
      ref={ref}
      tabIndex={0}
      aria-label={label}
      data-testid="mention-mark"
      data-unseen={unseen ? 'true' : 'false'}
      onMouseEnter={show}
      onMouseLeave={hide}
      onFocus={show}
      onBlur={hide}
      onClick={(e) => e.stopPropagation()}
      className={`tp-focus-ring relative inline-flex shrink-0 items-center rounded ${unseen ? 'text-blue-600 dark:text-blue-300' : 'text-muted-foreground/70'} ${className}`}
    >
      <AtSign className="h-3.5 w-3.5" aria-hidden="true" />
      {fixedStyle && typeof document !== 'undefined'
        ? createPortal(<Card mentions={mentions} style={fixedStyle} />, document.body)
        : open && <Card mentions={mentions} className="absolute left-0 top-full mt-1.5" />}
    </span>
  );
}
