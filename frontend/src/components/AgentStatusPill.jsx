import { getLeaveTooltip } from '../utils/leaveInfo';

/**
 * Status pill under an agent's name in the dashboard SIMPLE views (QA 08-04
 * item 11: captions read better as pills, matching the prototype table).
 *
 * One shared implementation for TechCardCompact and TechCard so the caption
 * logic can't drift between the two again. Tones:
 *  - leave  → the leave badge's own tint (OFF amber / WFH teal / other purple)
 *  - violet → "Heaviest load on the team" (team-balance framing, not a rank)
 *  - slate  → "Steady week" (calm default)
 */
export default function AgentStatusPill({ leaveBadge, activeLeave, topLoad = false, className = '' }) {
  const text = leaveBadge
    ? getLeaveTooltip(activeLeave)?.split('\n')[0]
    : topLoad
      ? 'Heaviest load on the team'
      : 'Steady week';

  const toneClass = leaveBadge
    ? `${leaveBadge.badgeBg} ${leaveBadge.badgeText} ${leaveBadge.badgeBorder}`
    : topLoad
      ? 'bg-violet-50 text-violet-700 border-violet-200 font-medium'
      : 'bg-slate-50 text-slate-500 border-slate-200';

  return (
    <span
      className={`inline-block w-fit max-w-full truncate rounded-full border px-1.5 py-px text-[10px] leading-4 ${toneClass} ${className}`}
      title={text || undefined}
    >
      {text}
    </span>
  );
}
