import { useSyncExternalStore } from 'react';

/**
 * The signed-in person, mirrored out of AuthProvider so shared widgets (the
 * assignee pickers' hand-back dialog, QA 09-25 item 3) can tell "my own
 * ticket" from "someone else's" without importing the auth context — pages
 * and tests that mock AuthContext keep working; outside a provider this is
 * simply null (the widget falls back to the coordinator view).
 */
let current = null;
const listeners = new Set();

export function setCurrentIdentity(user) {
  const next = user ? { email: user.email || null, name: user.name || null } : null;
  if ((next?.email || null) === (current?.email || null) && (next?.name || null) === (current?.name || null)) return;
  current = next;
  listeners.forEach((fn) => fn());
}

export function getCurrentIdentity() {
  return current;
}

function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function useCurrentIdentity() {
  return useSyncExternalStore(subscribe, getCurrentIdentity, getCurrentIdentity);
}
