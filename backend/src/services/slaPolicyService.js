import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Ticket Pulse's own SLA targets for TP-born tickets: per-priority first-
 * response / resolution windows applied at creation (FS-born tickets keep
 * FreshService's SLA fields untouched). Escalation LADDERS are built as
 * workflows on the sla_pre_breach / sla_breach triggers with assignment and
 * priority actions — policy here only sets the clocks.
 */
class SlaPolicyService {
  async list(workspaceId) {
    return prisma.slaPolicy.findMany({
      where: { workspaceId },
      orderBy: { priority: 'desc' },
    });
  }

  async upsert(workspaceId, { priority, firstResponseMinutes, resolveMinutes, isActive = true }, actor) {
    const prio = Number(priority);
    if (!Number.isInteger(prio) || prio < 1 || prio > 4) throw new ValidationError('Priority must be 1–4');
    const fr = normalizedMinutes(firstResponseMinutes, 'First-response');
    const resolve = normalizedMinutes(resolveMinutes, 'Resolution');
    if (fr === null && resolve === null) throw new ValidationError('Set at least one SLA window');
    return prisma.slaPolicy.upsert({
      where: { workspaceId_priority: { workspaceId, priority: prio } },
      update: { firstResponseMinutes: fr, resolveMinutes: resolve, isActive: isActive !== false, updatedBy: actor?.email || null },
      create: {
        workspaceId,
        priority: prio,
        firstResponseMinutes: fr,
        resolveMinutes: resolve,
        isActive: isActive !== false,
        updatedBy: actor?.email || null,
      },
    });
  }

  async remove(workspaceId, priority) {
    await prisma.slaPolicy.deleteMany({ where: { workspaceId, priority: Number(priority) } });
    return { deleted: true };
  }

  /** Due dates for a new TP-born ticket, or nulls when no active policy. */
  async dueDatesFor(workspaceId, priority, from = new Date()) {
    const policy = await prisma.slaPolicy.findFirst({
      where: { workspaceId, priority: Number(priority) || 2, isActive: true },
    });
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
