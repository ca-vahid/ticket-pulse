import { priorityReasonText } from '../../utils/priorityReason';

/**
 * "Why this priority" (QA 11-23 #2): one quiet line under the priority —
 * who set it, when (Pacific), and the note that came with it. Plain text, no
 * pill. Renders nothing when the ticket has no reason.
 */
export default function PriorityReasonLine({ reason, priority, className = '' }) {
  const text = priorityReasonText(reason, priority);
  if (!text) return null;
  return (
    <p className={`text-xs leading-5 text-muted-foreground ${className}`} data-testid="priority-reason">
      <span className="font-medium text-foreground/85">Why this priority: </span>
      {text.who && <span>{text.who}</span>}
      {text.who && text.when && <span> · {text.when}</span>}
      {text.note && (
        <span className="block break-words text-foreground/85">“{text.note}”</span>
      )}
    </p>
  );
}
