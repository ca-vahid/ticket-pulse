/**
 * Machine senders (16 Nov 2026, Vahid: "a list of no-reply e-mails … these are
 * machine e-mails and shouldn't be responded to"). Per workspace, the addresses
 * that never get a workflow e-mail: BambooHR's new-hire notices and Darktrace's
 * alerts open real tickets in IT, but an acknowledgement or a "resolved" e-mail
 * to them reaches nobody.
 *
 *   { entries: [{ value, addedBy, addedAt }], saved: true }
 *
 * An entry is one of three shapes, matched case-insensitively:
 *   notifications@app.bamboohr.com   one exact address
 *   darktrace.com  (or @darktrace.com)  a whole domain, sub-domains included
 *   noreply                            a word in the part before the @
 *
 * A workspace that never saved a list uses DEFAULT_ENTRIES (the usual no-reply
 * and mail-daemon names). Applied at send time (notificationDeliveryService),
 * to workflow e-mails only: the address is taken off To/Cc, and an e-mail with
 * nobody left on To is not sent (status `skipped`, reason `machine_sender`).
 * The ticket itself is untouched. Storage: one app_settings key per workspace
 * (`machine_senders_ws<N>`), no migration. Read errors mean "the defaults".
 */
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

export const MAX_ENTRIES = 100;
export const MIN_WORD = 5;
export const DEFAULT_ENTRIES = Object.freeze(['noreply', 'no-reply', 'donotreply', 'do-not-reply', 'mailer-daemon', 'postmaster']);
const CACHE_TTL_MS = 30 * 1000;
const cache = new Map(); // workspaceId -> { value, at }
const ENTRY = /^[a-z0-9._%+\-@]+$/;

export function machineSenderSettingKey(workspaceId) {
  return `machine_senders_ws${Number(workspaceId) || 0}`;
}

const lc = (v) => String(v || '').trim().toLowerCase();

/** Clean one entry's text; null when it is unusable. */
export function cleanEntryValue(raw) {
  let v = lc(raw).replace(/^mailto:/, '');
  if (v.startsWith('*@')) v = v.slice(1);
  if (v.startsWith('*.')) v = v.slice(2);
  if (!v || v.length < 3 || v.length > 254 || !ENTRY.test(v)) return null;
  const at = v.indexOf('@');
  if (at > 0) {
    // A full address needs a dotted domain.
    if (v.indexOf('@', at + 1) !== -1 || !v.slice(at + 1).includes('.')) return null;
  } else if (at === 0) {
    if (!v.slice(1).includes('.')) return null;
  } else if (!v.includes('.') && v.length < MIN_WORD) {
    // A word matches inside any address's name: a short one ("bad") would catch real people ("badri@").
    return null;
  }
  return v;
}

/** What kind of entry this is, for the settings card. */
export function entryKind(value) {
  const v = lc(value);
  if (v.includes('@') && !v.startsWith('@')) return 'address';
  if (v.startsWith('@') || v.includes('.')) return 'domain';
  return 'word';
}

/** Does this address match this (clean) entry? */
export function entryMatches(entry, address) {
  const a = lc(address);
  const at = a.lastIndexOf('@');
  if (!entry || at <= 0) return false;
  const local = a.slice(0, at);
  const domain = a.slice(at + 1);
  const kind = entryKind(entry);
  if (kind === 'address') return a === entry;
  if (kind === 'domain') {
    const d = entry.replace(/^@/, '');
    return domain === d || domain.endsWith(`.${d}`);
  }
  return local.includes(entry);
}

function parse(raw) {
  if (raw === null || raw === undefined || raw === '') return null;
  let obj = raw;
  if (typeof raw === 'string') {
    try { obj = JSON.parse(raw); } catch { return null; }
  }
  if (!obj || !Array.isArray(obj.entries)) return null;
  const seen = new Set();
  const entries = [];
  for (const e of obj.entries) {
    const value = cleanEntryValue(typeof e === 'string' ? e : e?.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    entries.push({ value, addedBy: e?.addedBy ? lc(e.addedBy).slice(0, 254) : null, addedAt: e?.addedAt || null });
    if (entries.length >= MAX_ENTRIES) break;
  }
  return { entries, saved: true };
}

const defaults = () => ({ entries: DEFAULT_ENTRIES.map((value) => ({ value, addedBy: null, addedAt: null })), saved: false });

/** The workspace's list (the defaults until it is first saved). Never throws. */
export async function getMachineSenders(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return defaults();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return { ...hit.value, entries: hit.value.entries.map((e) => ({ ...e })) };
  try {
    const value = parse(await settingsRepository.get(machineSenderSettingKey(id))) || defaults();
    cache.set(id, { value, at: Date.now() });
    return { ...value, entries: value.entries.map((e) => ({ ...e })) };
  } catch (err) {
    logger.warn(`Machine senders: read failed for workspace ${id} (using the defaults): ${err.message}`);
    return defaults();
  }
}

/** Replace the list (admin). Entries keep who added them first. */
export async function setMachineSenders(workspaceId, values = [], { actorEmail = null, now = Date.now() } = {}) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('workspaceId is required');
  const before = await getMachineSenders(id);
  const known = new Map(before.entries.map((e) => [e.value, e]));
  const seen = new Set();
  const entries = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const value = cleanEntryValue(typeof raw === 'string' ? raw : raw?.value);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    const prior = known.get(value);
    entries.push(prior?.addedAt ? prior : { value, addedBy: actorEmail ? lc(actorEmail) : null, addedAt: new Date(now).toISOString() });
    if (entries.length >= MAX_ENTRIES) break;
  }
  const value = { entries, saved: true };
  await settingsRepository.set(machineSenderSettingKey(id), JSON.stringify({ entries }));
  cache.set(id, { value, at: Date.now() });
  logger.info(`Machine senders for workspace ${id} set by ${actorEmail || 'unknown'}: ${entries.map((e) => e.value).join(', ') || 'none'}`);
  return { ...value, entries: entries.map((e) => ({ ...e })) };
}

/** The entry an address matches, or null. */
export async function machineSenderMatch(workspaceId, address) {
  const { entries } = await getMachineSenders(workspaceId);
  const hit = entries.find((e) => entryMatches(e.value, address));
  return hit ? hit.value : null;
}

/**
 * Split one workflow e-mail's recipients: the ones to keep, and the machine
 * senders taken off (with the entry each matched). Never throws: on any error
 * nothing is removed.
 */
export async function splitMachineRecipients({ workspaceId, to = [], cc = [] } = {}) {
  try {
    const { entries } = await getMachineSenders(workspaceId);
    const removed = [];
    const keep = (list) => list.filter((address) => {
      const hit = entries.find((e) => entryMatches(e.value, address));
      if (hit) removed.push({ address: lc(address), entry: hit.value });
      return !hit;
    });
    return { to: keep(to), cc: keep(cc), removed };
  } catch (err) {
    logger.debug(`Machine senders skipped: ${err.message}`);
    return { to: [...to], cc: [...cc], removed: [] };
  }
}

export function invalidateMachineSenderCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

export default {
  getMachineSenders, setMachineSenders, machineSenderMatch, splitMachineRecipients, cleanEntryValue, entryMatches, entryKind,
  machineSenderSettingKey, invalidateMachineSenderCache, DEFAULT_ENTRIES, MAX_ENTRIES,
};
