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

export const SEARCH_SECTIONS = ['tickets', 'tasks', 'agents', 'requesters', 'departments', 'conversations'];
// 'conversations' is opt-in: it is not part of the default section set.
export const DEFAULT_SECTIONS = ['tickets', 'tasks', 'agents', 'requesters', 'departments'];
// Search v3: fuzzy people matching (pg_trgm). Below this similarity a name is noise.
const FUZZY_MIN_SIMILARITY = 0.3;
let trigramAvailable = null; // null = unknown, false = extension missing (checked once)

const SECTION_TAKE = 7;
const MIN_QUERY_LENGTH = 2;

/** Parse ?types= into a validated, de-duplicated section list (default: all). */
export function parseSearchTypes(raw) {
  const values = (Array.isArray(raw) ? raw : String(raw ?? '').split(','))
    .map((s) => String(s).trim().toLowerCase())
    .filter(Boolean);
  const wanted = SEARCH_SECTIONS.filter((s) => values.includes(s));
  return wanted.length ? wanted : [...DEFAULT_SECTIONS];
}


class GlobalSearchService {
  /**
   * @param {object} opts  { q, types, workspaceIds } — `workspaceIds` (Search v3
   *   scope switch) runs the ticket / conversation / task sections across every
   *   workspace the caller may see, tagging rows with their workspace.
   */
  async search(workspaceId, { q, types, workspaceIds = null } = {}) {
    const query = String(q || '').trim();
    const wanted = parseSearchTypes(types);
    const sections = {};
    for (const section of wanted) sections[section] = [];
    if (query.length < MIN_QUERY_LENGTH) return { query, sections, totals: {} };

    const scopes = Array.isArray(workspaceIds) && workspaceIds.length ? [...new Set(workspaceIds.map(Number).filter(Number.isFinite))] : null;
    const across = scopes && (scopes.length > 1 || scopes[0] !== Number(workspaceId));
    const runners = {
      tickets: () => (across ? this._acrossWorkspaces(scopes, (ws) => this._tickets(ws, query)) : this._tickets(workspaceId, query)),
      tasks: () => (across ? this._acrossWorkspaces(scopes, (ws) => this._tasks(ws, query)) : this._tasks(workspaceId, query)),
      agents: () => this._agents(workspaceId, query),
      requesters: () => this._requesters(query, workspaceId),
      departments: () => this._departments(workspaceId, query),
      conversations: () => (across ? this._acrossWorkspaces(scopes, (ws) => this._conversations(ws, query)) : this._conversations(workspaceId, query)),
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

  /** Run a per-workspace section across several workspaces; rows carry workspaceId/workspaceName. */
  async _acrossWorkspaces(workspaceIds, run) {
    const names = new Map((await prisma.workspace.findMany({ where: { id: { in: workspaceIds } }, select: { id: true, name: true } }).catch(() => [])).map((w) => [w.id, w.name]));
    const results = await Promise.all(workspaceIds.map(async (ws) => {
      try { return [ws, await run(ws)]; } catch { return [ws, []]; }
    }));
    let rows = []; let total = 0; let hasTotal = false;
    for (const [ws, r] of results) {
      const list = Array.isArray(r) ? r : (r?.rows || []);
      if (r && !Array.isArray(r) && Number.isFinite(r.total)) { total += r.total; hasTotal = true; }
      rows.push(...list.map((row) => ({ ...row, workspaceId: ws, workspaceName: names.get(ws) || null })));
    }
    rows = rows.slice(0, SECTION_TAKE * 2);
    return hasTotal ? { rows, total } : rows;
  }

  /**
   * Search v3 — full-text over conversation bodies (and the ticket's own
   * subject + description), English stemming, ranked, with a highlighted
   * snippet. Uses the GIN indexes from 20260916230000_search_v3_fuzzy_fulltext.
   */
  async _conversations(workspaceId, q) {
    if (typeof prisma.$queryRaw !== 'function') return { rows: [], total: 0 };
    try {
      const rows = await prisma.$queryRaw`
        WITH hits AS (
          SELECT e.id AS entry_id, e.ticket_id, e.actor_name, e.occurred_at, e.event_type,
                 ts_rank(to_tsvector('english', coalesce(e.body_text, '')), plainto_tsquery('english', ${q})) AS rank,
                 ts_headline('english', left(coalesce(e.body_text, ''), 4000), plainto_tsquery('english', ${q}),
                             'MaxWords=18, MinWords=8, StartSel=[[, StopSel=]], MaxFragments=1') AS snippet
          FROM ticket_thread_entries e
          WHERE e.workspace_id = ${workspaceId}
            AND to_tsvector('english', coalesce(e.body_text, '')) @@ plainto_tsquery('english', ${q})
          UNION ALL
          SELECT NULL AS entry_id, t.id AS ticket_id, NULL AS actor_name, t.created_at AS occurred_at, 'description' AS event_type,
                 ts_rank(to_tsvector('english', coalesce(t.subject, '') || ' ' || coalesce(t.description_text, '')), plainto_tsquery('english', ${q})) AS rank,
                 ts_headline('english', left(coalesce(t.description_text, ''), 4000), plainto_tsquery('english', ${q}),
                             'MaxWords=18, MinWords=8, StartSel=[[, StopSel=]], MaxFragments=1') AS snippet
          FROM tickets t
          WHERE t.workspace_id = ${workspaceId} AND t.is_noise = false
            AND to_tsvector('english', coalesce(t.subject, '') || ' ' || coalesce(t.description_text, '')) @@ plainto_tsquery('english', ${q})
        )
        SELECT h.entry_id, h.ticket_id, h.actor_name, h.occurred_at, h.event_type, h.rank, h.snippet,
               t.subject, t.status, t.origin, t.native_number, t.freshservice_ticket_id,
               count(*) OVER () AS total
        FROM hits h JOIN tickets t ON t.id = h.ticket_id
        WHERE t.is_noise = false
        ORDER BY h.rank DESC, h.occurred_at DESC
        LIMIT ${SECTION_TAKE}`;
      const total = rows.length ? Number(rows[0].total) : 0;
      return {
        total,
        rows: rows.map((r) => ({
          id: r.entry_id === null ? `t-${r.ticket_id}` : Number(r.entry_id),
          entryId: r.entry_id === null ? null : Number(r.entry_id),
          ticketId: Number(r.ticket_id),
          displayRef: ticketDisplayRef({ id: r.ticket_id, origin: r.origin, nativeNumber: r.native_number, freshserviceTicketId: r.freshservice_ticket_id }),
          subject: r.subject,
          status: r.status,
          where: r.event_type === 'description' ? 'description' : 'conversation',
          authorName: r.actor_name || null,
          at: r.occurred_at,
          snippet: r.snippet || '',
        })),
      };
    } catch (err) {
      // Index/extension not there yet, or a query the parser rejects — the
      // section is empty rather than the whole search failing.
      return { rows: [], total: 0, unavailable: true, reason: String(err?.message || err).slice(0, 120) };
    }
  }

  /**
   * Search v3 — trigram similarity fallback for people. Only runs when the
   * exact "contains" match found nothing; a missing extension turns it off.
   */
  async _fuzzyPeople(table, q, extraWhere = '') {
    if (trigramAvailable === false || typeof prisma.$queryRawUnsafe !== 'function') return [];
    try {
      const sql = `SELECT id, name, email, similarity(lower(name), lower($1)) AS sim FROM ${table}
        WHERE ${extraWhere ? `${extraWhere} AND ` : ''}(lower(name) % lower($1) OR lower(coalesce(email, '')) % lower($1))
          AND similarity(lower(name), lower($1)) >= ${FUZZY_MIN_SIMILARITY}
        ORDER BY sim DESC LIMIT ${SECTION_TAKE}`;
      const rows = await prisma.$queryRawUnsafe(sql, q);
      trigramAvailable = true;
      return rows;
    } catch (err) {
      if (/similarity|operator does not exist|pg_trgm/i.test(String(err?.message || ''))) trigramAvailable = false;
      return [];
    }
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
    if (rows.length === 0 && q.length >= 3) {
      const fuzzy = await this._fuzzyPeople('technicians', q, `workspace_id = ${Number(workspaceId)} AND is_active = true`);
      if (fuzzy.length) {
        const full = await prisma.technician.findMany({ where: { id: { in: fuzzy.map((f) => Number(f.id)) } }, select: { id: true, name: true, email: true, photoUrl: true, location: true } });
        const order = new Map(fuzzy.map((f, i) => [Number(f.id), i]));
        return full.sort((a, b) => order.get(a.id) - order.get(b.id)).map((t) => ({ id: t.id, name: t.name, email: t.email, photoUrl: t.photoUrl || null, location: t.location || null, fuzzy: true }));
      }
    }
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
    let rows = await prisma.requester.findMany({
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
    let fuzzyIds = null;
    if (rows.length === 0 && q.length >= 3) {
      const fuzzy = await this._fuzzyPeople('requesters', q, 'is_active = true');
      if (fuzzy.length) {
        fuzzyIds = new Map(fuzzy.map((f, i) => [Number(f.id), i]));
        rows = await prisma.requester.findMany({ where: { id: { in: [...fuzzyIds.keys()] } }, select: { id: true, name: true, email: true, department: true, entraDepartment: true, jobTitle: true } });
      }
    }
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
      if (fuzzyIds) return fuzzyIds.get(r.id) ?? 99; // similarity order from the database
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
        ...(fuzzyIds ? { fuzzy: true } : {}),
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
