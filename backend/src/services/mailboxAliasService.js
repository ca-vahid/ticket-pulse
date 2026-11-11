import prisma from './prisma.js';
import settingsRepository from './settingsRepository.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';
import { TICKET_ORIGIN } from '../utils/ticketOrigin.js';

/**
 * "Also known as" addresses of a connected mailbox (11 Nov 2026).
 *
 * People write to a team's public address (receivables@); a rule in Exchange
 * delivers that mail into the mailbox Ticket Pulse reads (ar-tickets@). The
 * ingest only knew the mailbox's own address, so a mail that copied the public
 * address looked like the mailbox had been Bcc'd and was held, and the public
 * address was offered as a requester. Fourteen of the sixteen e-mails held for
 * one team on 11 Nov 2026 were exactly that.
 *
 * Stored per connection in app_settings (`mailbox_aliases_<connectionId>`,
 * comma separated), so no migration. The ingest attaches the list to the
 * connection (`connection.aliases`) and every "is this the mailbox" test reads
 * it through agentIntakeService.mailboxAddresses.
 */
export const MAX_ALIASES = 10;
const CACHE_TTL_MS = 60 * 1000;
const EMAIL_SHAPE = /^[^\s@<>+,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;
const ROBOT = /(mailer-daemon|postmaster|no-?reply|donotreply|do-not-reply)@/i;
const SUGGEST_DAYS = 60;
const SUGGEST_MIN_MAILS = 3;
const SUGGEST_MAX = 5;

const cache = new Map(); // connectionId -> { value: string[], at }

export const aliasSettingKey = (connectionId) => `mailbox_aliases_${Number(connectionId) || 0}`;

const lc = (s) => String(s || '').trim().toLowerCase();
const domainOf = (address) => address.slice(address.lastIndexOf('@') + 1);

/** A stored or typed list as distinct lowercase addresses (anything that is not an address is dropped). */
export function parseAliasList(raw) {
  const parts = Array.isArray(raw) ? raw : String(raw || '').split(/[,;\s]+/);
  return [...new Set(parts.map(lc).filter((a) => EMAIL_SHAPE.test(a)))];
}

/** The mailbox's also-known-as addresses. Cached for a minute; never throws (a failed read is "none"). */
export async function getMailboxAliases(connectionId, { fresh = false } = {}) {
  const id = Number(connectionId);
  if (!Number.isInteger(id) || id <= 0) return [];
  const hit = cache.get(id);
  if (!fresh && hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.value;
  let value = [];
  try {
    value = parseAliasList(await settingsRepository.get(aliasSettingKey(id)));
  } catch (err) {
    logger.warn(`mailboxAliasService: aliases of mailbox ${id} not read (treated as none): ${err.message}`);
    return [];
  }
  cache.set(id, { value, at: Date.now() });
  return value;
}

/** The connection with `aliases` attached. */
export async function withAliases(connection) {
  if (!connection || Array.isArray(connection.aliases)) return connection;
  const aliases = await getMailboxAliases(connection.id);
  return aliases.length ? { ...connection, aliases } : connection;
}

export function invalidateAliasCache(connectionId = null) {
  if (connectionId === null) cache.clear();
  else cache.delete(Number(connectionId));
}

/** Aliases of every OTHER connected mailbox: address -> the mailbox that owns it. */
async function aliasesOfOtherMailboxes(connectionId) {
  const others = await prisma.mailboxConnection.findMany({ where: { id: { not: Number(connectionId) } }, select: { id: true, address: true } });
  const owned = new Map();
  for (const other of others) {
    // Read fresh: a save is checked against what is stored now, not a minute ago.
    for (const alias of await getMailboxAliases(other.id, { fresh: true })) owned.set(alias, lc(other.address));
  }
  return { others, owned };
}

/**
 * Replace the mailbox's also-known-as list. Every entry must be an address,
 * must not be the mailbox itself, another connected mailbox (or one of its
 * aliases), or a person on the team: an alias is never a requester and never a
 * Cc, so naming a person here would hide that person's mail.
 */
export async function setMailboxAliases(connection, list) {
  if (!connection?.id) throw new ValidationError('Mailbox not found');
  if (list !== null && list !== undefined && !Array.isArray(list) && typeof list !== 'string') {
    throw new ValidationError('aliases must be a list of e-mail addresses');
  }
  const typed = (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/)).map(lc).filter(Boolean);
  const bad = typed.find((a) => !EMAIL_SHAPE.test(a));
  if (bad) throw new ValidationError(`"${bad}" is not an e-mail address`);
  const next = [...new Set(typed)];
  if (next.length > MAX_ALIASES) throw new ValidationError(`A mailbox can have at most ${MAX_ALIASES} other addresses`);

  const own = lc(connection.address);
  if (next.includes(own)) throw new ValidationError(`${own} is this mailbox's own address`);
  if (next.length) {
    const { others, owned } = await aliasesOfOtherMailboxes(connection.id);
    const clash = next.find((a) => others.some((o) => lc(o.address) === a));
    if (clash) throw new ValidationError(`${clash} is a connected mailbox of its own`);
    const taken = next.find((a) => owned.has(a));
    if (taken) throw new ValidationError(`${taken} is already another address of ${owned.get(taken)}`);
    const person = await prisma.technician.findFirst({
      where: { workspaceId: connection.workspaceId, isActive: true, email: { in: next, mode: 'insensitive' } },
      select: { email: true },
    });
    if (person) throw new ValidationError(`${lc(person.email)} is a person on this team, not another address of the mailbox`);
  }

  if (next.length) await settingsRepository.set(aliasSettingKey(connection.id), next.join(', '));
  else await settingsRepository.delete(aliasSettingKey(connection.id));
  cache.delete(Number(connection.id));
  return next;
}

/** Forget a removed mailbox's aliases. Never throws. */
export async function clearMailboxAliases(connectionId) {
  await Promise.resolve().then(() => settingsRepository.delete(aliasSettingKey(connectionId))).catch(() => {});
  cache.delete(Number(connectionId));
}

/**
 * Addresses that look like other names of this mailbox (read-only): the ones
 * that appear most often in the To/Cc of its recent mail (held e-mail, plus the
 * mail that became tickets), are on the organisation's own domain, and are
 * neither the mailbox, another connected mailbox, nor a known person.
 * Returns [{ address, count }], most frequent first. Never throws.
 */
export async function suggestMailboxAliases(connection, { days = SUGGEST_DAYS, limit = SUGGEST_MAX, minMails = SUGGEST_MIN_MAILS } = {}) {
  try {
    if (!connection?.id) return [];
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const own = lc(connection.address);
    const [ownLocal, ownDomain] = own.split('@');

    const [held, siblings, workspace, current] = await Promise.all([
      prisma.mailboxHeldMessage.findMany({
        where: { connectionId: connection.id, createdAt: { gte: since } },
        select: { toEmails: true, ccEmails: true },
        orderBy: { id: 'desc' },
        take: 2000,
      }),
      prisma.mailboxConnection.findMany({ select: { id: true, workspaceId: true, address: true, mode: true } }),
      prisma.workspace.findUnique({ where: { id: connection.workspaceId }, select: { internalDomains: true } }).catch(() => null),
      getMailboxAliases(connection.id),
    ]);

    // Mail that became a ticket has no mailbox on it. With one ingest mailbox in
    // the workspace every e-mail ticket is its mail; with several, only tickets
    // routed to this mailbox's own group count (else the sibling's public
    // address would be offered here).
    const ingestSiblings = siblings.filter((s) => s.workspaceId === connection.workspaceId && s.id !== connection.id && ['ingest', 'both'].includes(s.mode));
    const routing = connection.defaultGroupId ? { groupId: BigInt(connection.defaultGroupId) }
      : connection.defaultInternalGroupId ? { internalGroupId: connection.defaultInternalGroupId } : null;
    const tickets = (!ingestSiblings.length || routing)
      ? await prisma.ticket.findMany({
        where: {
          workspaceId: connection.workspaceId,
          origin: TICKET_ORIGIN.TICKETPULSE,
          createdAt: { gte: since },
          ...(ingestSiblings.length ? routing : {}),
          OR: [{ toEmails: { isEmpty: false } }, { ccEmails: { isEmpty: false } }],
        },
        select: { toEmails: true, ccEmails: true },
        orderBy: { id: 'desc' },
        take: 3000,
      }).catch(() => [])
      : [];

    const tally = new Map();
    for (const mail of [...held, ...tickets]) {
      const addresses = new Set([...(Array.isArray(mail.toEmails) ? mail.toEmails : []), ...(Array.isArray(mail.ccEmails) ? mail.ccEmails : [])].map(lc));
      // Another name of the mailbox is how the mail GOT here: it shows on mail
      // that does not name the mailbox itself. An address that only ever sits
      // next to the mailbox's own (a team someone also copied) is a co-recipient.
      if ([...addresses].some((a) => a === own || a.startsWith(`${ownLocal}+`))) continue;
      for (const a of addresses) tally.set(a, (tally.get(a) || 0) + 1);
    }

    const domains = new Set([ownDomain, ...(Array.isArray(workspace?.internalDomains) ? workspace.internalDomains : []).map(lc)].filter(Boolean));
    const ownDomainOk = (a) => [...domains].some((d) => domainOf(a) === d || domainOf(a).endsWith(`.${d}`));
    const mailboxes = new Set(siblings.map((s) => lc(s.address)));
    const taken = new Set(current);
    for (const s of siblings) if (s.id !== connection.id) for (const a of await getMailboxAliases(s.id)) taken.add(a);

    let candidates = [...tally.entries()]
      .filter(([a, n]) => n >= minMails
        && EMAIL_SHAPE.test(a)
        && a !== own
        && !a.startsWith(`${ownLocal}+`)
        && ownDomainOk(a)
        && !mailboxes.has(a)
        && !taken.has(a)
        && !ROBOT.test(a))
      .sort((x, y) => y[1] - x[1])
      .slice(0, 40);
    if (!candidates.length) return [];

    // A known person is never another name of a mailbox: anyone who is (or was)
    // a technician, and any requester the directory describes as a person. A
    // shared address that once became a requester has no job title or
    // department, and stays a candidate.
    const addresses = candidates.map(([a]) => a);
    const [technicians, people] = await Promise.all([
      prisma.technician.findMany({ where: { email: { in: addresses, mode: 'insensitive' } }, select: { email: true } }).catch(() => []),
      prisma.requester.findMany({
        where: { email: { in: addresses, mode: 'insensitive' } },
        select: { email: true, entraJobTitle: true, entraDepartment: true },
      }).then((rows) => rows.filter((r) => String(r.entraJobTitle || '').trim() || String(r.entraDepartment || '').trim())).catch(() => []),
    ]);
    const persons = new Set([...technicians, ...people].map((p) => lc(p.email)));
    candidates = candidates.filter(([a]) => !persons.has(a));

    return candidates.slice(0, limit).map(([address, count]) => ({ address, count }));
  } catch (err) {
    logger.warn(`mailboxAliasService: suggestions for mailbox ${connection?.id} failed (none offered): ${err.message}`);
    return [];
  }
}

export default {
  aliasSettingKey, parseAliasList, getMailboxAliases, withAliases, setMailboxAliases, clearMailboxAliases,
  suggestMailboxAliases, invalidateAliasCache, MAX_ALIASES,
};
