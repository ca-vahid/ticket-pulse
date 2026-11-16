/**
 * "Copy me on workflow e-mails" (16 Nov 2026, Vahid: "like an observer for a
 * workflow that gets Bcc'd for each e-mail going out"). Per workspace, a short
 * list of people who get a Bcc of every e-mail a workflow actually sends, for
 * a set time, without touching any workflow:
 *
 *   { observers: [{ email, name, until, workflowIds, addedBy, addedAt }] }
 *
 *   until        ISO time it ends by itself (required; at most MAX_DAYS away)
 *   workflowIds  null = every workflow in the workspace, else only these
 *
 * Applied at send time (notificationDeliveryService.sendDelivery), so Shadow
 * e-mails (never sent) never reach an observer, and a person already on To,
 * Cc or Bcc is not added twice. Storage: one app_settings key per workspace
 * (`workflow_mail_observers_ws<N>`), no migration. Read errors mean "nobody":
 * an observer is a convenience and must never stop or slow a real e-mail.
 */
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

export const MAX_OBSERVERS = 10;
export const MAX_DAYS = 90;
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function observerSettingKey(workspaceId) {
  return `workflow_mail_observers_ws${Number(workspaceId) || 0}`;
}

const lc = (v) => String(v || '').trim().toLowerCase();

/** Clean one stored or submitted entry; null when it is unusable. */
export function cleanObserver(raw, { now = Date.now() } = {}) {
  if (!raw || typeof raw !== 'object') return null;
  const email = lc(raw.email);
  if (!EMAIL.test(email) || email.length > 254) return null;
  const until = new Date(raw.until);
  if (Number.isNaN(until.getTime())) return null;
  const latest = now + MAX_DAYS * 86400000;
  const workflowIds = Array.isArray(raw.workflowIds)
    ? [...new Set(raw.workflowIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))].slice(0, 200)
    : null;
  return {
    email,
    name: raw.name ? String(raw.name).trim().slice(0, 120) : null,
    until: new Date(Math.min(until.getTime(), latest)).toISOString(),
    workflowIds: workflowIds && workflowIds.length ? workflowIds : null,
    addedBy: raw.addedBy ? lc(raw.addedBy).slice(0, 254) : null,
    addedAt: raw.addedAt ? new Date(raw.addedAt).toISOString() : new Date(now).toISOString(),
  };
}

function parse(raw) {
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return { observers: [] }; }
  }
  const list = Array.isArray(obj?.observers) ? obj.observers : [];
  // Stored entries keep their own end date (no MAX_DAYS clamp against today).
  return { observers: list.map((o) => cleanObserver(o, { now: new Date(o?.until || 0).getTime() - 1 })).filter(Boolean).slice(0, MAX_OBSERVERS) };
}

/** Everyone on the list, ended ones included (the settings card shows both). */
export async function getObservers(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return { observers: [] };
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { observers: hit.value.observers.map((o) => ({ ...o })) };
  try {
    const value = parse(await settingsRepository.get(observerSettingKey(id)));
    cache.set(id, { value, at: Date.now() });
    return { observers: value.observers.map((o) => ({ ...o })) };
  } catch (err) {
    logger.warn(`Workflow mail observers: read failed for workspace ${id} (nobody Bcc'd): ${err.message}`);
    return { observers: [] };
  }
}

/** Replace the list (admin). Ended entries are dropped on save. */
export async function setObservers(workspaceId, observers = [], { actorEmail = null, now = Date.now() } = {}) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('workspaceId is required');
  const seen = new Set();
  const next = [];
  for (const raw of Array.isArray(observers) ? observers : []) {
    const o = cleanObserver({ ...raw, addedBy: raw?.addedBy || actorEmail }, { now });
    if (!o || new Date(o.until).getTime() <= now || seen.has(o.email)) continue;
    seen.add(o.email);
    next.push(o);
    if (next.length >= MAX_OBSERVERS) break;
  }
  const value = { observers: next };
  await settingsRepository.set(observerSettingKey(id), JSON.stringify(value));
  cache.set(id, { value, at: Date.now() });
  logger.info(`Workflow mail observers for workspace ${id} set by ${actorEmail || 'unknown'}: ${next.map((o) => `${o.email} until ${o.until}`).join(', ') || 'none'}`);
  return { observers: next.map((o) => ({ ...o })) };
}

/**
 * The addresses to Bcc on one workflow e-mail: active observers whose scope
 * includes this workflow, minus anyone already on To / Cc / Bcc. Never throws.
 */
export async function observerBccFor({ workspaceId, workflowId, to = [], cc = [], bcc = [], now = Date.now() } = {}) {
  try {
    const { observers } = await getObservers(workspaceId);
    if (!observers.length) return [];
    const present = new Set([...to, ...cc, ...bcc].map(lc).filter(Boolean));
    const wf = Number(workflowId);
    return observers
      .filter((o) => new Date(o.until).getTime() > now)
      .filter((o) => !o.workflowIds || o.workflowIds.includes(wf))
      .map((o) => o.email)
      .filter((email) => !present.has(email));
  } catch (err) {
    logger.debug(`Workflow mail observers skipped: ${err.message}`);
    return [];
  }
}

export function invalidateObserverCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default { getObservers, setObservers, observerBccFor, cleanObserver, observerSettingKey, invalidateObserverCache, MAX_OBSERVERS, MAX_DAYS };
