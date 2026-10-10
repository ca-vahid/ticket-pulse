import { useEffect, useState } from 'react';

/**
 * Ticket page, under the title: where an Urgent ticket stands on the
 * "untouched" clock (plans/URGENT_RESPONSE_PLAN.md). One plain line with a
 * small red dot, never a pill. The minutes are counted from `startedAt` in
 * the browser, so they are an approximation (the server counts business
 * minutes); the line refreshes every 30 seconds.
 */

export const URGENT_CLOCK_TICK_MS = 30 * 1000;

const minutesWord = (n) => `${n} min`;

export function urgentClockText(clock, now = Date.now()) {
  if (!clock) return null;
  if (clock.state === 'waiting') return 'Urgent: nobody is at work. It moves as soon as someone is.';
  if (clock.state !== 'running') return null;
  const started = new Date(clock.startedAt).getTime();
  const elapsed = Number.isNaN(started) ? null : Math.max(0, Math.floor((now - started) / 60000));
  const lead = elapsed == null ? 'Urgent: untouched.' : `Urgent: untouched for about ${minutesWord(elapsed)}.`;
  const move = clock.moveMinutes != null ? `it moves at ${minutesWord(clock.moveMinutes)}` : 'it moves if nobody touches it';
  // Past the notify time the sweep tells the team within a minute: never say "is told at" about the past.
  const notifyAt = clock.notifyAt ? new Date(clock.notifyAt).getTime() : NaN;
  if (clock.notifiedAt || (!Number.isNaN(notifyAt) && now >= notifyAt)) return `${lead} The team has been told; ${move}.`;
  if (clock.notifyMinutes != null) return `${lead} The team is told at ${minutesWord(clock.notifyMinutes)}; ${move}.`;
  return `${lead} ${move.charAt(0).toUpperCase()}${move.slice(1)}.`;
}

export default function UrgentClockLine({ clock }) {
  const [now, setNow] = useState(() => Date.now());
  const running = clock?.state === 'running';
  useEffect(() => {
    if (!running) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), URGENT_CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [running, clock?.startedAt]);

  const text = urgentClockText(clock, now);
  if (!text) return null;
  return (
    <p role="status" data-testid="urgent-clock-line" className="mt-1.5 flex items-start gap-2 text-sm text-foreground/85">
      <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-red-500 dark:bg-red-400" aria-hidden="true" />
      <span>{text}</span>
    </p>
  );
}
