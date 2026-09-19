import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { AuthorizationError } from '../utils/errors.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * "Own tickets only" (Simorgh SOC relations, B6 — Vahid, 19 Sep 2026).
 *
 * Simorgh's guard-rail says it only merges, splits, re-parents or links the
 * tickets it created. Until now that promise lived in Simorgh's code alone; a
 * merge closes a ticket, so a bug there could close a person's ticket. With
 * `structureOwnTicketsOnly` on the OAuth client, Ticket Pulse enforces it: every
 * ticket an operation would CHANGE must have been created by that client.
 *
 * "Created by" is the `created` history row's actorEmail, which the v1 create
 * path stamps as `apikey:<client id>` (the same value the resubmission matcher
 * keys on) — no schema change, and it covers every ticket the client has ever
 * filed. A ticket that merely gets pointed AT (the far end of a related_to link)
 * is not changed and is not checked.
 */
export const NOT_CLIENT_TICKET = 'not_client_ticket';

export function guardApplies(apiKey) {
  return Boolean(apiKey?.structureOwnTicketsOnly === true && apiKey?.keyPrefix);
}

/** Ids of the given tickets that this principal did NOT create. */
export async function ticketsNotCreatedBy(apiKey, ticketIds) {
  const ids = [...new Set((ticketIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (!ids.length) return [];
  const principal = `apikey:${apiKey.keyPrefix}`;
  const rows = await prisma.ticketActivity.findMany({
    where: { ticketId: { in: ids }, activityType: 'created' },
    select: { ticketId: true, details: true },
  });
  const mine = new Set(rows.filter((r) => r?.details?.actorEmail === principal).map((r) => r.ticketId));
  return ids.filter((id) => !mine.has(id));
}

/**
 * Throw 403 `not_client_ticket` when the client is restricted and any of the
 * tickets it is about to change is not its own. No-op for unrestricted callers.
 */
export async function assertClientMayStructure(apiKey, ticketIds, action = 'change') {
  if (!guardApplies(apiKey)) return;
  const foreign = await ticketsNotCreatedBy(apiKey, ticketIds);
  if (!foreign.length) return;
  const rows = await prisma.ticket.findMany({
    where: { id: { in: foreign } },
    select: { id: true, origin: true, nativeNumber: true, freshserviceTicketId: true },
  }).catch(() => []);
  const refs = foreign.map((id) => {
    const row = rows.find((r) => r.id === id);
    return row ? ticketDisplayRef(row) : String(id);
  });
  logger.info(`Structure guard: ${apiKey.name || apiKey.keyPrefix} may not ${action} ${refs.join(', ')} — not created by this client`);
  throw new AuthorizationError(
    `This client may only ${action} tickets it created. Not yours: ${refs.join(', ')}.`,
    NOT_CLIENT_TICKET,
  );
}

export default { guardApplies, ticketsNotCreatedBy, assertClientMayStructure, NOT_CLIENT_TICKET };
