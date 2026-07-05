import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError, ValidationError } from '../utils/errors.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * Per-workspace approval categories (e.g. "Laptop purchase") with designated
 * approval managers. A ticket approval request picks a category, which routes
 * to that category's managers (any one can approve). Admin-editable in Settings.
 * TP-only — never involves FreshService.
 */
class ApprovalCategoryService {
  /** Normalize + validate a manager email list into a de-duped, lowercased array. */
  _cleanEmails(input) {
    const arr = Array.isArray(input) ? input : [];
    const seen = new Set();
    const out = [];
    for (const raw of arr) {
      const email = String(raw || '').trim().toLowerCase();
      if (!email) continue;
      if (!EMAIL_RE.test(email)) throw new ValidationError(`"${email}" is not a valid email address`);
      if (!seen.has(email)) { seen.add(email); out.push(email); }
    }
    return out;
  }

  /**
   * Approval managers must be active members of the workspace (so they can act
   * in-app + be found in the members lookup). Rejects any email that isn't one.
   */
  async _assertActiveMembers(workspaceId, emails) {
    if (!emails.length) return;
    const techs = await prisma.technician.findMany({
      where: { workspaceId, isActive: true, email: { not: null } },
      select: { email: true },
    });
    const memberSet = new Set(techs.map((t) => (t.email || '').toLowerCase()));
    const missing = emails.filter((e) => !memberSet.has(e));
    if (missing.length) {
      throw new ValidationError(`Approval managers must be active members of this workspace: ${missing.join(', ')}`);
    }
  }

  /** All categories for a workspace (admin view), active first then by sort/name. */
  async list(workspaceId) {
    try {
      return await prisma.approvalCategory.findMany({
        where: { workspaceId },
        orderBy: [{ isActive: 'desc' }, { sortOrder: 'asc' }, { name: 'asc' }],
      });
    } catch (error) {
      logger.error('Error listing approval categories:', error);
      throw new DatabaseError('Failed to list approval categories', error);
    }
  }

  /** Active categories for the request picker: id, name, managerEmails only. */
  async getActive(workspaceId) {
    return prisma.approvalCategory.findMany({
      where: { workspaceId, isActive: true },
      select: { id: true, name: true, description: true, managerEmails: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(workspaceId, { name, description = null, managerEmails = [], sortOrder = 0 }) {
    const trimmed = String(name || '').trim();
    if (trimmed.length < 2) throw new ValidationError('A category name is required');
    const emails = this._cleanEmails(managerEmails);
    await this._assertActiveMembers(workspaceId, emails);
    try {
      return await prisma.approvalCategory.create({
        data: {
          workspaceId,
          name: trimmed,
          description: description?.trim() || null,
          managerEmails: emails,
          sortOrder: Number(sortOrder) || 0,
        },
      });
    } catch (error) {
      if (error.code === 'P2002') throw new ValidationError('An approval category with that name already exists');
      logger.error('Error creating approval category:', error);
      throw new DatabaseError('Failed to create approval category', error);
    }
  }

  async update(id, workspaceId, patch) {
    const existing = await prisma.approvalCategory.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundError('Approval category not found');
    const data = {};
    if (patch.name !== undefined) {
      const trimmed = String(patch.name || '').trim();
      if (trimmed.length < 2) throw new ValidationError('A category name is required');
      data.name = trimmed;
    }
    if (patch.description !== undefined) data.description = patch.description?.trim() || null;
    if (patch.managerEmails !== undefined) {
      data.managerEmails = this._cleanEmails(patch.managerEmails);
      await this._assertActiveMembers(workspaceId, data.managerEmails);
    }
    if (patch.isActive !== undefined) data.isActive = patch.isActive === true;
    if (patch.sortOrder !== undefined) data.sortOrder = Number(patch.sortOrder) || 0;
    try {
      return await prisma.approvalCategory.update({ where: { id }, data });
    } catch (error) {
      if (error.code === 'P2002') throw new ValidationError('An approval category with that name already exists');
      logger.error('Error updating approval category:', error);
      throw new DatabaseError('Failed to update approval category', error);
    }
  }

  async remove(id, workspaceId) {
    const existing = await prisma.approvalCategory.findFirst({ where: { id, workspaceId } });
    if (!existing) throw new NotFoundError('Approval category not found');
    // Existing approvals keep their history (approval_category_id → null on delete).
    await prisma.approvalCategory.delete({ where: { id } });
    return { removed: true };
  }
}

export default new ApprovalCategoryService();
