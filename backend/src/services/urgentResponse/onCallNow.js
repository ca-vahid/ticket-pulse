/**
 * Is this person on call right now? (QA 10-27 #2: quiet hours never mute the
 * on-call person.) Reads the saved rotation and covers through onCallService,
 * cached for a minute per workspace so a burst of alerts costs one read.
 * Never throws: any failure answers false, so quiet hours behave as before.
 */
const TTL_MS = 60 * 1000;
const cache = new Map(); // workspaceId -> { at, technicianId }

export async function isOnCallNow(workspaceId, technicianId, now = new Date()) {
  const ws = Number(workspaceId);
  const tech = Number(technicianId);
  if (!Number.isInteger(ws) || ws <= 0 || !Number.isInteger(tech) || tech <= 0) return false;
  try {
    const hit = cache.get(ws);
    if (hit && now.getTime() - hit.at < TTL_MS && now.getTime() >= hit.at) return hit.technicianId === tech;
    const { default: onCall } = await import('./onCallService.js');
    const current = await onCall.current(ws, now);
    const holder = current?.configured && current.technician?.id ? Number(current.technician.id) : null;
    cache.set(ws, { at: now.getTime(), technicianId: holder });
    return holder === tech;
  } catch {
    return false;
  }
}

export function _resetOnCallNowCache() {
  cache.clear();
}
