import prisma from './prisma.js';
import logger from '../utils/logger.js';

/**
 * "Your filters are hiding this" (FR 09-09).
 *
 * Searching for a ticket reference and getting "No tickets match these
 * filters" is a dead end: the default Status filter excludes Resolved and
 * Closed, so a ticket that plainly exists is invisible, and Reset filters only
 * clears the typed text. The user has to guess which checkbox is in the way.
 *
 * This works out the answer instead of making them guess: for each filter
 * group the caller has active, how many more rows would appear if THAT group
 * alone were dropped. The UI then names the culprit — "1 ticket is hidden by
 * your Status filter" — and offers a one-click widening.
 *
 * Cost: one count per active group plus one for the text-only baseline. The
 * caller only asks when it is worth asking (nothing found, or a text search is
 * running), so this is a handful of indexed counts on demand, not per keystroke.
 */

// A group is a set of API query keys that a user thinks of as one control in
// the rail. Dropping a group means dropping all of its keys together —
// category and subcategory move as one, so do the created-date bounds.
const FILTER_GROUPS = Object.freeze([
  { key: 'status', label: 'Status', apiKeys: ['status'] },
  // A canned view (Noise & spam, Deleted, Scheduled…) supplies its own scope.
  { key: 'segment', label: 'View', apiKeys: ['segment'] },
  { key: 'assignee', label: 'Assignee', apiKeys: ['assignedTechId'] },
  { key: 'priority', label: 'Priority', apiKeys: ['priority'] },
  { key: 'category', label: 'Category', apiKeys: ['internalCategoryId', 'internalSubcategoryId'] },
  { key: 'group', label: 'Group', apiKeys: ['groupId'] },
  { key: 'source', label: 'Source', apiKeys: ['source'] },
  { key: 'created', label: 'Created date', apiKeys: ['createdFrom', 'createdTo'] },
  { key: 'due', label: 'Due date', apiKeys: ['due'] },
  { key: 'tag', label: 'Tags', apiKeys: ['tagId', 'tagMode'] },
  { key: 'type', label: 'Type', apiKeys: ['type'] },
  { key: 'origin', label: 'Origin', apiKeys: ['origin'] },
  { key: 'impact', label: 'Impact', apiKeys: ['impact'] },
  { key: 'urgency', label: 'Urgency', apiKeys: ['urgency'] },
  { key: 'aiState', label: 'AI state', apiKeys: ['aiState'] },
  { key: 'requester', label: 'Requester', apiKeys: ['requesterId'] },
  { key: 'noise', label: 'Noise', apiKeys: ['noise', 'excludeNoise'] },
]);

// Never counted as a filter: paging, ordering, and the text query itself. The
// text is the one thing a widening must always preserve — it is what the user
// was looking for.
const NON_FILTER_KEYS = new Set(['page', 'pageSize', 'sort', 'dir', 'q', 'view', 'peek']);

function hasValue(v) {
  if (v === undefined || v === null) return false;
  const s = String(v).trim();
  return s !== '' && s !== 'all';
}

class TicketFilterReliefService {
  /**
   * @param {number} workspaceId
   * @param {object} query the SAME query the list was fetched with
   * @returns {Promise<{current:number,withoutFilters:number,hasQuery:boolean,
   *   activeGroups:number,groups:Array,statusesToAdd:Array}|null>}
   */
  async analyse(workspaceId, query = {}) {
    const { default: ticketService } = await import('./ticketService.js');
    const q = String(query.q || '').trim();

    try {
      const active = FILTER_GROUPS.filter((g) => g.apiKeys.some((k) => hasValue(query[k])));
      // Nothing to relieve: no filters are narrowing anything.
      if (!active.length) return null;

      const countFor = async (partial) => prisma.ticket.count({
        where: await ticketService.buildListWhere(workspaceId, partial),
      });

      // The text query alone — "everything that matches what you typed".
      const textOnly = { ...(q ? { q } : {}) };

      const [current, withoutFilters] = await Promise.all([
        countFor(query),
        countFor(textOnly),
      ]);

      // Per group: what would appear if this ONE group were dropped. Reported
      // as a delta so the number reads as "…and N more", which is what the
      // user is actually deciding about.
      const perGroup = await Promise.all(active.map(async (g) => {
        const without = { ...query };
        for (const k of g.apiKeys) delete without[k];
        const count = await countFor(without);
        return { key: g.key, label: g.label, apiKeys: g.apiKeys, hidden: Math.max(0, count - current) };
      }));

      const groups = perGroup.filter((g) => g.hidden > 0).sort((a, b) => b.hidden - a.hidden);

      // For Status specifically, name the values worth adding — "Include
      // Resolved and Closed" is a far better offer than "clear Status".
      let statusesToAdd = [];
      if (hasValue(query.status) && groups.some((g) => g.key === 'status')) {
        statusesToAdd = await this._statusesWithMatches(workspaceId, query, ticketService);
      }

      return {
        current,
        withoutFilters,
        hasQuery: Boolean(q),
        query: q || null,
        activeGroups: active.length,
        groups,
        statusesToAdd,
      };
    } catch (error) {
      // A help affordance must never take the ticket list down with it.
      logger.warn(`Filter relief analysis failed: ${error.message}`);
      return null;
    }
  }

  /** Statuses that HAVE matches but are excluded by the current status filter. */
  async _statusesWithMatches(workspaceId, query, ticketService) {
    const selected = new Set(String(query.status || '').split(',').map((s) => s.trim()).filter(Boolean));
    const without = { ...query };
    delete without.status;
    const where = await ticketService.buildListWhere(workspaceId, without);
    const rows = await prisma.ticket.groupBy({
      by: ['status'],
      where,
      _count: { _all: true },
    });
    return rows
      .filter((r) => r.status && !selected.has(r.status) && r._count._all > 0)
      .map((r) => ({ status: r.status, count: r._count._all }))
      .sort((a, b) => b.count - a.count);
  }
}

export default new TicketFilterReliefService();
export { FILTER_GROUPS, NON_FILTER_KEYS };
