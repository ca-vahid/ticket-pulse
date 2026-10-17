import { ChevronsUp } from 'lucide-react';
import { escalationLine } from '../../utils/handBack';

/**
 * QA 10-16 item 1: on a review card, an escalated ticket says so in one plain
 * line — who escalated, the category, and (when the level check ran) what it
 * did: kept the AI's pick, put a more advanced person first, or found nobody
 * more advanced at work. Renders nothing for any other run.
 */
export default function RunEscalationLine({ run, className = '' }) {
  const reason = run?.reboundFrom?.reason;
  if (reason?.code !== 'escalate') return null;
  const esc = reason.escalation || {};
  const line = escalationLine({ by: esc.fromTechName || run.reboundFrom?.previousTechName, scope: esc.scope });
  const check = run?.recommendation?.escalation || null;
  const outcome = check?.outcome === 'none_higher'
    ? 'Nobody more advanced is at work - your call.'
    : check?.outcome === 'swapped'
      ? `Moved ${check.chosenTechName || 'a more advanced person'} to the top.`
      : null;
  return (
    <p
      className={`flex items-start gap-1 text-[11px] leading-snug text-amber-800 dark:text-amber-200 ${className}`}
      title={[line, esc.level ? `Their level: ${esc.level}` : null, check?.sentence || null].filter(Boolean).join('\n')}
      data-testid="run-escalation-line"
    >
      <ChevronsUp className="mt-px h-3 w-3 flex-shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {line}
        {outcome && <span className="text-muted-foreground"> · {outcome}</span>}
      </span>
    </p>
  );
}
