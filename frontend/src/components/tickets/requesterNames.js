import { useEffect, useState } from 'react';
import { ticketsAPI } from '../../services/api';

/**
 * Names for the requester ids in ?requesterId= (QA 10-27 #5). The URL keeps
 * only ids; the rail's search results and a deep link's ?requesterName= seed
 * this cache, and anything still unknown is looked up once through the
 * requester page endpoint. Shared by the rail and the filter chips.
 */
const cache = new Map(); // id (string) → name
const inflight = new Map(); // id → Promise
const listeners = new Set();

function publish() {
  for (const fn of listeners) fn();
}

export function rememberRequesterName(id, name) {
  if (id == null || !name) return;
  const key = String(id);
  if (cache.get(key) === name) return;
  cache.set(key, name);
  publish();
}

export function requesterNameFor(id) {
  return cache.get(String(id)) || null;
}

function lookup(id) {
  const key = String(id);
  if (cache.has(key) || inflight.has(key)) return;
  const p = Promise.resolve()
    .then(() => ticketsAPI.requesterProfile(key))
    .then((res) => {
      const r = res?.data?.requester || res?.data || {};
      rememberRequesterName(key, r.name || r.email || null);
    })
    .catch(() => { /* the chip falls back to "Requester <id>" */ })
    .finally(() => inflight.delete(key));
  inflight.set(key, p);
}

/** id → display name for every id given ("Requester 41" until it resolves). */
export function useRequesterNames(ids, { hint = '' } = {}) {
  const [, setTick] = useState(0);
  const key = (ids || []).join(',');
  useEffect(() => {
    const fn = () => setTick((n) => n + 1);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  useEffect(() => {
    const list = key ? key.split(',') : [];
    // A deep link (ticket page → "their tickets") names its one requester.
    if (list.length === 1 && hint) rememberRequesterName(list[0], hint);
    for (const id of list) lookup(id);
  }, [key, hint]);
  return (id) => cache.get(String(id)) || `Requester ${id}`;
}
