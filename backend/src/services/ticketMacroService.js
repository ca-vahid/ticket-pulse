import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { NotFoundError, ValidationError } from '../utils/errors.js';

/**
 * Agent quick-action bundles (macros): one click applies status + priority +
 * assignment + an internal note together. Application reuses the SAME
 * origin-aware service paths as manual edits, so audits, events, the mirror
 * and SSE all behave exactly as if the agent did each step by hand.
 */
class TicketMacroService {
  async list(workspaceId, { includeInactive = false } = {}) {
    return prisma.ticketMacro.findMany({
      where: { workspaceId, ...(includeInactive ? {} : { isActive: true }) },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(workspaceId, { name, description, actions }, actor) {
    const cleanName = String(name || '').trim();
    if (!cleanName) throw new ValidationError('Macro needs a name');
    const cleanActions = this._validateActions(actions);
    return prisma.ticketMacro.create({
      data: { workspaceId, name: cleanName.slice(0, 120), description: description || null, actions: cleanActions, createdBy: actor?.email || null },
    });
  }

  async update(workspaceId, id, { name, description, actions, isActive }, _actor) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(id), workspaceId } });
    if (!macro) throw new NotFoundError('Macro not found');
    return prisma.ticketMacro.update({
      where: { id: macro.id },
      data: {
        ...(name !== undefined ? { name: String(name).trim().slice(0, 120) } : {}),
        ...(description !== undefined ? { description: description || null } : {}),
        ...(actions !== undefined ? { actions: this._validateActions(actions) } : {}),
        ...(isActive !== undefined ? { isActive: isActive !== false } : {}),
      },
    });
  }

  async remove(workspaceId, id) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(id), workspaceId } });
    if (!macro) throw new NotFoundError('Macro not found');
    await prisma.ticketMacro.delete({ where: { id: macro.id } });
    return { deleted: true };
  }

  /** Apply a macro to one ticket. Returns per-step results (partial success is visible, never silent). */
  async apply(ticketId, workspaceId, macroId, actor) {
    const macro = await prisma.ticketMacro.findFirst({ where: { id: Number(macroId), workspaceId, isActive: true } });
    if (!macro) throw new NotFoundError('Macro not found');
    const actions = macro.actions || {};
    const { default: ticketService } = await import('./ticketService.js');

    const steps = [];
    const step = async (label, fn) => {
      try {
        await fn();
        steps.push({ label, ok: true });
      } catch (error) {
        steps.push({ label, ok: false, error: error.message });
      }
    };

    if (actions.assignToTechnicianId !== undefined && actions.assignToTechnicianId !== null) {
      await step('assign', () => ticketService.assignTicket(ticketId, workspaceId, Number(actions.assignToTechnicianId), actor));
    }
    if (actions.setPriority) {
      await step('priority', () => ticketService.updateTicketFields(ticketId, workspaceId, { priority: Number(actions.setPriority) }, actor));
    }
    if (actions.addNote) {
      await step('note', () => ticketService.addPrivateNote(ticketId, workspaceId, { bodyText: String(actions.addNote) }, actor));
    }
    if (actions.replyBody) {
      await step('reply', () => ticketService.addReply(ticketId, workspaceId, { bodyText: String(actions.replyBody) }, actor));
    }
    // Status last so a resolve/close doesn't race the other writes.
    if (actions.setStatus) {
      await step('status', () => ticketService.changeStatus(ticketId, workspaceId, String(actions.setStatus), actor));
    }

    const failed = steps.filter((s) => !s.ok);
    logger.info(`Macro "${macro.name}" applied to ticket ${ticketId}: ${steps.length - failed.length}/${steps.length} steps ok`);
    return { macro: { id: macro.id, name: macro.name }, steps, ok: failed.length === 0 };
  }

  _validateActions(actions) {
    if (!actions || typeof actions !== 'object' || Array.isArray(actions)) {
      throw new ValidationError('Macro actions must be an object');
    }
    const allowed = ['setStatus', 'setPriority', 'assignToTechnicianId', 'addNote', 'replyBody'];
    const clean = {};
    for (const key of allowed) {
      if (actions[key] !== undefined && actions[key] !== null && actions[key] !== '') clean[key] = actions[key];
    }
    if (Object.keys(clean).length === 0) throw new ValidationError('Macro needs at least one action');
    if (clean.setStatus && !['Open', 'Pending', 'Resolved', 'Closed'].includes(clean.setStatus)) {
      throw new ValidationError('Macro status must be Open, Pending, Resolved or Closed');
    }
    if (clean.setPriority && !(Number(clean.setPriority) >= 1 && Number(clean.setPriority) <= 4)) {
      throw new ValidationError('Macro priority must be 1–4');
    }
    return clean;
  }
}

const ticketMacroService = new TicketMacroService();
export default ticketMacroService;
