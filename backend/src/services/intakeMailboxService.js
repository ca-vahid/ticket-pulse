/**
 * The mailbox a ticket came in through (QA 11-24 item 11) — the "Intake
 * mailbox" workflow condition. Accounting wants to skip the e-mail
 * notifications for tickets that arrived on the AR mailbox but keep them for AP.
 *
 * Where it is read from, first hit wins:
 *   1. in memory on "Ticket arrived": mail intake hands it to createTicket,
 *      which puts it on the ticket.created context (ticket.intakeMailbox);
 *   2. the ticket's `created` activity row, details.intakeMailbox (written by
 *      createTicket from 24 Nov 2026 on);
 *   3. the opening e-mail's thread entry (source email_inbound, eventType
 *      original_email), rawPayload.intakeMailbox (same date);
 *   4. older tickets: that entry's To / Cc (rawPayload.to_emails / cc_emails,
 *      kept since QA 08-05 #3) matched against this workspace's connected
 *      mailboxes and their aliases, To first.
 * Nothing found = null: a ticket that did not come by e-mail (app, API,
 * Teams, FreshService) never matches "is X" and always matches "is not X".
 *
 * The value is the mailbox ADDRESS, lower-case (it reads in run explanations
 * and survives a mailbox being disconnected and connected again).
 */
import prisma from './prisma.js';
import logger from '../utils/logger.js';

export const INTAKE_MAILBOX_FIELD = 'ticket.intakeMailbox';

const lc = (v) => String(v || '').trim().toLowerCase();

/** A bare lower-case address from "Name <a@b>" / "a@b"; '' when none. */
function bare(value) {
  const text = String(value || '').trim();
  const angle = text.match(/<([^<>]*)>/);
  const address = lc((angle ? angle[1] : text).replace(/^mailto:/i, ''));
  return /^[^@\s]+@[^@\s]+$/.test(address) ? address : '';
}

/** `address` is `own` or a +tag variant of it. */
function sameMailbox(address, own) {
  const a = bare(address);
  const base = lc(own);
  if (!a || !base) return false;
  if (a === base) return true;
  const tagged = a.match(/^([^@+]+)\+[^@]*@(.+)$/);
  const [local, domain] = base.split('@');
  return Boolean(tagged) && tagged[1] === local && tagged[2] === domain;
}

/** The stored shape: { connectionId, address } from a connection. */
export function intakeMailboxRecord(connection) {
  const address = lc(connection?.address);
  if (!address) return null;
  const id = Number(connection?.id);
  return { connectionId: Number.isInteger(id) && id > 0 ? id : null, address };
}

function addressFrom(value) {
  if (!value) return null;
  if (typeof value === 'string') return lc(value) || null;
  if (typeof value === 'object') return lc(value.address) || null;
  return null;
}

const listOf = (v) => (Array.isArray(v) ? v : v ? [v] : []);

/**
 * Pure: which of `mailboxes` ([{ address, aliases? }]) the opening e-mail was
 * addressed to, To before Cc, else null.
 */
export function matchIntakeMailbox(toEmails, ccEmails, mailboxes = []) {
  for (const recipient of [...listOf(toEmails), ...listOf(ccEmails)]) {
    for (const box of mailboxes) {
      const names = [box?.address, ...listOf(box?.aliases)];
      if (names.some((own) => sameMailbox(recipient, own))) return lc(box.address);
    }
  }
  return null;
}

async function mailboxesWithAliases(workspaceId) {
  const rows = await prisma.mailboxConnection.findMany({
    where: { workspaceId: Number(workspaceId) },
    select: { id: true, address: true },
    orderBy: [{ isPrimary: 'desc' }, { id: 'asc' }],
  });
  let getAliases = null;
  try {
    ({ getMailboxAliases: getAliases } = await import('./mailboxAliasService.js'));
  } catch { /* addresses only */ }
  return Promise.all((rows || []).map(async (row) => ({
    ...row,
    aliases: getAliases ? await getAliases(row.id).catch(() => []) : [],
  })));
}

/**
 * The intake mailbox address of a ticket, or null. Never throws.
 * @param {{ id: number, workspaceId?: number, intakeMailbox?: string|object|null }} ticket
 */
export async function intakeMailboxFor(ticket) {
  if (!ticket) return null;
  if (ticket.intakeMailbox !== undefined) return addressFrom(ticket.intakeMailbox);
  const ticketId = Number(ticket.id);
  if (!Number.isInteger(ticketId) || ticketId <= 0) return null;
  try {
    const created = await prisma.ticketActivity.findFirst({
      where: { ticketId, activityType: 'created' },
      orderBy: { performedAt: 'asc' },
      select: { details: true },
    });
    const fromAudit = addressFrom(created?.details?.intakeMailbox);
    if (fromAudit) return fromAudit;

    const opening = await prisma.ticketThreadEntry.findFirst({
      where: { ticketId, source: 'email_inbound', eventType: 'original_email' },
      orderBy: { occurredAt: 'asc' },
      select: { rawPayload: true, workspaceId: true },
    });
    const raw = opening?.rawPayload && typeof opening.rawPayload === 'object' ? opening.rawPayload : null;
    if (!raw) return null;
    const fromEntry = addressFrom(raw.intakeMailbox);
    if (fromEntry) return fromEntry;
    const to = raw.to_emails || raw.toEmails;
    const cc = raw.cc_emails || raw.ccEmails;
    if (!listOf(to).length && !listOf(cc).length) return null;
    const workspaceId = ticket.workspaceId ?? opening.workspaceId;
    if (!workspaceId) return null;
    return matchIntakeMailbox(to, cc, await mailboxesWithAliases(workspaceId));
  } catch (error) {
    logger.warn(`Intake mailbox not read for ticket ${ticketId} (the condition sees none): ${error.message}`);
    return null;
  }
}

/**
 * Mailbox connections as { value: address, label } pick-list options for the
 * condition builder ("AR team (ar@example.com)", "…, disconnected").
 */
export function mailboxConditionOptions(rows) {
  const seen = new Set();
  const out = [];
  for (const row of rows || []) {
    const address = lc(row?.address);
    if (!address || seen.has(address)) continue;
    seen.add(address);
    const name = String(row?.displayName || '').trim();
    const label = `${name && name.toLowerCase() !== address ? `${name} (${address})` : address}${row?.isEnabled === false ? ', disconnected' : ''}`;
    out.push({ value: address, label });
  }
  return out;
}

/** Does a condition group (nested groups included) name the intake mailbox? */
export function groupReadsIntakeMailbox(group) {
  if (!group || typeof group !== 'object') return false;
  return (Array.isArray(group.conditions) ? group.conditions : []).some((entry) => (
    entry && Array.isArray(entry.conditions) ? groupReadsIntakeMailbox(entry) : String(entry?.field || '') === INTAKE_MAILBOX_FIELD
  ));
}

/** The evaluation scope with ticket.intakeMailbox filled in. Never throws. */
export async function withIntakeMailbox(scope, eventContext) {
  if (scope?.ticket && scope.ticket.intakeMailbox !== undefined) return scope;
  const ticket = eventContext?.ticket || scope?.ticket || null;
  const address = await intakeMailboxFor({ ...(ticket || {}), workspaceId: ticket?.workspaceId ?? eventContext?.workspace?.id ?? null });
  return { ...scope, ticket: { ...(scope?.ticket || {}), intakeMailbox: address } };
}

export default {
  INTAKE_MAILBOX_FIELD,
  intakeMailboxRecord,
  matchIntakeMailbox,
  mailboxConditionOptions,
  intakeMailboxFor,
  groupReadsIntakeMailbox,
  withIntakeMailbox,
};
