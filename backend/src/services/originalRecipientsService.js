/**
 * "Everyone on the original e-mail" — the workflow recipient token
 * `original_ccs` (24 Nov 2026). The token value is unchanged for saved
 * workflows; only what it reaches is wider.
 *
 * Until now it read the ticket's Cc lists only (ccEmails + replyCcEmails). A
 * requester who wrote to four colleagues and the IT mailbox, everyone on To,
 * got an acknowledgement nobody else saw. It now reads the To line as well
 * (tickets.to_emails), and leaves off:
 *   - every one of our own mailboxes, in any workspace, with their
 *     also-known-as addresses and `mailbox+tag@` variants, the global sender
 *     address and FreshService relay addresses (…freshservice.com);
 *   - the requester (they are the To of the workflow mail);
 *   - active agents of the ticket's workspace (they see the ticket in the app);
 *   - automated addresses: the workspace's machine-sender list
 *     (machineSenderService), and its default no-reply / mail-daemon names
 *     even where the workspace saved a list without them;
 *   - unattended requesters (an automation's mailbox never gets requester mail);
 *   - anyone an agent took off the Cc (the reply composer's removals, stored on
 *     the reply since 24 Nov 2026, and "Also for" removals in the activity log),
 *     until an agent adds them back;
 *   - repeats, compared case-insensitively.
 *
 * Never throws. A failed lookup skips that one check, except our own mailboxes:
 * when those cannot be read the To line is left out entirely (the Cc lists were
 * already cleaned of the mailbox when the mail arrived), so a lookup failure can
 * never e-mail a mailbox of ours.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { getMailboxAliases } from './mailboxAliasService.js';
import { getMachineSenders, entryMatches, DEFAULT_ENTRIES } from './machineSenderService.js';

const ROBOT = /(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;
const FRESHSERVICE_RELAY = /@([^@]*\.)?freshservice\.com$/i;
const OWN_CACHE_TTL_MS = 60 * 1000;
const HISTORY_ROWS = 100;
let ownCache = null; // { value: string[], at }

const lc = (v) => String(v || '').trim().toLowerCase();

/** The bare lowercase address in "Name <a@b.c>", "<a@b.c>" or "a@b.c"; '' when none. */
export function bareAddress(value) {
  const m = String(value || '').match(/[^\s<>"',;:]+@[^\s<>"',;:]+\.[^\s<>"',;:]+/);
  return m ? m[0].toLowerCase() : '';
}

const listOf = (value) => (Array.isArray(value) ? value : []);

/** Everyone on the original e-mail as stored on the ticket: Cc, reply Cc, then To. Bare, lowercase, no repeats. */
export function originalRecipientCandidates(ticket, { includeTo = true } = {}) {
  const seen = new Set();
  const out = [];
  const lists = [listOf(ticket?.ccEmails), listOf(ticket?.replyCcEmails), includeTo ? listOf(ticket?.toEmails) : []];
  for (const raw of lists.flat()) {
    const address = bareAddress(raw);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
}

/** Is `address` one of `own`, or a `+tag` variant of one? */
export function isOwnAddress(address, own) {
  const a = lc(address);
  if (!a) return false;
  const tagged = a.match(/^([^@+]+)\+[^@]*@(.+)$/);
  return (own instanceof Set ? [...own] : listOf(own)).some((raw) => {
    const base = lc(raw);
    if (!base) return false;
    if (a === base) return true;
    const [local, domain] = base.split('@');
    return Boolean(tagged) && tagged[1] === local && tagged[2] === domain;
  });
}

/**
 * The pure part: filter the candidates. Returns the list kept and how many were
 * left off for each reason (counts only, so a Preview can say why).
 */
export function filterOriginalRecipients(candidates, {
  own = [], requesterEmail = null, machineEntries = [], unattended = new Set(), removedByAgent = new Set(), agents = new Set(),
} = {}) {
  const requester = bareAddress(requesterEmail);
  const leftOff = { ownMailbox: 0, agent: 0, requester: 0, automated: 0, unattended: 0, removedByAgent: 0 };
  const seen = new Set();
  const list = [];
  for (const raw of listOf(candidates)) {
    const address = bareAddress(raw);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    // FreshService's own relay addresses (…@<account>.freshservice.com) are
    // plumbing too, the same rule the reply quote's Cc line uses.
    if (isOwnAddress(address, own) || FRESHSERVICE_RELAY.test(address)) { leftOff.ownMailbox += 1; continue; }
    if (requester && address === requester) { leftOff.requester += 1; continue; }
    // Our agents see the ticket in the app; they get no copy of requester mail.
    if (agents.has(address)) { leftOff.agent += 1; continue; }
    if (ROBOT.test(address) || listOf(machineEntries).some((entry) => entryMatches(entry, address))) { leftOff.automated += 1; continue; }
    if (unattended.has(address)) { leftOff.unattended += 1; continue; }
    if (removedByAgent.has(address)) { leftOff.removedByAgent += 1; continue; }
    list.push(address);
  }
  return { list, leftOff };
}

/**
 * Every address that is a mailbox of ours: each connected mailbox in any
 * workspace (enabled or not), its also-known-as addresses, and the global
 * sender. Cached for a minute. Throws when the mailbox list cannot be read —
 * the caller then leaves the To line out.
 */
export async function ownMailboxAddresses({ fresh = false } = {}) {
  if (!fresh && ownCache && Date.now() - ownCache.at < OWN_CACHE_TTL_MS) return ownCache.value;
  const boxes = await prisma.mailboxConnection.findMany({ select: { id: true, address: true } });
  const own = new Set();
  for (const box of listOf(boxes)) {
    const address = lc(box?.address);
    if (address.includes('@')) own.add(address);
    if (box?.id) for (const alias of await getMailboxAliases(box.id)) own.add(lc(alias));
  }
  // The global sender (ticketpulse@…). Read from the environment, not
  // config/index.js: that module exits the process on a partial environment.
  for (const sender of [process.env.SENDGRID_FROM_EMAIL, process.env.SMTP_FROM_EMAIL]) {
    const address = bareAddress(sender);
    if (address) own.add(address);
  }
  const value = [...own];
  ownCache = { value, at: Date.now() };
  return value;
}

export function invalidateOwnMailboxCache() {
  ownCache = null;
}

/**
 * People an agent took off the Cc and has not added back, from the ticket's
 * history, oldest first:
 *   a reply's `cc_removed` (the composer's removals)       → off
 *   a reply's `cc_emails`                                   → back on
 *   an "Also for" edit (cc_changed): from − to              → off
 *                                    to − from              → back on
 */
export function agentRemovedFromHistory(replies = [], ccChanges = []) {
  const events = [
    ...listOf(replies).map((row) => ({
      at: new Date(row?.occurredAt || 0).getTime(),
      off: listOf(row?.rawPayload?.cc_removed),
      on: listOf(row?.rawPayload?.cc_emails),
    })),
    ...listOf(ccChanges).map((row) => {
      const from = new Set(listOf(row?.details?.from).map(bareAddress).filter(Boolean));
      const to = new Set(listOf(row?.details?.to).map(bareAddress).filter(Boolean));
      return {
        at: new Date(row?.performedAt || 0).getTime(),
        off: [...from].filter((a) => !to.has(a)),
        on: [...to].filter((a) => !from.has(a)),
      };
    }),
  ].sort((x, y) => x.at - y.at);
  const removed = new Set();
  for (const event of events) {
    for (const raw of event.off) { const a = bareAddress(raw); if (a) removed.add(a); }
    for (const raw of event.on) { const a = bareAddress(raw); if (a) removed.delete(a); }
  }
  return removed;
}

async function agentRemovedCc(ticketId) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return new Set();
  const [replies, ccChanges] = await Promise.all([
    Promise.resolve().then(() => prisma.ticketThreadEntry.findMany({
      where: { ticketId: id, source: 'ticketpulse_user', eventType: 'reply', isPrivate: false },
      select: { occurredAt: true, rawPayload: true },
      orderBy: { occurredAt: 'desc' },
      take: HISTORY_ROWS,
    })).catch((err) => { logger.debug(`Original recipients: reply history not read for ticket ${id}: ${err.message}`); return []; }),
    Promise.resolve().then(() => prisma.ticketActivity.findMany({
      where: { ticketId: id, activityType: 'cc_changed' },
      select: { performedAt: true, details: true },
      orderBy: { performedAt: 'desc' },
      take: HISTORY_ROWS,
    })).catch((err) => { logger.debug(`Original recipients: Cc changes not read for ticket ${id}: ${err.message}`); return []; }),
  ]);
  return agentRemovedFromHistory(replies, ccChanges);
}

/** Active agents (technicians) of this workspace among the addresses. A failed read is "none". */
async function agentsAmong(workspaceId, addresses) {
  const id = Number(workspaceId);
  if (!addresses.length || !Number.isInteger(id) || id <= 0) return new Set();
  try {
    const rows = await prisma.technician.findMany({
      where: { workspaceId: id, isActive: true, email: { in: addresses, mode: 'insensitive' } },
      select: { email: true },
    });
    return new Set(listOf(rows).map((r) => bareAddress(r.email)).filter(Boolean));
  } catch (err) {
    logger.debug(`Original recipients: agent check skipped: ${err.message}`);
    return new Set();
  }
}

async function unattendedAmong(addresses) {
  if (!addresses.length) return new Set();
  try {
    const rows = await prisma.requester.findMany({
      where: { email: { in: addresses, mode: 'insensitive' }, unattended: true },
      select: { email: true },
    });
    return new Set(listOf(rows).map((r) => bareAddress(r.email)).filter(Boolean));
  } catch (err) {
    logger.debug(`Original recipients: unattended check skipped: ${err.message}`);
    return new Set();
  }
}

/**
 * The workspace's machine-sender entries, plus the usual no-reply names even
 * when the workspace saved a list without them: a person copied on the
 * original e-mail is never a no-reply address.
 */
async function machineEntriesFor(workspaceId) {
  let saved = [];
  try {
    const { entries } = await getMachineSenders(workspaceId);
    saved = listOf(entries).map((e) => e.value).filter(Boolean);
  } catch {
    saved = [];
  }
  return [...new Set([...DEFAULT_ENTRIES, ...saved])];
}

/**
 * Everyone on the original e-mail for this event's ticket, cleaned (see the
 * header). Returns { list, leftOff, toLineSkipped }.
 */
export async function resolveOriginalRecipients(context, { workspaceId = null } = {}) {
  const ticket = context?.ticket || {};
  let own = [];
  let toLineSkipped = false;
  try {
    own = await ownMailboxAddresses();
  } catch (err) {
    toLineSkipped = true;
    logger.warn(`Original recipients: our mailboxes not read, the To line is left out this time: ${err.message}`);
  }
  const candidates = originalRecipientCandidates(ticket, { includeTo: !toLineSkipped });
  const wsId = workspaceId ?? context?.workspace?.id ?? ticket.workspaceId ?? null;
  const [machineEntries, unattended, removedByAgent, agents] = candidates.length
    ? await Promise.all([machineEntriesFor(wsId), unattendedAmong(candidates), agentRemovedCc(ticket.id), agentsAmong(wsId, candidates)])
    : [[], new Set(), new Set(), new Set()];
  const requesterEmail = context?.requester?.email || ticket?.requester?.email || ticket?.requesterEmail || null;
  const result = filterOriginalRecipients(candidates, { own, requesterEmail, machineEntries, unattended, removedByAgent, agents });
  return { ...result, ...(toLineSkipped ? { toLineSkipped: true } : {}) };
}

/**
 * Keep one e-mail inside the send cap by leaving off people who are there only
 * as "everyone on the original e-mail" — last first, Cc, then Bcc, then To —
 * so the requester's own mail still goes. Returns the lists and how many were
 * left off.
 */
export function trimOriginalToCap({ to = [], cc = [], bcc = [] }, originalList = [], max = 25) {
  const original = new Set(listOf(originalList).map(lc));
  const lists = { to: [...to], cc: [...cc], bcc: [...bcc] };
  let over = lists.to.length + lists.cc.length + lists.bcc.length - max;
  let trimmed = 0;
  for (const key of ['cc', 'bcc', 'to']) {
    for (let i = lists[key].length - 1; i >= 0 && over > 0; i -= 1) {
      if (!original.has(lc(lists[key][i]))) continue;
      lists[key].splice(i, 1);
      over -= 1;
      trimmed += 1;
    }
  }
  return { ...lists, trimmed };
}

export default {
  bareAddress, originalRecipientCandidates, isOwnAddress, filterOriginalRecipients, ownMailboxAddresses,
  invalidateOwnMailboxCache, agentRemovedFromHistory, resolveOriginalRecipients, trimOriginalToCap,
};
