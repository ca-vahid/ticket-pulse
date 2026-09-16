import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * Display names for people we only know by e-mail (app-only grants such as a
 * read-only observer). Order: any technician row → requester row → Entra
 * (displayName), each guarded; a miss is cached too so a missing mailbox is
 * not re-queried on every page load. v3.8.93 (Neville-in-the-picker fix).
 */
const TTL_MS = 60 * 60 * 1000;
const cache = new Map(); // email → { name, at }
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export function clearPersonNameCache() { cache.clear(); }

export async function resolvePersonName(email) {
  const key = String(email || '').trim().toLowerCase();
  if (!EMAIL_RE.test(key)) return null;
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.name;
  let name = null;
  try {
    const tech = await prisma.technician.findFirst({
      where: { email: { equals: key, mode: 'insensitive' } },
      orderBy: [{ isActive: 'desc' }, { id: 'asc' }],
      select: { name: true },
    });
    if (tech?.name?.trim()) name = tech.name.trim();
  } catch (err) { logger.debug?.(`person name (technician) skipped for ${key}: ${err.message}`); }
  if (!name) {
    try {
      const requester = await prisma.requester.findFirst({
        where: { email: { equals: key, mode: 'insensitive' } },
        orderBy: { id: 'asc' },
        select: { name: true },
      });
      if (requester?.name?.trim() && !EMAIL_RE.test(requester.name)) name = requester.name.trim();
    } catch (err) { logger.debug?.(`person name (requester) skipped for ${key}: ${err.message}`); }
  }
  if (!name) {
    try {
      const { default: azureAdService } = await import('./azureAdService.js');
      if (typeof azureAdService?.isConfigured === 'function' && azureAdService.isConfigured()
        && typeof azureAdService.resolveAddress === 'function') {
        const res = await azureAdService.resolveAddress(key);
        if (res?.status === 'found' && res.displayName) name = String(res.displayName).trim();
      }
    } catch (err) { logger.debug?.(`person name (Entra) skipped for ${key}: ${err.message}`); }
  }
  cache.set(key, { name, at: Date.now() });
  return name;
}

/** Fill `name` on rows that lack one (mutates and returns the array). Bounded concurrency, never throws. */
export async function fillPersonNames(rows, { emailKey = 'email', nameKey = 'name', concurrency = 4 } = {}) {
  const todo = (rows || []).filter((r) => r && r[emailKey] && !r[nameKey]);
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const row = todo[i++];
      try { row[nameKey] = await resolvePersonName(row[emailKey]); } catch { /* keep null */ }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, todo.length) }, worker));
  return rows;
}

export default { resolvePersonName, fillPersonNames, clearPersonNameCache };
