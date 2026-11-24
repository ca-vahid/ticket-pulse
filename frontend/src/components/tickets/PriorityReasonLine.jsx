import { useId, useState } from 'react';
import { priorityReasonText } from '../../utils/priorityReason';

// A note longer than this (an AI rationale paragraph) is held to two lines
// with More / Less; anything shorter reads in full, as before.
const LONG_NOTE_CHARS = 160;

/**
 * "Why this priority" (QA 11-23 #2): one quiet line under the priority —
 * who set it, when (Pacific), and the note that came with it. Plain text, no
 * pill. Renders nothing when the ticket has no reason. A long note is clamped
 * to two lines with a small More / Less button (polish 11-24).
 */
export default function PriorityReasonLine({ reason, priority, className = '' }) {
  const [open, setOpen] = useState(false);
  const noteId = `${useId()}-note`;
  const text = priorityReasonText(reason, priority);
  if (!text) return null;
  const long = String(text.note || '').length > LONG_NOTE_CHARS;
  // line-clamp-2 sets its own display, so it replaces `block` rather than joining it.
  const clamp = long && !open ? 'line-clamp-2' : 'block';
  return (
    <div className={`text-xs leading-5 text-muted-foreground ${className}`} data-testid="priority-reason">
      <span className="font-medium text-foreground/85">Why this priority: </span>
      {text.who && <span>{text.who}</span>}
      {text.who && text.when && <span> · {text.when}</span>}
      {text.note && (
        <span
          id={noteId}
          className={`break-words text-foreground/85 ${clamp}`}
          data-testid="priority-reason-note"
        >
          “{text.note}”
        </span>
      )}
      {text.note && long && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={noteId}
          className="tp-focus-ring inline-flex min-h-6 items-center rounded text-xs font-medium text-primary hover:underline"
        >
          {open ? 'Less' : 'More'}
        </button>
      )}
    </div>
  );
}
