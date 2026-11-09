import { useEffect, useState } from 'react';
import { availabilityAPI } from '../services/api';

/**
 * Time-away requests waiting for the current person's decision — the red
 * number on the Availability nav entry (Vahid, 9 Nov 2026: "so I know
 * something is waiting to be approved"). Availability has no live stream, so
 * the count is shared by every mounted rail and refreshed:
 *   - when a page mounts and the last read is over a minute old,
 *   - when the tab comes back into view (same minute rule),
 *   - every 5 minutes while the tab is visible,
 *   - straight away on the `tp:availability-changed` window event, which the
 *     Availability page fires after a decision, booking or change.
 */

export const AVAILABILITY_CHANGED_EVENT = 'tp:availability-changed';
const STALE_MS = 60 * 1000;
const POLL_MS = 5 * 60 * 1000;

let count = 0;
let readAt = 0;
let inFlight = null;
const listeners = new Set();

function publish(next) {
  count = next;
  listeners.forEach((fn) => fn(next));
}

export function refreshAvailabilityApprovalCount({ force = false } = {}) {
  if (!force && Date.now() - readAt < STALE_MS) return Promise.resolve(count);
  if (inFlight) return inFlight;
  inFlight = availabilityAPI.approvalCount()
    .then((res) => {
      readAt = Date.now();
      publish(Math.max(0, Number(res?.data?.count) || 0));
      return count;
    })
    .catch(() => count) // silent: not signed in, offline, or Availability unavailable
    .finally(() => { inFlight = null; });
  return inFlight;
}

/** Tell every badge that something changed (after a decision, booking or edit). */
export function notifyAvailabilityChanged() {
  if (typeof window !== 'undefined') window.dispatchEvent(new Event(AVAILABILITY_CHANGED_EVENT));
}

export function useAvailabilityApprovalCount({ enabled = true } = {}) {
  const [value, setValue] = useState(count);

  useEffect(() => {
    if (!enabled) return undefined;
    listeners.add(setValue);
    setValue(count);
    refreshAvailabilityApprovalCount();
    const onChanged = () => { refreshAvailabilityApprovalCount({ force: true }); };
    const onVisible = () => { if (document.visibilityState === 'visible') refreshAvailabilityApprovalCount(); };
    window.addEventListener(AVAILABILITY_CHANGED_EVENT, onChanged);
    document.addEventListener('visibilitychange', onVisible);
    const timer = setInterval(() => {
      if (document.visibilityState === 'visible') refreshAvailabilityApprovalCount({ force: true });
    }, POLL_MS);
    return () => {
      listeners.delete(setValue);
      window.removeEventListener(AVAILABILITY_CHANGED_EVENT, onChanged);
      document.removeEventListener('visibilitychange', onVisible);
      clearInterval(timer);
    };
  }, [enabled]);

  return enabled ? value : 0;
}

/** Test seam: forget the shared count. */
export function __resetAvailabilityApprovalCount() {
  count = 0;
  readAt = 0;
  inFlight = null;
  listeners.clear();
}
