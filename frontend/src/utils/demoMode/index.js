// Public API for demo mode.
//
// All other code should import from this file rather than reaching into the
// internal modules directly.

import { useEffect, useSyncExternalStore } from 'react';
import {
  isDemoMode,
  setDemoMode,
  subscribeDemoMode,
  reshuffleIdentities,
  arePhotosEnabled,
  setPhotosEnabled,
  getDemoSeed,
} from './state.js';
import {
  mapName,
  mapEmail,
  mapLocation,
  getDemoAvatar,
} from './mappings.js';
import { scrubResponse, maybeScrub, scrubFreeText } from './scrubber.js';

// Re-export the imperative API.
export {
  isDemoMode,
  setDemoMode,
  reshuffleIdentities,
  arePhotosEnabled,
  setPhotosEnabled,
  getDemoSeed,
  mapName,
  mapEmail,
  mapLocation,
  getDemoAvatar,
  scrubResponse,
  scrubFreeText,
  maybeScrub,
};

// React hook returning the current demo mode state. Components re-render
// whenever the toggle flips OR the seed reshuffles.
export function useDemoMode() {
  return useSyncExternalStore(subscribeDemoMode, isDemoMode, () => false);
}

// Hook helper for strings that don't come from the API and therefore aren't
// scrubbed by the axios interceptor (e.g. "Welcome, X" from auth context).
//
// Pass a `kind` (one of 'name' | 'email' | 'location' | 'text') and the
// real value. When demo mode is on, returns the fake equivalent. Otherwise
// returns the input unchanged.
export function useDemoLabel(kind, realValue) {
  const enabled = useDemoMode();
  if (!enabled) return realValue;
  if (realValue == null || realValue === '') return realValue;
  switch (kind) {
  case 'name':     return mapName(String(realValue));
  case 'email':    return mapEmail(String(realValue));
  case 'location': return mapLocation(String(realValue));
  case 'text':     return scrubFreeText(String(realValue));
  default:         return realValue;
  }
}

// Hook variant of getDemoAvatar that subscribes to mode changes so the
// component re-renders when the toggle / photos switch flips.
export function useDemoAvatar(realKey, realPhotoUrl) {
  const enabled = useDemoMode();
  // Force a re-read of arePhotosEnabled by subscribing too.
  useEffect(() => {}, [enabled]);
  if (!enabled) return realPhotoUrl;
  const fake = getDemoAvatar(realKey);
  if (fake == null) return ''; // pool empty -> let initials fallback render
  return fake;
}
