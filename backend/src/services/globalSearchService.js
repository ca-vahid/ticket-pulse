import prisma from './prisma.js';
import ticketService from './ticketService.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';

/**
 * Multi-entity search behind GET /api/search (QA 08-04 #2, Phase 7).
 *
 * One query string fans out across up to five sections — tickets, tasks,
 * agents, requesters, departments — each capped at SECTION_TAKE results so
 * the command palette stays scannable. Sections are independent and run in
 * parallel; callers pick which via ?types=.
 *
 * Workspace scoping per section:
 * - tickets: `ticketService.listTickets` (already workspace-scoped; reuses the
 *   exact queue `q` semantics — subject / requester name+email / TP-n / #n).
 * - tasks: the `ticket_tasks` rows carry a denormalized workspaceId AND the
 *   query joins the parent ticket's workspaceId — belt and braces so a
 *   mis-stamped row can never leak across workspaces.
 * - agents: technicians filtered by workspaceId + isActive, same population
 *   as /settings/technicians (active only — search is for reachable people).
 * - requesters: the requester table is GLOBAL (shared across workspaces, same
 *   as the existing /tickets/requester-search typeahead) — deliberately not
 *   workspace-filtered so a requester who hasn't opened a ticket here yet is
 *   still findable. The Entra directory branch of that typeahead is skipped:
 *   search is for known people, not for inviting new ones.
 * - departments: distinct non-empty Requester.department / entraDepartment
 *   values, scoped to requesters WITH at least one ticket in this workspace
 *   (`tickets: { some: { workspaceId } }` — cheap: requesters is a small
 *   table and tickets.requester_id is indexed). Global distinct would surface
 *   departments this workspace has never seen.
 */

export const SEARCH_SECTIONS = ['tickets', 'tasks', 'agents', 'requesters', 'departments'];

const SECTION_TAKE = 7;
const MIN_QUERY_LENGTH = 2;

/** Parse ?types= into a validated, de-duplicated section list (default: all). */
export function parseSearchTypes(raw) {
  const values = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  const wanted = SEARCH_SECTIONS.filter((s) => values.includes(s));
  return wanted.length ? wanted : [...SEARCH_SECTIONS];
}

class GlobalSearchService {
  async search(workspaceId, { q, types } = {}) {
    const query = String(q || '').trim();
    const wanted = parseSearchTypes(types);

    const sections = {};
    for (const section of wanted) sections[section] = [];
    if (query.length < MIN_QUERY_LENGTH) return { query, sections };

    const runners = {
      tickets: () => this._tickets(workspaceId, query),
      tasks: () => this._tasks(workspaceId, query),
      agents: () => this._agents(workspaceId, query),
      requesters: () => this._requesters(query, workspaceId),
      departments: () => this._departments(workspaceId, query),
    };
    const results = await Promise.all(wanted.map((section) => runners[section]()));
    const totals = {};
    wanted.forEach((section, i) => {
      const r = results[i];
      // Sections may return { rows, total } (tickets) or a bare array.
      if (r && !Array.isArray(r) && Array.isArray(r.rows)) { sections[section] = r.rows; totals[section] = r.total; }
      else sections[section] = r;
    });
    return { query, sections, totals };
  }

  /**
   * Queue-identical ticket matching, slimmed down to result-row fields.
   * Search v2 (16 Sep 2026): rows carry status / priority / assignee / date
   * for the richer dropdown, and `total` feeds "View all (N)".
   */
  async _tickets(workspaceId, q) {
    const { items, total } = await ticketService.listTickets(workspaceId, { q, pageSize: SECTION_TAKE });
    const rows = items.map((t) => ({
      id: t.id,
      displayRef: t.displayRef,
      subject: t.subject,
      status: t.status,
      requesterName: t.requester?.name || null,
      priority: t.priority ?? null,
      assigneeName: t.assignedTech?.name || null,
      createdAt: t.createdAt || null,
      origin: t.origin || null,
    }));
    return { rows, total: Number.isFinite(Number(total)) ? Number(total) : rows.length };
  }

  async _tasks(workspaceId, q) {
    const rows = await prisma.ticketTask.findMany({
      where: {
        workspaceId,
        title: { contains: q, mode: 'insensitive' },
        // Redundant with the denormalized column by design (see module doc).
        ticket: { is: { workspaceId } },
      },
      select: {
        id: true, title: true, status: true, dueAt: true,
        assignedTech: { select: { id: true, name: true } },
        ticket: {
          select: {
            id: true, subject: true, origin: true,
            nativeNumber: true, freshserviceTicketId: true,
          },
        },
      },
      orderBy: { id: 'desc' },
      take: SECTION_TAKE,
    });
    return rows.map((task) => ({
      id: task.id,
      title: task.title,
      status: task.status,
      dueAt: task.dueAt,
      assignedTechName: task.assignedTech?.name || null,
      ticket: {
        id: task.ticket.id,
        displayRef: ticketDisplayRef(task.ticket),
        subject: task.ticket.subject,
      },
    }));
  }

  async _agents(workspaceId, q) {
    const rows = await prisma.technician.findMany({
      where: {
        workspaceId,
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, email: true, photoUrl: true, location: true },
      orderBy: { name: 'asc' },
      take: SECTION_TAKE,
    });
    return rows.map((t) => ({
      id: t.id, name: t.name, email: t.email, photoUrl: t.photoUrl || null, location: t.location || null,
    }));
  }

  /**
   * Local requesters only — the create-flow typeahead's Entra branch is skipped here.
   * Search v2: a name that STARTS with the query outranks a "contains" hit, and
   * each row carries the person's ticket count in this workspace (people with
   * history first — that is who the agent is usually looking for).
   */
  async _requesters(q, workspaceId = null) {
    const rows = await prisma.requester.findMany({
      where: {
        isActive: true,
        OR: [
          { name: { contains: q, mode: 'insensitive' } },
          { email: { contains: q, mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, email: true, department: true, entraDepartment: true, jobTitle: true },
      orderBy: { name: 'asc' },
      take: SECTION_TAKE * 3,
    });
    let counts = new Map();
    if (workspaceId && rows.length && typeof prisma.ticket?.groupBy === 'function') {
      try {
        const grouped = await prisma.ticket.groupBy({
          by: ['requesterId'],
          where: { workspaceId, requesterId: { in: rows.map((r) => r.id) } },
          _count: { _all: true },
        });
        counts = new Map(grouped.map((g) => [g.requesterId, g._count?._all || 0]));
      } catch { counts = new Map(); }
    }
    const lq = q.toLowerCase();
    const rank = (r) => {
      const name = String(r.name || '').toLowerCase();
      const email = String(r.email || '').toLowerCase();
      if (name.startsWith(lq) || email.startsWith(lq)) return 0;
      if (name.split(/\s+/).some((w) => w.startsWith(lq))) return 1;
      return 2;
    };
    return rows
      .map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        department: r.department || r.entraDepartment || null,
        jobTitle: r.jobTitle || null,
        ticketCount: counts.get(r.id) || 0,
      }))
      .sort((a, b) => (rank(a) - rank(b)) || (b.ticketCount - a.ticketCount) || String(a.name || '').localeCompare(String(b.name || '')))
      .slice(0, SECTION_TAKE);
  }

  async _departments(workspaceId, q) {
    const scoped = { tickets: { some: { workspaceId } } };
    const [locals, entras] = await Promise.all([
      prisma.requester.findMany({
        where: { ...scoped, department: { contains: q, mode: 'insensitive' } },
        select: { department: true },
        distinct: ['department'],
        take: SECTION_TAKE * 4, // overshoot: the two columns are merged + re-capped below
      }),
      prisma.requester.findMany({
        where: { ...scoped, entraDepartment: { contains: q, mode: 'insensitive' } },
        select: { entraDepartment: true },
        distinct: ['entraDepartment'],
        take: SECTION_TAKE * 4,
      }),
    ]);
    // Case-insensitive union across the two columns; first spelling wins.
    const seen = new Map();
    for (const value of [...locals.map((r) => r.department), ...entras.map((r) => r.entraDepartment)]) {
      const name = String(value || '').trim();
      if (!name) continue;
      const key = name.toLowerCase();
      if (!seen.has(key)) seen.set(key, name);
    }
    return [...seen.values()]
      .sort((a, b) => a.localeCompare(b))
      .slice(0, SECTION_TAKE)
      .map((name) => ({ name }));
  }
}

export default new GlobalSearchService();
