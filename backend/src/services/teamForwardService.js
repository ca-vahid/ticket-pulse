import prisma from './prisma.js';
import logger from '../utils/logger.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Team forwards (QA 09-25 item 6): per-workspace "Forward to <team>"
 * destinations — e.g. "Digital Solutions Team" in IT. A row without an
 * address is kept (the team exists, its inbox doesn't yet) but never offered
 * on the ticket page.
 */

const MAX_ROWS = 20;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function cleanRow(row, index) {
  const label = String(row?.label ?? '').trim();
  if (!label) throw new ValidationError(`Team forward ${index + 1}: a name is required`);
  if (label.length > 120) throw new ValidationError(`Team forward ${index + 1}: name is too long (120 max)`);
  const emailRaw = String(row?.email ?? '').trim().toLowerCase();
  if (emailRaw && !EMAIL_RE.test(emailRaw)) throw new ValidationError(`Team forward "${label}": "${emailRaw}" is not an e-mail address`);
  if (emailRaw.length > 255) throw new ValidationError(`Team forward "${label}": address is too long`);
  return {
    id: Number.isInteger(Number(row?.id)) && Number(row.id) > 0 ? Number(row.id) : null,
    label,
    email: emailRaw || null,
    enabled: row?.enabled !== false,
  };
}

const teamForwardService = {
  async list(workspaceId) {
    return Promise.resolve()
      .then(() => prisma.teamForward.findMany({
        where: { workspaceId },
        orderBy: [{ label: 'asc' }, { id: 'asc' }],
        select: { id: true, label: true, email: true, enabled: true, updatedAt: true },
      }))
      .catch((err) => {
        logger.debug?.(`Team forwards unavailable: ${err.message}`);
        return [];
      });
  },

  /** Enabled rows that have an address — what the ticket page may offer. */
  async listForMeta(workspaceId) {
    const rows = await this.list(workspaceId);
    return rows
      .filter((r) => r.enabled && r.email)
      .map((r) => ({ id: r.id, label: r.label, email: r.email }));
  },

  /**
   * Replace the workspace's list with `items` (ids keep their rows; missing
   * rows are deleted). Returns the saved list.
   */
  async replace(workspaceId, items) {
    if (!Array.isArray(items)) throw new ValidationError('items must be an array');
    if (items.length > MAX_ROWS) throw new ValidationError(`At most ${MAX_ROWS} team forwards per workspace`);
    const rows = items.map(cleanRow);
    const labels = new Set();
    for (const r of rows) {
      const key = r.label.toLowerCase();
      if (labels.has(key)) throw new ValidationError(`Team forward "${r.label}" is listed twice`);
      labels.add(key);
    }
    const existing = await prisma.teamForward.findMany({ where: { workspaceId }, select: { id: true } });
    const existingIds = new Set(existing.map((r) => r.id));
    const keepIds = rows.map((r) => r.id).filter((id) => id && existingIds.has(id));
    await prisma.$transaction([
      prisma.teamForward.deleteMany({ where: { workspaceId, id: { notIn: keepIds } } }),
      ...rows.map((r) => (r.id && existingIds.has(r.id)
        ? prisma.teamForward.update({ where: { id: r.id }, data: { label: r.label, email: r.email, enabled: r.enabled } })
        : prisma.teamForward.create({ data: { workspaceId, label: r.label, email: r.email, enabled: r.enabled } }))),
    ]);
    return this.list(workspaceId);
  },
};

export default teamForwardService;
