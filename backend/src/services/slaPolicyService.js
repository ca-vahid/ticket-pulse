import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';
import ticketTypeService from './ticketTypeService.js';

/**
 * Ticket Pulse's own SLA targets for TP-born tickets: per-priority first-
 * response / resolution windows applied at creation (FS-born tickets keep
 * FreshService's SLA fields untouched). Escalation LADDERS are built as
 * workflows on the sla_pre_breach / sla_breach triggers with assignment and
 * priority actions — policy here only sets the clocks.
 *
 * Policies are keyed (workspace, priority, ticketTypeId) where a NULL
 * ticketTypeId is the "all types" fallback row. Matching walks: exact
 * type-specific policy -> fallback policy -> no clocks. Type-less tickets
 * (FS allows them) always use the fallback.
 */
class SlaPolicyService {
  async list(workspaceId) {
    return prisma.slaPolicy.findMany({
      where: { workspaceId },
      include: { ticketType: { select: { id: true, name: true, color: true, abbreviation: true, isActive: true } } },
      orderBy: [{ priority: 'desc' }, { ticketTypeId: { sort: 'asc', nulls: 'first' } }],
    });
  }

  async upsert(workspaceId, { priority, ticketTypeId = null, firstResponseMinutes, resolveMinutes, isActive = true }, actor) {
    const prio = Number(priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 4) throw new ValidationError('Priority must be 1–4');
    const fr = normalizedMinutes(firstResponseMinutes, 'First-response');
    const resolve = normalizedMinutes(resolveMinutes, 'Resolution');
    if (fr === null && resolve === null) throw new ValidationError('Set at least one SLA window');

    let typeId = null;
    if (ticketTypeId !== null && ticketTypeId !== undefined && ticketTypeId !== '') {
      typeId = Number(ticketTypeId);
      const type = await prisma.ticketTypeDefinition.findFirst({ where: { id: typeId, workspaceId } });
      if (!type) throw new ValidationError('Unknown ticket type for this workspace');
    }

    // The composite unique treats NULL type as distinct rows in Postgres, so
    // fallback-row upserts go through findFirst+update instead of upsert().
    const existing = await prisma.slaPolicy.findFirst({
      where: { workspaceId, priority: prio, ticketTypeId: typeId },
    });
    const fields = {
      firstResponseMinutes: fr,
      resolveMinutes: resolve,
      isActive: isActive !== false,
      updatedBy: actor?.email || null,
    };
    if (existing) {
      return prisma.slaPolicy.update({ where: { id: existing.id }, data: fields });
    }
    return prisma.slaPolicy.create({
      data: { workspaceId, priority: prio, ticketTypeId: typeId, ...fields },
    });
  }

  async remove(workspaceId, priority, ticketTypeId = null) {
    const typeId = ticketTypeId === null || ticketTypeId === undefined || ticketTypeId === ''
      ? null
      : Number(ticketTypeId);
    await prisma.slaPolicy.deleteMany({ where: { workspaceId, priority: Number(priority), ticketTypeId: typeId } });
    return { deleted: true };
  }

  /**
   * Due dates for a new TP-born ticket, or nulls when no active policy.
   * Pass the ticket's type via { typeName } (canonical string) or
   * { ticketTypeId }; omitted/unknown types use the fallback row.
   */
  async dueDatesFor(workspaceId, priority, from = new Date(), { typeName = null, ticketTypeId = null } = {}) {
    let typeId = ticketTypeId === null || ticketTypeId === undefined ? null : Number(ticketTypeId);
    if (typeId === null && typeName) {
      const def = await ticketTypeService.resolveType(workspaceId, typeName);
      typeId = def?.id ?? null;
    }

    const prio = Number(priority) || 2;
    let policy = null;
    if (typeId !== null) {
      policy = await prisma.slaPolicy.findFirst({
        where: { workspaceId, priority: prio, ticketTypeId: typeId, isActive: true },
      });
    }
    if (!policy) {
      policy = await prisma.slaPolicy.findFirst({
        where: { workspaceId, priority: prio, ticketTypeId: null, isActive: true },
      });
    }
    if (!policy) return { frDueBy: null, dueBy: null };
    const at = (minutes) => (minutes ? new Date(from.getTime() + minutes * 60 * 1000) : null);
    return { frDueBy: at(policy.firstResponseMinutes), dueBy: at(policy.resolveMinutes) };
  }
}

function normalizedMinutes(value, label) {
  if (value === null || value === undefined || value === '') return null;
  const minutes = Number(value);
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 60 * 24 * 60) {
    throw new ValidationError(`${label} window must be between 5 minutes and 60 days`);
  }
  return minutes;
}

const slaPolicyService = new SlaPolicyService();
export default slaPolicyService;
