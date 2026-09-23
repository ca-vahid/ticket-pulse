import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';

/**
 * Which inbound addresses belong to FreshService for a workspace (23 Sep 2026).
 *
 * The ingest ladder used to treat a FreshService ticket number in a subject as
 * proof that FreshService receives the mail itself and dropped it. That is true
 * only when FreshService's own helpdesk address (IT: it@bgcengineering.ca) was
 * among the recipients. A reply to a Ticket Pulse approval mail goes to
 * ticketpulse@ alone — FreshService never sees it, and neither did we
 * (#242611, Ray Tishenko, 22 Sep 2026). The set here is what decides.
 *
 * Source of truth: `app_settings` key `fs_helpdesk_emails_ws<N>` (comma
 * separated) when set; otherwise LEARNED from the workspace's own outgoing
 * FreshService conversations (`raw_payload.support_email`, ≥ 5 rows in 90
 * days). A `*.freshservice.com` tenant address always counts. Cached for an
 * hour; a failure yields the EMPTY set — nothing is skipped, everything is
 * ingested, which is the visible direction of error (a double post in
 * FreshService is seen; a dropped reply is not).
 */
const CACHE_TTL_MS = 60 * 60 * 1000;
const LEARN_MIN_ROWS = 5;
const cache = new Map(); // workspaceId -> { value: Set, at }

export function fsHelpdeskSettingKey(workspaceId) {
  return `fs_helpdesk_emails_ws${Number(workspaceId) || 0}`;
}

export function parseAddressList(value) {
  return [...new Set(String(value || '')
    .split(/[,;\s]+/)
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.includes('@')))];
}

export function isFreshserviceTenantAddress(address) {
  return /@[a-z0-9.-]*\.freshservice\.com$/i.test(String(address || '').trim());
}

async function learnedHelpdeskAddresses(workspaceId) {
  const rows = await prisma.$queryRaw`
    select lower(e.raw_payload->>'support_email') as address, count(*)::int as n
    from ticket_thread_entries e
    join tickets t on t.id = e.ticket_id
    where t.workspace_id = ${workspaceId}
      and e.source = 'freshservice_conversation'
      and coalesce((e.raw_payload->>'incoming')::boolean, false) = false
      and e.raw_payload ? 'support_email'
      and e.occurred_at > now() - interval '90 days'
    group by 1
    order by 2 desc
    limit 3`;
  return rows
    .filter((r) => r.address && r.address.includes('@') && Number(r.n) >= LEARN_MIN_ROWS)
    .map((r) => r.address);
}

/** @returns {Promise<Set<string>>} lowercase addresses FreshService itself reads for this workspace */
export async function fsHelpdeskAddresses(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) return new Set();
  const hit = cache.get(id);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = new Set();
  try {
    const configured = parseAddressList(await settingsRepository.get(fsHelpdeskSettingKey(id)));
    value = new Set(configured.length ? configured : await learnedHelpdeskAddresses(id));
  } catch (err) {
    logger.warn(`fsHelpdeskAddresses: lookup failed for workspace ${id} (treating as none — nothing is skipped): ${err.message}`);
    value = new Set();
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

export async function setFsHelpdeskAddresses(workspaceId, value) {
  const id = Number(workspaceId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('workspaceId is required');
  const list = parseAddressList(value);
  await settingsRepository.set(fsHelpdeskSettingKey(id), list.join(', '));
  cache.delete(id);
  return list;
}

export async function getFsHelpdeskSetting(workspaceId) {
  try {
    return parseAddressList(await settingsRepository.get(fsHelpdeskSettingKey(workspaceId))).join(', ');
  } catch {
    return '';
  }
}

export function invalidateFsHelpdeskCache(workspaceId = null) {
  if (workspaceId === null) cache.clear();
  else cache.delete(Number(workspaceId));
}

/**
 * True when FreshService receives this mail itself: one of the workspace's
 * helpdesk addresses, or a FreshService tenant address, is among the
 * recipients. Ticket Pulse must not post it a second time.
 */
export async function freshserviceWillIngest(workspaceId, email) {
  const recipients = [...(Array.isArray(email?.to) ? email.to : []), ...(Array.isArray(email?.cc) ? email.cc : []), ...(Array.isArray(email?.bcc) ? email.bcc : [])]
    .map((a) => String(a || '').trim().toLowerCase())
    .filter(Boolean);
  if (!recipients.length) return false;
  if (recipients.some(isFreshserviceTenantAddress)) return true;
  const helpdesk = await fsHelpdeskAddresses(workspaceId);
  return recipients.some((a) => helpdesk.has(a));
}

export default {
  fsHelpdeskSettingKey,
  fsHelpdeskAddresses,
  setFsHelpdeskAddresses,
  getFsHelpdeskSetting,
  invalidateFsHelpdeskCache,
  freshserviceWillIngest,
  isFreshserviceTenantAddress,
  parseAddressList,
};
