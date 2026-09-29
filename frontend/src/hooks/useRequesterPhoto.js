import { useEffect, useState } from 'react';
import { ticketsAPI } from '../services/api';
import { integrationRequesterAvatar } from '../utils/integrationIdentity';

/**
 * Requester photo from the directory (Entra), by e-mail, through the cached
 * /tickets/requester-photo route. One in-flight request per address, results
 * (including "no photo") remembered for the session so search rows and the
 * requester page never refetch on every keystroke or re-render.
 */
const cache = new Map(); // email → data URI | null
const inflight = new Map(); // email → Promise

export function fetchRequesterPhoto(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!key || !key.includes('@')) return Promise.resolve(null);
  if (cache.has(key)) return Promise.resolve(cache.get(key));
  // Integrations (Simorgh, Microsoft Sentinel) are applications, not people:
  // their own mark, no directory lookup.
  const app = integrationRequesterAvatar(key);
  if (app) { cache.set(key, app); return Promise.resolve(app); }
  if (inflight.has(key)) return inflight.get(key);
  const p = ticketsAPI.requesterPhoto(key)
    .then((res) => { const photo = res?.data?.photo || res?.photo || null; cache.set(key, photo); return photo; })
    .catch(() => { cache.set(key, null); return null; })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
  return p;
}

export function useRequesterPhoto(email) {
  const key = String(email || '').trim().toLowerCase();
  const [photo, setPhoto] = useState(() => (cache.has(key) ? cache.get(key) : integrationRequesterAvatar(key)));
  useEffect(() => {
    let alive = true;
    if (!key) { setPhoto(null); return undefined; }
    if (cache.has(key)) { setPhoto(cache.get(key)); return undefined; }
    fetchRequesterPhoto(key).then((p) => { if (alive) setPhoto(p); });
    return () => { alive = false; };
  }, [key]);
  return photo;
}

export const _photoCache = cache;
