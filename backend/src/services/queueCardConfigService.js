import prisma from './prisma.js';
import { ValidationError } from '../utils/errors.js';

/**
 * Admin-configurable quick filter cards for /tickets (Mega 08-23 Phase FC).
 *
 * The stat-card row shows exactly 6 single-select `?segment=` cards. Admins
 * pick which 6 from the registry below; the frontend mirror of this registry
 * (components/tickets/queueCards.js) owns labels/icons/tile tokens — THIS
 * list is the validation authority. Absent row = DEFAULT_QUEUE_CARDS (today's
 * exact 6 — zero behavior change until an admin customizes).
 */

// Every key here must have a buildListWhere segment branch AND a
// getQueueStats count (see ticketService: SEGMENT ↔ count contract).
export const QUEUE_CARD_KEYS = [
  'all', 'open', 'awaiting', 'due_today', 'overdue', 'resolved',
  'created_week', 'created_month', 'created_year',
  'unassigned', 'deleted', 'noise',
];

export const DEFAULT_QUEUE_CARDS = ['all', 'open', 'awaiting', 'due_today', 'overdue', 'resolved'];

export const QUEUE_CARD_COUNT = 6;

/**
 * Validate an incoming cards array (PUT payload). Throws ValidationError.
 * Returns the cleaned array (strings, original order).
 */
export function assertValidCards(cards) {
  if (!Array.isArray(cards)) throw new ValidationError('cards must be an array of card keys');
  const clean = cards.map((c) => String(c));
  if (clean.length !== QUEUE_CARD_COUNT) {
    throw new ValidationError(`cards must contain exactly ${QUEUE_CARD_COUNT} card keys`);
  }
  const unknown = clean.filter((c) => !QUEUE_CARD_KEYS.includes(c));
  if (unknown.length) {
    throw new ValidationError(`Unknown card key(s): ${unknown.join(', ')}. Valid keys: ${QUEUE_CARD_KEYS.join(', ')}`);
  }
  if (new Set(clean).size !== clean.length) {
    throw new ValidationError('cards must not contain duplicates');
  }
  return clean;
}

/**
 * Lenient read-side normalize: a stored value that no longer validates
 * (registry drift, manual DB edits) falls back to the defaults instead of
 * breaking the queue page.
 */
export function normalizeStoredCards(value) {
  try {
    return assertValidCards(value);
  } catch {
    return DEFAULT_QUEUE_CARDS;
  }
}

class QueueCardConfigService {
  /** Resolved cards for meta delivery — never throws, never null. */
  async getCards(workspaceId) {
    let row = null;
    try {
      row = await prisma.queueCardConfig.findUnique({ where: { workspaceId } });
    } catch { /* table not migrated yet / transient — defaults */ }
    return row ? normalizeStoredCards(row.cards) : DEFAULT_QUEUE_CARDS;
  }

  async setCards(workspaceId, cards, actorEmail = null) {
    const clean = assertValidCards(cards);
    const row = await prisma.queueCardConfig.upsert({
      where: { workspaceId },
      update: { cards: clean, updatedBy: actorEmail },
      create: { workspaceId, cards: clean, updatedBy: actorEmail },
    });
    return normalizeStoredCards(row.cards);
  }
}

const queueCardConfigService = new QueueCardConfigService();
export default queueCardConfigService;
