/**
 * "Everyone on the original e-mail" — the workflow recipient token
 * `original_ccs` (24 Nov 2026). The token value is unchanged for saved
 * workflows; only what it reaches is wider.
 *
 * Until now it read the ticket's Cc lists only (ccEmails + replyCcEmails). A
 * requester who wrote to four colleagues and the IT mailbox, everyone on To,
 * got an acknowledgement nobody else saw. It now reads the To line as well.
 *
 * Where the lists come from:
 *   - ticket.created on a mail-in ticket: the arriving e-mail, handed over in
 *     memory (`context.originalEmailRecipients`, like createdVia). The ticket
 *     row gets its To/Cc only after that event, exactly as before, so no other
 *     workflow, condition or the FreshService copy sees anything new.
 *   - every other event: the ticket row (ccEmails + replyCcEmails + toEmails),
 *     with the "Original email" thread entry for how the mail arrived.
 *
 * The To line is used only when the mail came straight to one of our
 * mailboxes (its address or an alias on To/Cc), was not an agent's forward,
 * and names at most 10 people (MAX_CC_EMAILS). Otherwise only the Cc lists.
 *
 * Left out:
 *   - our own mailboxes in any workspace, their also-known-as addresses and
 *     `mailbox+tag@` variants, the global sender (settings, then environment)
 *     and FreshService relay addresses (…freshservice.com);
 *   - the requester (they are the To of the workflow mail);
 *   - active agents of the ticket's workspace (they see the ticket in the app);
 *   - automated addresses: the workspace's machine-sender list, plus its
 *     default no-reply / mail-daemon names even where a saved list lacks them;
 *   - unattended requesters (an automation's mailbox);
 *   - anyone an agent took off the Cc (a reply's `cc_removed`, or an "Also
 *     for" removal), until an agent adds them back;
 *   - an address on one of our own domains that is not a person: kept only
 *     when it is an active requester, a member, or a person in the directory
 *     (a distribution list or shared mailbox is not);
 *   - repeats, compared case-insensitively.
 *
 * Never throws. When our mailbox list cannot be read in full, nobody is
 * reached (an empty list): a partial list could mail a mailbox of ours. Other
 * failed lookups skip that one check, except the person check, which leaves an
 * unresolved internal address out.
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';
import settingsRepository from './settingsRepository.js';
import { aliasSettingKey, parseAliasList } from './mailboxAliasService.js';
import { getMachineSenders, entryMatches, DEFAULT_ENTRIES } from './machineSenderService.js';

const ROBOT = /(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;
const FRESHSERVICE_RELAY = /@([^@]*\.)?freshservice\.com$/i;
// Permissive local part (o'brien, d'souza.r, first+tag, a_b-c); a dotted domain.
const LOCAL_PART = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]+$/i;
const DOMAIN_PART = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/i;
export const MAX_TO_LINE = 10; // the same ten as MAX_CC_EMAILS
const OWN_CACHE_TTL_MS = 60 * 1000;
const HISTORY_ROWS = 100;
const DIRECTORY_TTL_MS = 6 * 60 * 60 * 1000;
const DIRECTORY_CACHE_MAX = 1000;
const DIRECTORY_LOOKUPS_PER_RUN = 10;
let ownCache = null; // { value: string[], at }
const directoryCache = new Map(); // address -> { person, at }

const lc = (v) => String(v || '').trim().toLowerCase();
const listOf = (value) => (Array.isArray(value) ? value : []);
const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);

/**
 * The lowercase address in "Name <a@b.c>", "<a@b.c>" or "a@b.c" (surrounding
 * whitespace ignored); '' when it is not an address. Apostrophes, plus signs,
 * dots, hyphens and underscores are kept in the local part.
 */
export function bareAddress(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const angle = text.match(/<([^<>]*)>/);
  const address = (angle ? angle[1] : text).trim().replace(/^mailto:/i, '');
  const at = address.lastIndexOf('@');
  if (at <= 0 || at === address.length - 1) return '';
  const local = address.slice(0, at);
  const domain = address.slice(at + 1);
  if (!LOCAL_PART.test(local) || local.startsWith('.') || local.endsWith('.') || local.includes('..')) return '';
  if (!DOMAIN_PART.test(domain)) return '';
  return address.toLowerCase();
}

const uniqueAddresses = (values) => {
  const seen = new Set();
  const out = [];
  for (const raw of values) {
    const address = bareAddress(raw);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    out.push(address);
  }
  return out;
};

/** Everyone on the original e-mail as given: Cc, reply Cc, then To. Bare, lowercase, no repeats. */
export function originalRecipientCandidates(ticket, { includeTo = true } = {}) {
  return uniqueAddresses([
    ...listOf(ticket?.ccEmails),
    ...listOf(ticket?.replyCcEmails),
    ...(includeTo ? listOf(ticket?.toEmails) : []),
  ]);
}

/** Is `address` one of `own`, a `+tag` variant of one, or a FreshService relay address? */
export function isOwnAddress(address, own) {
  const a = lc(address);
  if (!a) return false;
  if (FRESHSERVICE_RELAY.test(a)) return true;
  const tagged = a.match(/^([^@+]+)\+[^@]*@(.+)$/);
  return (own instanceof Set ? [...own] : listOf(own)).some((raw) => {
    const base = lc(raw);
    if (!base) return false;
    if (a === base) return true;
    const [local, domain] = base.split('@');
    return Boolean(tagged) && tagged[1] === local && tagged[2] === domain;
  });
}

const emptyLeftOff = () => ({
  ownMailbox: 0, agent: 0, requester: 0, automated: 0, unattended: 0, removedByAgent: 0, notAPerson: 0,
});

/**
 * The pure part: filter the candidates. Returns the list kept and how many were
 * left out for each reason (counts only, so a Preview can say why).
 * `internalDomains`: our own domains; an address on one is kept only when it is
 * in `persons`.
 */
export function filterOriginalRecipients(candidates, {
  own = [], requesterEmail = null, machineEntries = [], unattended = new Set(), removedByAgent = new Set(),
  agents = new Set(), internalDomains = [], persons = new Set(),
} = {}) {
  const requester = bareAddress(requesterEmail);
  const leftOff = emptyLeftOff();
  const internal = listOf(internalDomains).map(lc).filter(Boolean);
  const isInternal = (address) => {
    const domain = domainOf(address);
    return internal.some((d) => domain === d || domain.endsWith(`.${d}`));
  };
  const list = [];
  for (const address of uniqueAddresses(listOf(candidates))) {
    if (isOwnAddress(address, own)) { leftOff.ownMailbox += 1; continue; }
    if (requester && address === requester) { leftOff.requester += 1; continue; }
    // Our agents see the ticket in the app; they get no copy of requester mail.
    if (agents.has(address)) { leftOff.agent += 1; continue; }
    if (ROBOT.test(address) || listOf(machineEntries).some((entry) => entryMatches(entry, address))) { leftOff.automated += 1; continue; }
    if (unattended.has(address)) { leftOff.unattended += 1; continue; }
    if (removedByAgent.has(address)) { leftOff.removedByAgent += 1; continue; }
    if (isInternal(address) && !persons.has(address)) { leftOff.notAPerson += 1; continue; }
    list.push(address);
  }
  return { list, leftOff };
}

/**
 * Every address that is a mailbox of ours: each connected mailbox in any
 * workspace (enabled or not), its also-known-as addresses, and the global
 * sender (the sendgrid_from_email setting, then the environment). Cached for a
 * minute, and only when every read succeeded: any failure throws and caches
 * nothing.
 */
export async function ownMailboxAddresses({ fresh = false } = {}) {
  if (!fresh && ownCache && Date.now() - ownCache.at < OWN_CACHE_TTL_MS) return ownCache.value;
  const boxes = await prisma.mailboxConnection.findMany({ select: { id: true, address: true } });
  const own = new Set();
  for (const box of listOf(boxes)) {
    const address = bareAddress(box?.address);
    if (address) own.add(address);
    // Read the setting itself (mailboxAliasService.getMailboxAliases turns a
    // failure into "none", which would cache a partial list here).
    if (box?.id) for (const alias of parseAliasList(await settingsRepository.get(aliasSettingKey(box.id)))) own.add(lc(alias));
  }
  const configured = await settingsRepository.get('sendgrid_from_email');
  for (const sender of [configured, process.env.SENDGRID_FROM_EMAIL, process.env.SMTP_FROM_EMAIL]) {
    const address = bareAddress(sender);
    if (address) own.add(address);
  }
  const value = [...own];
  ownCache = { value, at: Date.now() };
  return value;
}

export function invalidateOwnMailboxCache() {
  ownCache = null;
  directoryCache.clear();
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

const soft = (label, fn, fallback) => Promise.resolve().then(fn).catch((err) => {
  logger.debug(`Original recipients: ${label} skipped: ${err.message}`);
  return fallback;
});

async function agentRemovedCc(ticketId) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return new Set();
  const [replies, ccChanges] = await Promise.all([
    soft('reply history', () => prisma.ticketThreadEntry.findMany({
      where: { ticketId: id, source: 'ticketpulse_user', eventType: 'reply', isPrivate: false },
      select: { occurredAt: true, rawPayload: true },
      orderBy: { occurredAt: 'desc' },
      take: HISTORY_ROWS,
    }), []),
    soft('Cc changes', () => prisma.ticketActivity.findMany({
      where: { ticketId: id, activityType: 'cc_changed' },
      select: { performedAt: true, details: true },
      orderBy: { performedAt: 'desc' },
      take: HISTORY_ROWS,
    }), []),
  ]);
  return agentRemovedFromHistory(replies, ccChanges);
}

/** The ticket's "Original email" thread entry (how the mail arrived), or null. */
async function originalEmailEntry(ticketId) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return null;
  return soft('original e-mail entry', () => prisma.ticketThreadEntry.findFirst({
    where: { ticketId: id, eventType: 'original_email' },
    select: { rawPayload: true },
    orderBy: { id: 'asc' },
  }), null);
}

async function agentsAmong(workspaceId, addresses) {
  const id = Number(workspaceId);
  if (!addresses.length || !Number.isInteger(id) || id <= 0) return new Set();
  const rows = await soft('agent check', () => prisma.technician.findMany({
    where: { workspaceId: id, isActive: true, email: { in: addresses, mode: 'insensitive' } },
    select: { email: true },
  }), []);
  return new Set(listOf(rows).map((r) => bareAddress(r.email)).filter(Boolean));
}

/** Requester rows: the unattended ones, and the active people. */
async function requestersAmong(addresses) {
  const unattended = new Set();
  const persons = new Set();
  if (!addresses.length) return { unattended, persons };
  const rows = await soft('requester check', () => prisma.requester.findMany({
    where: { email: { in: addresses, mode: 'insensitive' } },
    select: { email: true, unattended: true, isActive: true, suppressedAt: true },
  }), []);
  for (const row of listOf(rows)) {
    const address = bareAddress(row.email);
    if (!address) continue;
    if (row.unattended === true) unattended.add(address);
    else if (row.isActive !== false && !row.suppressedAt) persons.add(address);
  }
  return { unattended, persons };
}

/** Members (anyone with access to a workspace) among the addresses. */
async function membersAmong(addresses) {
  if (!addresses.length) return new Set();
  const rows = await soft('member check', () => prisma.workspaceAccess.findMany({
    where: { email: { in: addresses, mode: 'insensitive' } },
    select: { email: true },
  }), []);
  return new Set(listOf(rows).map((r) => bareAddress(r.email)).filter(Boolean));
}

async function workspaceInternalDomains(workspaceId) {
  const id = Number(workspaceId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const ws = await soft('internal domains', () => prisma.workspace.findUnique({ where: { id }, select: { internalDomains: true } }), null);
  return listOf(ws?.internalDomains).map(lc).filter(Boolean);
}

/**
 * Is this internal address a person in the directory? Found (or an alias of a
 * user) with a job title or department; a list or shared mailbox has neither.
 * Cached six hours, at most DIRECTORY_CACHE_MAX addresses; "unavailable" is
 * not cached and counts as not a person this time.
 */
async function directoryPerson(address, resolveAddress) {
  const hit = directoryCache.get(address);
  if (hit && Date.now() - hit.at < DIRECTORY_TTL_MS) return hit.person;
  let result;
  try {
    result = await resolveAddress(address);
  } catch {
    return false;
  }
  if (!result || result.status === 'unavailable') return false;
  const person = (result.status === 'found' || result.status === 'alias')
    && Boolean(String(result.jobTitle || '').trim() || String(result.department || '').trim());
  if (directoryCache.size >= DIRECTORY_CACHE_MAX) directoryCache.delete(directoryCache.keys().next().value);
  directoryCache.set(address, { person, at: Date.now() });
  return person;
}

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
 * Where this event's lists come from, and whether the To line is used.
 * `toLine`: 'used' | 'forwarded' | 'not_direct' | 'too_long' | 'none'.
 */
async function sourceLists(context, own) {
  const ticket = context?.ticket || {};
  const mail = context?.originalEmailRecipients;
  let cc;
  let to;
  let direct;
  let forwarded = false;
  if (mail && typeof mail === 'object') {
    cc = listOf(mail.ccEmails);
    to = listOf(mail.toEmails);
    direct = mail.viaMailbox === true;
  } else {
    cc = [...listOf(ticket.ccEmails), ...listOf(ticket.replyCcEmails)];
    to = listOf(ticket.toEmails);
    const entry = to.length ? await originalEmailEntry(ticket.id) : null;
    forwarded = Boolean(entry?.rawPayload?.forwarded);
    const evidence = entry?.rawPayload && (listOf(entry.rawPayload.to_emails).length || listOf(entry.rawPayload.cc_emails).length)
      ? [...listOf(entry.rawPayload.to_emails), ...listOf(entry.rawPayload.cc_emails)]
      : [...to, ...cc];
    direct = evidence.some((a) => isOwnAddress(bareAddress(a), own));
  }
  const toPeople = uniqueAddresses(to).filter((a) => !isOwnAddress(a, own));
  let toLine = 'used';
  if (!toPeople.length) toLine = 'none';
  else if (forwarded) toLine = 'forwarded';
  else if (!direct) toLine = 'not_direct';
  else if (toPeople.length > MAX_TO_LINE) toLine = 'too_long';
  return { cc, to: toLine === 'used' ? to : [], toLine };
}

/**
 * Everyone on the original e-mail for this event's ticket, cleaned (see the
 * header). Returns { list, leftOff, toLine } plus `unavailable: true` when our
 * mailbox list could not be read (the list is then empty).
 */
export async function resolveOriginalRecipients(context, { workspaceId = null, resolveAddress = null } = {}) {
  const ticket = context?.ticket || {};
  let own;
  try {
    own = await ownMailboxAddresses();
  } catch (err) {
    logger.warn(`Original recipients: our mailboxes not read in full, nobody is reached this time: ${err.message}`);
    return { list: [], leftOff: emptyLeftOff(), toLine: 'none', unavailable: true };
  }
  const { cc, to, toLine } = await sourceLists(context, own);
  const candidates = uniqueAddresses([...cc, ...to]);
  const wsId = workspaceId ?? context?.workspace?.id ?? ticket.workspaceId ?? null;
  const requesterEmail = context?.requester?.email || ticket?.requester?.email || ticket?.requesterEmail || null;
  if (!candidates.length) return { list: [], leftOff: emptyLeftOff(), toLine };

  const [machineEntries, requesters, removedByAgent, agents, members, wsDomains] = await Promise.all([
    machineEntriesFor(wsId), requestersAmong(candidates), agentRemovedCc(ticket.id), agentsAmong(wsId, candidates),
    membersAmong(candidates), workspaceInternalDomains(wsId),
  ]);
  // Our own domains: the workspace's, and those of our mailboxes.
  const internalDomains = [...new Set([...wsDomains, ...own.map(domainOf)])];
  const persons = new Set([...requesters.persons, ...members]);
  const options = {
    own, requesterEmail, machineEntries, unattended: requesters.unattended, removedByAgent, agents, internalDomains, persons,
  };

  // Internal addresses not yet known as people: ask the directory (bounded).
  const pending = filterOriginalRecipients(candidates, options);
  const unknownInternal = candidates.filter((a) => !pending.list.includes(a)
    && filterOriginalRecipients([a], { ...options, internalDomains: [] }).list.length === 1);
  if (unknownInternal.length) {
    const lookup = resolveAddress || await import('./azureAdService.js')
      .then((m) => (typeof m.default?.resolveAddress === 'function' ? (a) => m.default.resolveAddress(a) : null))
      .catch(() => null);
    if (lookup) {
      for (const address of unknownInternal.slice(0, DIRECTORY_LOOKUPS_PER_RUN)) {
        if (await directoryPerson(address, lookup)) persons.add(address);
      }
    }
  }
  return { ...filterOriginalRecipients(candidates, options), toLine };
}

/**
 * Keep one e-mail inside the send cap by leaving out people who are there only
 * as "everyone on the original e-mail" — last first, Cc, then Bcc, then To —
 * so the requester's own mail still goes. Returns the lists and how many were
 * left out.
 */
export function trimOriginalToCap({ to = [], cc = [], bcc = [] }, originalList = [], max = 25, keep = new Set()) {
  const original = new Set(listOf(originalList).map(lc));
  const lists = { to: [...to], cc: [...cc], bcc: [...bcc] };
  let over = lists.to.length + lists.cc.length + lists.bcc.length - max;
  let trimmed = 0;
  for (const key of ['cc', 'bcc', 'to']) {
    for (let i = lists[key].length - 1; i >= 0 && over > 0; i -= 1) {
      const address = lc(lists[key][i]);
      if (!original.has(address) || keep.has(address)) continue;
      lists[key].splice(i, 1);
      over -= 1;
      trimmed += 1;
    }
  }
  return { ...lists, trimmed };
}

export default {
  bareAddress, originalRecipientCandidates, isOwnAddress, filterOriginalRecipients, ownMailboxAddresses,
  invalidateOwnMailboxCache, agentRemovedFromHistory, resolveOriginalRecipients, trimOriginalToCap, MAX_TO_LINE,
};
