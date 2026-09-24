/**
 * External references on a ticket (Sentinel integration, 24 Sep 2026, R9):
 * a ticket can belong to many records in another system — one monitoring
 * alert fires as many Sentinel incidents, and one incident can hold alerts
 * that belong to different tickets. Each row is one (system, record, alert).
 *
 * `refKey` makes adding idempotent: the alert id when there is one (an alert
 * is recorded ONCE per workspace, whichever ticket it landed on — a retried
 * call finds it), else "<externalId>#<ticketId>" for incident-level links.
 */
import prisma from './prisma.js';

export const MAX_REFERENCES_PER_CALL = 50;

const clip = (v, n) => (v === undefined || v === null || v === '' ? null : String(v).trim().slice(0, n) || null);

/** Validate + normalise one reference from an API body. Throws { field, message } errors. */
export function normalizeReference(raw, { defaultSystem = null } = {}) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw Object.assign(new Error('A reference must be an object'), { validation: true, field: 'reference' });
  const system = clip(raw.system ?? defaultSystem, 50);
  const externalId = clip(raw.externalId ?? raw.incidentId, 200);
  if (!system) throw Object.assign(new Error('reference.system is required (e.g. "sentinel")'), { validation: true, field: 'reference.system' });
  if (!externalId) throw Object.assign(new Error('reference.incidentId (or externalId) is required'), { validation: true, field: 'reference.incidentId' });
  let occurredAt = null;
  if (raw.time ?? raw.occurredAt) {
    occurredAt = new Date(raw.time ?? raw.occurredAt);
    if (Number.isNaN(occurredAt.getTime())) throw Object.assign(new Error('reference.time must be an ISO datetime'), { validation: true, field: 'reference.time' });
  }
  const url = clip(raw.url, 1000);
  if (url && !/^https:\/\//i.test(url)) throw Object.assign(new Error('reference.url must be an https URL'), { validation: true, field: 'reference.url' });
  return {
    system: system.toLowerCase(),
    externalId,
    number: clip(raw.number ?? raw.incidentNumber, 50),
    alertId: clip(raw.alertId, 200),
    url,
    occurredAt,
  };
}

function refKeyOf(ref, ticketId) {
  return ref.alertId ? `alert:${ref.alertId}` : `record:${ref.externalId}#${ticketId}`;
}

/** Which ticket already holds this alert (idempotent replays)? null when none. */
export async function findTicketIdForAlert(workspaceId, system, alertId) {
  if (!alertId) return null;
  const row = await prisma.ticketExternalReference.findFirst({
    where: { workspaceId, system: String(system).toLowerCase(), refKey: `alert:${alertId}` },
    select: { ticketId: true },
  });
  return row?.ticketId ?? null;
}

/** Add references; duplicates are skipped. Returns { added, skipped }. */
export async function addReferences(ticketId, workspaceId, refs, actorEmail = null) {
  if (!refs.length) return { added: 0, skipped: 0 };
  const data = refs.map((r) => ({
    ticketId, workspaceId, system: r.system, externalId: r.externalId, number: r.number, alertId: r.alertId,
    url: r.url, occurredAt: r.occurredAt, refKey: refKeyOf(r, ticketId), createdBy: actorEmail,
  }));
  const result = await prisma.ticketExternalReference.createMany({ data, skipDuplicates: true });
  return { added: result.count, skipped: data.length - result.count };
}

export async function listReferences(ticketId, workspaceId) {
  const rows = await prisma.ticketExternalReference.findMany({
    where: { ticketId, workspaceId },
    orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
  });
  return rows.map(shapeReference);
}

/** Ticket ids linked to one external record (e.g. every ticket from Sentinel incident X). */
export async function ticketIdsForRecord(workspaceId, system, externalId) {
  const rows = await prisma.ticketExternalReference.findMany({
    where: { workspaceId, system: String(system).toLowerCase(), externalId: String(externalId) },
    select: { ticketId: true },
    distinct: ['ticketId'],
  });
  return rows.map((r) => r.ticketId);
}

export function shapeReference(r) {
  return {
    id: r.id,
    system: r.system,
    incidentId: r.externalId,
    incidentNumber: r.number,
    alertId: r.alertId,
    url: r.url,
    time: r.occurredAt,
    addedAt: r.createdAt,
  };
}

export default { normalizeReference, findTicketIdForAlert, addReferences, listReferences, ticketIdsForRecord, shapeReference, MAX_REFERENCES_PER_CALL };
