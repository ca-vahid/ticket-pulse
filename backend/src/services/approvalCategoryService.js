import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { DatabaseError, NotFoundError, ValidationError } from '../utils/errors.js';
import { MAX_TIERS, categoryTiers } from '../utils/approvalTiers.js';

const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
export { MAX_TIERS, categoryTiers };

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
   * Approvals v2: normalize a tier list. Up to MAX_TIERS tiers, each with a
   * name, a de-duped manager list and an optional approval limit (amount the
   * tier may finalise; above it an approval moves to the next tier). The last
   * tier never has a limit. Returns null for "single tier" (the pre-v2 shape).
   */
  _cleanTiers(input, hasAmount = false) {
    if (input === null || input === undefined) return null;
    const arr = Array.isArray(input) ? input : [];
    if (arr.length > MAX_TIERS) throw new ValidationError(`At most ${MAX_TIERS} approval tiers are supported`);
    const tiers = arr.map((t, i) => {
      const managerEmails = this._cleanEmails(t?.managerEmails);
      let limit = null;
      if (hasAmount && i < arr.length - 1 && t?.limit !== null && t?.limit !== undefined && t?.limit !== '') {
        limit = Number(t.limit);
        if (!Number.isFinite(limit) || limit < 0) throw new ValidationError(`Tier ${i + 1}: the approval limit must be a positive amount`);
        limit = Math.round(limit * 100) / 100;
      }
      return { name: String(t?.name || '').trim() || `Tier ${i + 1}`, managerEmails, limit };
    });
    if (tiers.length === 0) return null;
    tiers.forEach((t) => {
      if (t.managerEmails.length === 0) throw new ValidationError(`${t.name} needs at least one approver`);
    });
    for (let i = 1; i < tiers.length; i += 1) {
      const prev = tiers[i - 1].limit; const cur = tiers[i].limit;
      if (prev !== null && cur !== null && cur <= prev) {
        throw new ValidationError(`${tiers[i].name}: the limit must be higher than the one on ${tiers[i - 1].name}`);
      }
    }
    return tiers;
  }

  _cleanCurrency(input) {
    const cur = String(input || 'CAD').trim().toUpperCase();
    if (!/^[A-Z]{3}$/.test(cur)) throw new ValidationError('Currency must be a 3-letter code (e.g. CAD)');
    return cur;
  }

  // NOTE (QA 07-06 #7): managers no longer have to be workspace members.
  // Approvals key on email — anyone can decide via the emailed magic link, and
  // members/admins can also decide in-app — so admins/coordinators who aren't
  // technicians (e.g. app admins) are valid approval managers.

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
      select: { id: true, name: true, description: true, managerEmails: true, tiers: true, hasAmount: true, amountCurrency: true, gatesHardware: true },
      orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    });
  }

  async create(workspaceId, { name, description = null, managerEmails = [], sortOrder = 0, tiers = undefined, hasAmount = false, amountCurrency = 'CAD', gatesHardware = false }) {
    const trimmed = String(name || '').trim();
    if (trimmed.length < 2) throw new ValidationError('A category name is required');
    const monetary = hasAmount === true;
    const cleanTiers = this._cleanTiers(tiers, monetary);
    // Tier 1 always mirrors managerEmails so every pre-v2 reader keeps working.
    const emails = cleanTiers ? cleanTiers[0].managerEmails : this._cleanEmails(managerEmails);
    try {
      return await prisma.approvalCategory.create({
        data: {
          workspaceId,
          name: trimmed,
          description: description?.trim() || null,
          managerEmails: emails,
          sortOrder: Number(sortOrder) || 0,
          ...(cleanTiers ? { tiers: cleanTiers } : {}),
          hasAmount: monetary,
          amountCurrency: this._cleanCurrency(amountCurrency),
          gatesHardware: gatesHardware === true,
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
    }
    if (patch.isActive !== undefined) data.isActive = patch.isActive === true;
    if (patch.sortOrder !== undefined) data.sortOrder = Number(patch.sortOrder) || 0;
    if (patch.hasAmount !== undefined) data.hasAmount = patch.hasAmount === true;
    if (patch.gatesHardware !== undefined) data.gatesHardware = patch.gatesHardware === true;
    if (patch.amountCurrency !== undefined) data.amountCurrency = this._cleanCurrency(patch.amountCurrency);
    if (patch.tiers !== undefined) {
      const monetary = data.hasAmount !== undefined ? data.hasAmount : existing.hasAmount === true;
      const cleanTiers = this._cleanTiers(patch.tiers, monetary);
      // "Single tier" is stored as an empty list (Json null needs a sentinel).
      data.tiers = cleanTiers === null ? [] : cleanTiers;
      if (cleanTiers) data.managerEmails = cleanTiers[0].managerEmails;
    } else if (data.managerEmails && Array.isArray(existing.tiers) && existing.tiers.length > 0) {
      // Legacy caller patched managerEmails only → keep tier 1 in step.
      data.tiers = existing.tiers.map((t, i) => (i === 0 ? { ...t, managerEmails: data.managerEmails } : t));
    }
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
