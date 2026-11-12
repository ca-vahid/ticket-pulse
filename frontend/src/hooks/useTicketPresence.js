import { useCallback, useEffect, useRef, useState } from 'react';
import { ticketsAPI } from '../services/api';
import { useAuth } from '../contexts/AuthContext';

const HEARTBEAT_MS = 30_000; // backend expires viewers after ~75s

/**
 * "Also viewing" presence for an open ticket detail page (gap plan 2 P4.1).
 * Heartbeats while mounted, leaves on unmount/tab-hide, and tracks the other
 * viewers. Team-safe: presence only — the backend stores nothing and tracks
 * no durations.
 *
 * `composing` ('reply' | 'note' | null, Nov 2026): what this person is writing
 * right now. It rides on the heartbeat, and a change is announced at once so
 * "X is writing a reply" does not lag half a minute. Other viewers come back
 * with their own `composing`.
 *
 * Returns `{ viewers, onPresence }`; wire `onPresence` into the page's
 * EXISTING `useSSE` call (don't open a second SSE connection per page —
 * browsers cap concurrent connections per host).
 */
export function useTicketPresence(ticketId, enabled = true, composing = null) {
  const { user } = useAuth();
  const myEmail = user?.email?.toLowerCase() || null;
  const [viewers, setViewers] = useState([]);
  const composingRef = useRef(composing);
  composingRef.current = composing;
  const active = Boolean(enabled && Number.isFinite(ticketId) && myEmail);

  useEffect(() => {
    if (!active) return undefined;
    let cancelled = false;

    const beat = () => {
      ticketsAPI.presenceHeartbeat(ticketId, false, composingRef.current)
        .then((res) => { if (!cancelled) setViewers(res.data?.viewers || []); })
        .catch(() => {}); // presence is best-effort, never surface errors
    };
    beat();
    const timer = setInterval(beat, HEARTBEAT_MS);

    // Pause while the tab is hidden so a backgrounded tab doesn't read as
    // "viewing" forever; re-announce when it comes back.
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        ticketsAPI.presenceHeartbeat(ticketId, true).catch(() => {});
      } else {
        beat();
      }
    };
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelled = true;
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      ticketsAPI.presenceHeartbeat(ticketId, true).catch(() => {});
    };
  }, [ticketId, active]);

  // Starting or stopping a reply/note: say so straight away (not on mount —
  // the first heartbeat above already carries it).
  const firstRef = useRef(true);
  useEffect(() => {
    if (firstRef.current) { firstRef.current = false; return; }
    if (!active || (typeof document !== 'undefined' && document.visibilityState === 'hidden')) return;
    ticketsAPI.presenceHeartbeat(ticketId, false, composing)
      .then((res) => setViewers(res.data?.viewers || []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [composing]);

  const onPresence = useCallback((data) => {
    if (data?.ticketId !== ticketId) return;
    setViewers((data.viewers || []).filter((v) => v.email !== myEmail));
  }, [ticketId, myEmail]);

  return { viewers, onPresence };
}
