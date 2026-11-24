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
 *     when it is a requester the directory described (not marked missing, with
 *     a job title or department), a member, or an enabled directory account
 *     with a job title or department (a list or shared mailbox is not). The
 *     directory gets 3 s per call and 6 s per run; the rest stay out;
 *   - repeats, compared case-insensitively.
 *
 * Never throws, and fails safe. Nobody is reached (an empty list, with
 * `unavailable` naming the check) when our mailbox list, the agent check or
 * the "taken off the Cc" history cannot be read. A failed requester check
 * leaves out every address outside our domains (it could be an automation's
 * mailbox). Other failed lookups skip that one check.
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
const DIRECTORY_UNAVAILABLE_TTL_MS = 10 * 60 * 1000;
const DIRECTORY_CACHE_MAX = 1000;
const DIRECTORY_LOOKUPS_PER_RUN = 10;
// Directory lookups run inside ticket creation: each Graph call gets 3 s, and
// all of one run's lookups 6 s; what is left unchecked is left out.
export const DIRECTORY_CALL_TIMEOUT_MS = 3000;
export const DIRECTORY_BUDGET_MS = 6000;
let ownCache = null; // { value: string[], at }
let lastGoodOwn = null; // the last list that loaded, kept past the TTL (staleOk callers)
let ownWorkspaceIds = []; // workspaces of the enabled mailboxes in that list
let ownFailure = null; // { error, at }: a failed read, remembered OWN_FAILURE_TTL_MS
export const OWN_FAILURE_TTL_MS = 10 * 1000;
const directoryCache = new Map(); // address -> { person, until }

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
  ownMailbox: 0, agent: 0, requester: 0, automated: 0, unattended: 0, removedByAgent: 0, notAPerson: 0, unchecked: 0,
});

/**
 * The pure part: filter the candidates. Returns the list kept and how many were
 * left out for each reason (counts only, so a Preview can say why).
 * `internalDomains`: our own domains; an address on one is kept only when it is
 * in `persons`.
 */
export function filterOriginalRecipients(candidates, {
  own = [], requesterEmail = null, machineEntries = [], unattended = new Set(), removedByAgent = new Set(),
  agents = new Set(), internalDomains = [], persons = new Set(), externalUnchecked = false,
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
    if (isInternal(address)) {
      if (!persons.has(address)) { leftOff.notAPerson += 1; continue; }
    } else if (externalUnchecked) {
      // The requester check failed: an outside address could be an automation's mailbox.
      leftOff.unchecked += 1;
      continue;
    }
    list.push(address);
  }
  return { list, leftOff };
}

/**
 * Every address that is a mailbox of ours: each ENABLED connected mailbox in
 * any workspace (a disabled connection is no longer ours, 24 Nov 2026), its
 * also-known-as addresses, and the global sender (the sendgrid_from_email
 * setting, then the environment). Cached for a minute, and only when every
 * read succeeded: any failure throws and caches nothing.
 *
 * `staleOk` (the mail-loop guard, 24 Nov 2026): when a read fails, the last
 * list that loaded is returned however old it is, and only when none ever
 * loaded does the call throw. "Everyone on the original e-mail" leaves it off:
 * a failure there still reaches nobody.
 *
 * A failed read is remembered for OWN_FAILURE_TTL_MS (10 s): until then every
 * caller gets the same failure without asking the database again, so an outage
 * does not cost a query per message and per delivery.
 */
export async function ownMailboxAddresses({ fresh = false, staleOk = false } = {}) {
  if (!fresh && ownCache && Date.now() - ownCache.at < OWN_CACHE_TTL_MS) return ownCache.value;
  try {
    if (!fresh && ownFailure && Date.now() - ownFailure.at < OWN_FAILURE_TTL_MS) throw ownFailure.error;
    try {
      return await loadOwnMailboxAddresses();
    } catch (err) {
      ownFailure = { error: err, at: Date.now() };
      throw err;
    }
  } catch (err) {
    if (staleOk && lastGoodOwn) {
      logger.warn(`Own-mailbox list could not be read (${err.message}); using the last list that loaded (${lastGoodOwn.value.length} addresses, ${Math.round((Date.now() - lastGoodOwn.at) / 1000)} s old)`);
      return lastGoodOwn.value;
    }
    throw err;
  }
}

async function loadOwnMailboxAddresses() {
  const boxes = await prisma.mailboxConnection.findMany({ where: { isEnabled: true }, select: { id: true, address: true, workspaceId: true } });
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
  lastGoodOwn = ownCache;
  ownFailure = null;
  ownWorkspaceIds = [...new Set(listOf(boxes).map((b) => Number(b?.workspaceId)).filter((n) => Number.isInteger(n) && n > 0))];
  return value;
}

/** Workspaces with an enabled mailbox, from the last list that loaded ([] before one did). */
export function ownMailboxWorkspaceIds() {
  return [...ownWorkspaceIds];
}

/**
 * Forget the cached list (and a remembered failure), so the next call reads
 * again. Called when a mailbox connection is created, enabled, disabled,
 * deleted or its aliases change. `{ keepLastGood: true }` keeps the last list
 * that loaded as the fallback for a failed read (what those callers want: a
 * slightly old list beats none).
 */
export function invalidateOwnMailboxCache({ keepLastGood = false } = {}) {
  ownCache = null;
  ownFailure = null;
  if (!keepLastGood) {
    lastGoodOwn = null;
    ownWorkspaceIds = [];
  }
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

/** Fails loudly (the caller then reaches nobody): a missed removal would mail someone an agent took off. */
async function agentRemovedCc(ticketId) {
  const id = Number(ticketId);
  if (!Number.isInteger(id) || id <= 0) return new Set();
  const [replies, ccChanges] = await Promise.all([
    prisma.ticketThreadEntry.findMany({
      where: { ticketId: id, source: 'ticketpulse_user', eventType: 'reply', isPrivate: false },
      select: { occurredAt: true, rawPayload: true },
      orderBy: { occurredAt: 'desc' },
      take: HISTORY_ROWS,
    }),
    prisma.ticketActivity.findMany({
      where: { ticketId: id, activityType: 'cc_changed' },
      select: { performedAt: true, details: true },
      orderBy: { performedAt: 'desc' },
      take: HISTORY_ROWS,
    }),
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

/** Fails loudly (the caller then reaches nobody): a missed agent would get requester mail. */
async function agentsAmong(workspaceId, addresses) {
  const id = Number(workspaceId);
  if (!addresses.length || !Number.isInteger(id) || id <= 0) return new Set();
  const rows = await prisma.technician.findMany({
    where: { workspaceId: id, isActive: true, email: { in: addresses, mode: 'insensitive' } },
    select: { email: true },
  });
  return new Set(listOf(rows).map((r) => bareAddress(r.email)).filter(Boolean));
}

/**
 * A requester row is a person only when the directory described it: not
 * marked missing there, and with a job title or department. Anything else
 * (a list or shared mailbox that once wrote in) goes to the directory check.
 */
export function requesterIsPerson(row) {
  if (!row || row.unattended === true || row.isActive === false || row.suppressedAt || row.entraMissingAt) return false;
  return [row.entraJobTitle, row.entraDepartment, row.jobTitle, row.department].some((v) => String(v || '').trim());
}

/** Requester rows: the unattended ones, and the people. `failed` when they could not be read. */
async function requestersAmong(addresses) {
  const unattended = new Set();
  const persons = new Set();
  if (!addresses.length) return { unattended, persons, failed: false };
  let rows;
  try {
    rows = await prisma.requester.findMany({
      where: { email: { in: addresses, mode: 'insensitive' } },
      select: {
        email: true, unattended: true, isActive: true, suppressedAt: true, entraMissingAt: true,
        entraJobTitle: true, entraDepartment: true, jobTitle: true, department: true,
      },
    });
  } catch (err) {
    logger.warn(`Original recipients: requester check failed, addresses outside our domains are left out this time: ${err.message}`);
    return { unattended, persons, failed: true };
  }
  for (const row of listOf(rows)) {
    const address = bareAddress(row.email);
    if (!address) continue;
    if (row.unattended === true) unattended.add(address);
    else if (requesterIsPerson(row)) persons.add(address);
  }
  return { unattended, persons, failed: false };
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

/** Is this directory answer a person? An enabled account with a job title or department. */
export function directoryAnswerIsPerson(result) {
  return Boolean(result)
    && (result.status === 'found' || result.status === 'alias')
    && result.accountEnabled === true
    && Boolean(String(result.jobTitle || '').trim() || String(result.department || '').trim());
}

const remember = (address, person, ttl) => {
  if (directoryCache.size >= DIRECTORY_CACHE_MAX) directoryCache.delete(directoryCache.keys().next().value);
  directoryCache.set(address, { person, until: Date.now() + ttl });
};

/**
 * Is this internal address a person in the directory? Shared mailboxes and
 * lists are not (disabled account, or no title and no department). Answers
 * are cached six hours; "unavailable" (or an error) ten minutes, as not a
 * person. At most DIRECTORY_CACHE_MAX addresses.
 */
async function directoryPerson(address, resolveAddress) {
  const hit = directoryCache.get(address);
  if (hit && Date.now() < hit.until) return hit.person;
  let result;
  try {
    result = await resolveAddress(address);
  } catch {
    result = { status: 'unavailable' };
  }
  if (!result || result.status === 'unavailable') {
    remember(address, false, DIRECTORY_UNAVAILABLE_TTL_MS);
    return false;
  }
  const person = directoryAnswerIsPerson(result);
  remember(address, person, DIRECTORY_TTL_MS);
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

const nobody = (toLine, unavailable) => ({ list: [], leftOff: emptyLeftOff(), toLine, unavailable });

/**
 * Everyone on the original e-mail for this event's ticket, cleaned (see the
 * header). Returns { list, leftOff, toLine }. When a check that protects
 * people cannot be done the list is empty and `unavailable` names it:
 * 'mailboxes' (our mailbox list), 'agents' (the agent check) or 'cc_history'
 * (who an agent took off the Cc). A failed requester check leaves out the
 * addresses outside our domains (leftOff.unchecked).
 * `budgetMs`: the time all directory lookups of this run may take.
 */
export async function resolveOriginalRecipients(context, {
  workspaceId = null, resolveAddress = null, budgetMs = DIRECTORY_BUDGET_MS, callTimeoutMs = DIRECTORY_CALL_TIMEOUT_MS,
} = {}) {
  const ticket = context?.ticket || {};
  let own;
  try {
    own = await ownMailboxAddresses();
  } catch (err) {
    logger.warn(`Original recipients: our mailboxes not read in full, nobody is reached this time: ${err.message}`);
    return nobody('none', 'mailboxes');
  }
  const { cc, to, toLine } = await sourceLists(context, own);
  const candidates = uniqueAddresses([...cc, ...to]);
  const wsId = workspaceId ?? context?.workspace?.id ?? ticket.workspaceId ?? null;
  const requesterEmail = context?.requester?.email || ticket?.requester?.email || ticket?.requesterEmail || null;
  if (!candidates.length) return { list: [], leftOff: emptyLeftOff(), toLine };

  const failedCheck = (name) => (err) => {
    logger.warn(`Original recipients: ${name} check failed, nobody is reached this time: ${err.message}`);
    throw Object.assign(new Error(name), { failedCheck: name });
  };
  let machineEntries;
  let requesters;
  let removedByAgent;
  let agents;
  let members;
  let wsDomains;
  try {
    [machineEntries, requesters, removedByAgent, agents, members, wsDomains] = await Promise.all([
      machineEntriesFor(wsId),
      requestersAmong(candidates),
      agentRemovedCc(ticket.id).catch(failedCheck('cc_history')),
      agentsAmong(wsId, candidates).catch(failedCheck('agents')),
      membersAmong(candidates),
      workspaceInternalDomains(wsId),
    ]);
  } catch (err) {
    return nobody(toLine, err.failedCheck || 'agents');
  }
  // Our own domains: the workspace's, and those of our mailboxes.
  const internalDomains = [...new Set([...wsDomains, ...own.map(domainOf)])];
  const persons = new Set([...requesters.persons, ...members]);
  const options = {
    own, requesterEmail, machineEntries, unattended: requesters.unattended, removedByAgent, agents, internalDomains, persons,
    externalUnchecked: requesters.failed === true,
  };

  // Internal addresses not yet known as people: ask the directory, at most
  // DIRECTORY_LOOKUPS_PER_RUN addresses within budgetMs; the rest stay out.
  const pending = filterOriginalRecipients(candidates, options);
  const unknownInternal = candidates.filter((a) => !pending.list.includes(a)
    && filterOriginalRecipients([a], { ...options, internalDomains: [], externalUnchecked: false }).list.length === 1);
  if (unknownInternal.length) {
    const lookup = resolveAddress || await import('./azureAdService.js')
      .then((m) => (typeof m.default?.resolveAddress === 'function'
        ? (a) => m.default.resolveAddress(a, { timeoutMs: callTimeoutMs })
        : null))
      .catch(() => null);
    if (lookup) {
      const deadline = Date.now() + Math.max(0, Number(budgetMs) || 0);
      for (const address of unknownInternal.slice(0, DIRECTORY_LOOKUPS_PER_RUN)) {
        const left = deadline - Date.now();
        if (left <= 0) break;
        let timer;
        const outOfTime = new Promise((resolve) => { timer = setTimeout(() => resolve('out_of_time'), left); });
        const answer = await Promise.race([directoryPerson(address, lookup), outOfTime]);
        clearTimeout(timer);
        if (answer === 'out_of_time') {
          logger.info(`Original recipients: directory budget of ${budgetMs} ms used up; unchecked addresses on our domains are left out`);
          break;
        }
        if (answer) persons.add(address);
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
  invalidateOwnMailboxCache, ownMailboxWorkspaceIds, agentRemovedFromHistory, resolveOriginalRecipients, trimOriginalToCap, MAX_TO_LINE,
};
