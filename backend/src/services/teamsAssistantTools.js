/**
 * The Teams assistant's six read-only tools (plans/TEAMS_BOT_COMMANDS_PLAN.md,
 * P1), in the shape of autoHelpTools.js: schemas for the model, executors on
 * the existing services, and a "model view" of each result.
 *
 * Every tool:
 *  - runs as the person asking (the access context), never as anyone the
 *    model names; approvals and time away filter by the asker's own e-mail;
 *  - returns at most 25 rows plus the true counts;
 *  - returns ids, refs, subjects, names, dates and statuses only: never a
 *    ticket body, thread, note, approval request note or leave note.
 * The full rows build the card; the model sees modelView(): subjects cut to
 * 80 characters through scrubPii (or null in a sensitive workspace), no
 * e-mail addresses, no links.
 */
import prisma from './prisma.js';
import { ticketDisplayRef } from '../utils/ticketOrigin.js';
import { ticketLinkUrl } from '../utils/ticketLink.js';
import { scrubPii } from '../utils/piiScrubber.js';
import { myOpenTickets } from './myOpenTickets.js';
import { matchWorkspace } from './teamsAssistantAccess.js';

export const MAX_ROWS = 25;
export const PACIFIC = 'America/Vancouver';
const PRIORITY_WORD = { 1: 'Low', 2: 'Medium', 3: 'High', 4: 'Urgent' };
const lc = (s) => String(s || '').trim().toLowerCase();
const clip = (s, n) => {
  const t = String(s || '').replace(/\s+/g, ' ').trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};

// ---------------------------------------------------------------- dates (Pacific)

/** "Tue 20 Oct, 9:14 AM" (the house format for times shown to people). */
export function fmtWhen(d, tz = PACIFIC) {
  if (!d) return null;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month}, ${p.hour}:${p.minute} ${p.dayPeriod}`;
  } catch { return null; }
}

/** "Tue 20 Oct". */
export function fmtDay(d, tz = PACIFIC) {
  if (!d) return null;
  try {
    const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).formatToParts(new Date(d)).map((x) => [x.type, x.value]));
    return `${p.weekday} ${p.day} ${p.month}`;
  } catch { return null; }
}

export function pacificDayKey(at = new Date(), tz = PACIFIC) {
  try { return new Intl.DateTimeFormat('en-CA', { timeZone: tz }).format(at); } catch { return at.toISOString().slice(0, 10); }
}

const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

/** today | tomorrow | a weekday | YYYY-MM-DD -> a Pacific day key, at most 14 days ahead. */
export function resolveDay(input, now = new Date()) {
  const raw = lc(input || 'today');
  const today = pacificDayKey(now);
  const plus = (key, n) => {
    const d = new Date(`${key}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  let key = null;
  if (!raw || raw === 'today') key = today;
  else if (raw === 'tomorrow') key = plus(today, 1);
  else if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) key = raw;
  else {
    const i = WEEKDAYS.findIndex((w) => raw.startsWith(w.slice(0, 3)));
    if (i >= 0) {
      const dow = new Date(`${today}T12:00:00Z`).getUTCDay();
      key = plus(today, ((i - dow + 7) % 7) || 0);
    }
  }
  if (!key) return { error: `I could not read "${clip(input, 30)}" as a day. Say today, tomorrow, a weekday or a date.` };
  const days = Math.round((new Date(`${key}T12:00:00Z`) - new Date(`${today}T12:00:00Z`)) / 86400_000);
  if (days > 14) return { error: 'I can look up to 14 days ahead.' };
  if (days < -31) return { error: 'I can look back up to a month.' };
  return { key, days };
}

// ---------------------------------------------------------------- schemas

const workspaceProp = { type: 'string', maxLength: 60, description: 'Only when the person names a workspace or team ("in Accounting"). Leave out otherwise.' };

export const ASSISTANT_TOOLS = Object.freeze([
  {
    name: 'my_pending_approvals',
    description: 'Ticket approvals for the person asking. side=to_decide (default): approvals waiting for THEIR decision. side=i_asked: approvals they asked for that are still open. Only ever their own.',
    input_schema: { type: 'object', additionalProperties: false, properties: { side: { type: 'string', enum: ['to_decide', 'i_asked'] }, workspace: workspaceProp } },
  },
  {
    name: 'time_away_waiting_for_me',
    description: 'Time-away (vacation, leave, availability) requests waiting for the person asking to approve. include_others only when a super admin asks for requests they are not the named approver of.',
    input_schema: { type: 'object', additionalProperties: false, properties: { include_others: { type: 'boolean' } } },
  },
  {
    name: 'my_tickets',
    description: 'Tickets assigned to the person asking, with true counts (open, overdue, due today). filter: open | overdue | due_today | due_this_week | pending.',
    input_schema: { type: 'object', additionalProperties: false, properties: { filter: { type: 'string', enum: ['open', 'overdue', 'due_today', 'due_this_week', 'pending'] }, workspace: workspaceProp, limit: { type: 'integer', minimum: 1, maximum: MAX_ROWS } } },
  },
  {
    name: 'ticket_status',
    description: 'The status of one ticket by its reference: TP-1042, #231164 or 231164. Only in workspaces the person can open tickets in.',
    input_schema: { type: 'object', additionalProperties: false, required: ['ref'], properties: { ref: { type: 'string', maxLength: 20 }, workspace: workspaceProp } },
  },
  {
    name: 'who_is_away',
    description: 'Who on the person\'s team is away, working from home or on site on a day. date: today | tomorrow | a weekday name | YYYY-MM-DD (up to 14 days ahead).',
    input_schema: { type: 'object', additionalProperties: false, properties: { date: { type: 'string', maxLength: 12 }, workspace: workspaceProp } },
  },
  {
    name: 'my_time_away',
    description: 'The person\'s own time-away requests and balances. scope=upcoming (default): what is booked or waiting from today on. scope=this_year: the whole leave year, with balances.',
    input_schema: { type: 'object', additionalProperties: false, properties: { scope: { type: 'string', enum: ['upcoming', 'this_year'] } } },
  },
]);

export const SUBMIT_ANSWER_TOOL = Object.freeze({
  name: 'submit_answer',
  description: 'Finish. Required, exactly once, after the data tools. The server builds the card from the tool results; you only choose what to show and write one short lead sentence.',
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['lead'],
    properties: {
      lead: { type: 'string', maxLength: 200, description: 'One plain sentence for the top of the card. Use only numbers that appear in the tool results. Call the person "you".' },
      show: { type: 'array', maxItems: 6, items: { type: 'string', enum: ASSISTANT_TOOLS.map((t) => t.name) }, description: 'Which tool results to show, in order. Leave out to show all.' },
      focus_ids: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 40 }, description: 'Row ids (e.g. "approval:12") to pull to the top. Only ids from the tool results or the conversation memory.' },
      confirm: {
        type: 'object', additionalProperties: false, required: ['kind', 'id'],
        description: 'When the person asks to approve or decline ONE item: its id from the results or memory. The server sends the existing approval card with its own confirm step; you never decide anything.',
        properties: { kind: { type: 'string', enum: ['approval', 'time_away'] }, id: { type: 'string', maxLength: 40 } },
      },
      clarify: { type: 'string', maxLength: 200, description: 'A short question back to the person when the request is unclear, or "one at a time" for a batch request.' },
      suggest_autofill: { type: 'boolean', description: 'True when the message is a problem or request for IT rather than a question: the card offers to make a ticket from it.' },
      refuse: { type: 'boolean', description: 'True when the request is something the bot will not do: change a ticket, show another person\'s queue, rank people.' },
      help: { type: 'boolean', description: 'True when the person asks what the bot can do.' },
    },
  },
});

export const TOOL_NAMES = new Set(ASSISTANT_TOOLS.map((t) => t.name));

// ---------------------------------------------------------------- executors

const wsName = (access, id) => access.workspaces.find((w) => w.id === Number(id))?.name || null;

async function approvalWorkspaces(access, where) {
  const rows = await prisma.ticketApproval.groupBy({ by: ['workspaceId'], where, _count: { _all: true } }).catch(() => []);
  return (rows || []).map((r) => Number(r.workspaceId)).filter((id) => id > 0);
}

async function workspaceNames(ids) {
  if (!ids.length) return new Map();
  const rows = await prisma.workspace.findMany({ where: { id: { in: ids } }, select: { id: true, name: true, slug: true } }).catch(() => []);
  return new Map((rows || []).map((w) => [w.id, w]));
}

async function myPendingApprovals(input, ctx) {
  const { access } = ctx;
  const side = input.side === 'i_asked' ? 'i_asked' : 'to_decide';
  const email = access.email;
  const where = side === 'to_decide'
    ? { approverEmail: email, status: { in: ['pending', 'info_requested'] } }
    : { requestedBy: email, status: { in: ['pending', 'info_requested'] } };
  let ids = await approvalWorkspaces(access, where);
  const names = await workspaceNames(ids);
  if (input.workspace) {
    const known = [...access.workspaces, ...[...names.values()].map((w) => ({ id: w.id, name: w.name, slug: w.slug }))];
    const hit = matchWorkspace(input.workspace, known);
    if (!hit) return { error: `You have no workspace called "${clip(input.workspace, 40)}".`, errorKind: 'unknown_workspace' };
    ids = ids.filter((id) => id === hit.id);
  }
  const { default: ticketApprovalService } = await import('./ticketApprovalService.js');
  const actor = { email };
  const rows = [];
  for (const wsId of ids) {
    if (side === 'to_decide') {
      const [pending, asked] = await Promise.all([ticketApprovalService.inboxFor(wsId, actor), ticketApprovalService.waitingFor(wsId, actor)]);
      for (const r of [...(pending || []), ...(asked || [])]) {
        // Belt and braces: only rows addressed to this person.
        if (lc(r.approverEmail) !== email) continue;
        rows.push({ r, wsId });
      }
    } else {
      const mine = await prisma.ticketApproval.findMany({
        where: { workspaceId: wsId, requestedBy: email, status: { in: ['pending', 'info_requested'] } },
        orderBy: { createdAt: 'asc' },
        take: 100,
        select: {
          id: true, ticketId: true, workspaceId: true, status: true, tier: true, approverName: true, approverEmail: true, createdAt: true, updatedAt: true, requestedBy: true,
          approvalCategory: { select: { name: true } },
          ticket: { select: { id: true, subject: true, origin: true, nativeNumber: true, freshserviceTicketId: true, requester: { select: { name: true } } } },
        },
      }).catch(() => []);
      for (const a of mine || []) {
        if (lc(a.requestedBy) !== email) continue;
        rows.push({
          wsId,
          r: {
            id: a.id, ticketId: a.ticketId, status: a.status, tier: a.tier || 1, tierName: a.tier > 1 ? `Tier ${a.tier}` : null,
            displayRef: ticketDisplayRef(a.ticket), subject: a.ticket?.subject || null, requesterName: a.ticket?.requester?.name || null,
            categoryName: a.approvalCategory?.name || null, approverName: a.approverName || null, createdAt: a.createdAt, waitingSince: a.status === 'info_requested' ? a.updatedAt : null,
          },
        });
      }
    }
  }
  const all = rows.map(({ r, wsId }) => ({
    id: `approval:${r.id}`,
    approvalId: r.id,
    ticketId: r.ticketId,
    workspaceId: wsId,
    workspaceName: wsName(access, wsId) || names.get(wsId)?.name || null,
    ref: r.displayRef || null,
    subject: r.subject || null,
    category: r.categoryName || null,
    requesterName: r.requesterName || null,
    ...(side === 'i_asked' ? { approverName: r.approverName || null } : {}),
    tier: r.tierCount > 1 || r.tier > 1 ? (r.tierName || `Tier ${r.tier}`) : null,
    amount: r.amountLabel || null,
    status: r.status === 'info_requested' ? 'question_asked' : 'pending',
    since: r.waitingSince || r.createdAt || null,
  })).sort((a, b) => new Date(a.since || 0) - new Date(b.since || 0));
  return {
    side,
    counts: { total: all.length, pending: all.filter((r) => r.status === 'pending').length, questionAsked: all.filter((r) => r.status === 'question_asked').length },
    rows: all.slice(0, MAX_ROWS),
    link: '/approvals',
  };
}

async function timeAwayWaitingForMe(input, ctx) {
  const { access } = ctx;
  const { default: availabilityService, describeRange, describeAmount } = await import('./availability/availabilityService.js');
  const includeOthers = input.include_others === true && access.superAdmin;
  const list = await availabilityService.listPendingFor(access.user);
  const rows = (list || []).filter((r) => lc(r.email) !== access.email && (r.mine !== false || includeOthers));
  const types = await prisma.avLeaveType.findMany({ select: { id: true, name: true, unit: true } }).catch(() => []);
  const typeById = new Map((types || []).map((t) => [t.id, t]));
  const out = rows.map((r) => ({
    id: `time_away:${r.id}`,
    requestId: r.id,
    name: r.name || null,
    leaveType: typeById.get(r.leaveTypeId)?.name || null,
    range: describeRange(r),
    amount: describeAmount(r, typeById.get(r.leaveTypeId)),
    submittedAt: r.createdAt || null,
    teams: Array.isArray(r.teams) ? r.teams.slice(0, 3) : [],
    mine: r.mine !== false,
  }));
  return { counts: { total: out.length, mine: out.filter((r) => r.mine).length }, rows: out.slice(0, MAX_ROWS), link: '/availability/approvals' };
}

async function myTickets(input, ctx) {
  const { access, baseUrl } = ctx;
  const filter = ['open', 'overdue', 'due_today', 'due_this_week', 'pending'].includes(input.filter) ? input.filter : 'open';
  let techs = access.techs || [];
  if (input.workspace) {
    const hit = matchWorkspace(input.workspace, access.workspaces);
    if (!hit) return { error: `You have no workspace called "${clip(input.workspace, 40)}".`, errorKind: 'unknown_workspace' };
    techs = techs.filter((t) => t.workspaceId === hit.id);
  }
  if (!techs.length) return { filter, notAnAgent: true, counts: { open: 0, overdue: 0, dueToday: 0, matching: 0 }, rows: [], link: '/tickets?view=mine' };
  const take = Math.min(Math.max(Number(input.limit) || MAX_ROWS, 1), MAX_ROWS);
  const found = await myOpenTickets(techs, { take, filter, now: ctx.now, tz: access.tz });
  const now = ctx.now || new Date();
  const rows = (found?.rows || []).map((t) => ({
    id: `ticket:${t.id}`,
    ticketId: t.id,
    ref: ticketDisplayRef(t),
    subject: t.subject || null,
    priority: PRIORITY_WORD[t.priority] || null,
    status: t.status || null,
    due: t.dueBy ? fmtWhen(t.dueBy, found.tz) : null,
    overdue: Boolean(t.dueBy && new Date(t.dueBy) < now),
    workspaceId: t.workspaceId,
    workspaceName: wsName(access, t.workspaceId),
    url: ticketLinkUrl(baseUrl, t),
  }));
  return { filter, counts: found?.counts || { open: 0, overdue: 0, dueToday: 0, matching: 0 }, rows, link: '/tickets?view=mine' };
}

async function ticketStatus(input, ctx) {
  const { access, baseUrl } = ctx;
  const ref = String(input.ref || '').trim().replace(/^tp\s+/i, 'TP-');
  if (!ref) return { error: 'Which ticket? Give its TP- or # number.', errorKind: 'no_ref' };
  let spaces = access.workspaces;
  if (input.workspace) {
    const hit = matchWorkspace(input.workspace, access.workspaces);
    if (!hit) return { error: `You have no workspace called "${clip(input.workspace, 40)}".`, errorKind: 'unknown_workspace' };
    spaces = [hit];
  }
  if (!spaces.length) return { ref, rows: [], counts: { total: 0 }, noTicketAccess: true, link: '/tickets' };
  const { resolveTicketRef } = await import('./ticketRefResolver.js');
  const rows = [];
  for (const ws of spaces.slice(0, 12)) {
    const hit = await resolveTicketRef(ref, ws.id).catch(() => null);
    if (!hit) continue;
    const t = await prisma.ticket.findFirst({
      where: { id: hit.id, workspaceId: ws.id },
      select: {
        id: true, workspaceId: true, subject: true, status: true, priority: true, origin: true, nativeNumber: true, freshserviceTicketId: true,
        createdAt: true, updatedAt: true, lastRealActivityAt: true, dueBy: true, groupId: true,
        assignedTech: { select: { name: true } }, internalGroup: { select: { name: true } },
      },
    }).catch(() => null);
    if (!t) continue;
    let group = t.internalGroup?.name || null;
    if (!group && t.groupId) {
      group = (await prisma.group.findFirst({ where: { workspaceId: ws.id, freshserviceId: t.groupId }, select: { name: true } }).catch(() => null))?.name || null;
    }
    const pendingApprovals = await prisma.ticketApproval.count({ where: { ticketId: t.id, status: { in: ['pending', 'info_requested'] } } }).catch(() => 0);
    rows.push({
      id: `ticket:${t.id}`,
      ticketId: t.id,
      ref: ticketDisplayRef(t),
      subject: t.subject || null,
      status: t.status || null,
      priority: PRIORITY_WORD[t.priority] || null,
      assignee: t.assignedTech?.name || null,
      group,
      origin: t.origin === 'ticketpulse' ? 'TP-born' : 'FS-born',
      created: fmtWhen(t.createdAt),
      updated: fmtWhen(t.lastRealActivityAt || t.updatedAt),
      due: t.dueBy ? fmtWhen(t.dueBy) : null,
      pendingApprovals,
      workspaceId: ws.id,
      workspaceName: ws.name,
      url: ticketLinkUrl(baseUrl, t),
    });
  }
  return { ref, counts: { total: rows.length }, rows, link: '/tickets' };
}

function partOfDay(e) {
  if (e.dayPart === 'am') return 'Morning';
  if (e.dayPart === 'pm') return 'Afternoon';
  if (e.dayPart === 'hours' && Number.isFinite(e.startMinute) && Number.isFinite(e.endMinute)) {
    const hm = (m) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
    return `${hm(e.startMinute)}–${hm(e.endMinute)}`;
  }
  return 'All day';
}

async function whoIsAway(input, ctx) {
  const { access } = ctx;
  const day = resolveDay(input.date || 'today', ctx.now);
  if (day.error) return { error: day.error, errorKind: 'bad_date' };
  let workspaceId = null;
  if (input.workspace) {
    const hit = matchWorkspace(input.workspace, access.workspaces);
    if (!hit) return { error: `You have no team called "${clip(input.workspace, 40)}".`, errorKind: 'unknown_workspace' };
    workspaceId = hit.id;
  } else {
    workspaceId = access.techs?.[0]?.workspaceId || access.workspaces?.[0]?.id || null;
  }
  if (!workspaceId) return { date: day.key, rows: [], counts: { total: 0 }, noTeam: true, link: '/availability/calendar' };
  const { default: availabilityService } = await import('./availability/availabilityService.js');
  // calendar() applies the app's own rules: waiting requests and private
  // types only for the people who may see them, "away" types as "Away".
  const cal = await availabilityService.calendar(access.user, { from: day.key, to: day.key, workspaceId });
  const nameOf = new Map((cal?.people || []).map((p) => [lc(p.email), p.name]));
  const rows = (cal?.entries || []).map((e, i) => ({
    id: `away:${i + 1}`,
    name: nameOf.get(lc(e.email)) || null,
    label: e.label || null,
    part: partOfDay(e),
    availability: e.availability || null,
    waiting: e.status === 'pending',
    you: lc(e.email) === access.email,
  })).sort((a, b) => String(a.name || '').localeCompare(String(b.name || '')));
  return {
    date: day.key,
    dateLabel: fmtDay(new Date(`${day.key}T12:00:00Z`), 'UTC'),
    workspaceName: wsName(access, workspaceId),
    counts: { total: rows.length, off: rows.filter((r) => r.availability === 'OFF').length, wfh: rows.filter((r) => r.availability === 'WFH').length, onsite: rows.filter((r) => r.availability === 'ONSITE').length },
    rows: rows.slice(0, MAX_ROWS),
    link: '/availability/calendar',
  };
}

async function myTimeAway(input, ctx) {
  const { access } = ctx;
  const scope = input.scope === 'this_year' ? 'this_year' : 'upcoming';
  // Read-only: no person row means nothing booked (listMine would create one).
  const person = await prisma.avPerson.findUnique({ where: { email: access.email } }).catch(() => null);
  if (!person) return { scope, rows: [], balances: [], counts: { total: 0 }, link: '/availability/my-time' };
  const { default: availabilityService, describeRange, describeAmount } = await import('./availability/availabilityService.js');
  const [mine, balances, types] = await Promise.all([
    availabilityService.listMine(access.user),
    availabilityService.balances(access.email).catch(() => []),
    prisma.avLeaveType.findMany({ select: { id: true, name: true, unit: true } }).catch(() => []),
  ]);
  const typeById = new Map((types || []).map((t) => [t.id, t]));
  const today = pacificDayKey(ctx.now || new Date());
  let rows = (mine || []).filter((r) => r.status !== 'cancelled');
  if (scope === 'upcoming') rows = rows.filter((r) => String(r.endDate) >= today && ['pending', 'approved'].includes(r.status));
  rows = rows.sort((a, b) => String(a.startDate).localeCompare(String(b.startDate))).map((r) => ({
    id: `my_request:${r.id}`,
    requestId: r.id,
    leaveType: typeById.get(r.leaveTypeId)?.name || null,
    range: describeRange(r),
    amount: describeAmount(r, typeById.get(r.leaveTypeId)),
    status: r.status,
    start: r.startDate,
  }));
  return {
    scope,
    counts: { total: rows.length, pending: rows.filter((r) => r.status === 'pending').length, approved: rows.filter((r) => r.status === 'approved').length },
    rows: rows.slice(0, MAX_ROWS),
    balances: (balances || []).map((b) => ({ name: b.name, entitled: b.entitled, taken: b.taken, scheduled: b.scheduled, pending: b.pending, remaining: b.remaining })),
    link: '/availability/my-time',
  };
}

const EXECUTORS = {
  my_pending_approvals: myPendingApprovals,
  time_away_waiting_for_me: timeAwayWaitingForMe,
  my_tickets: myTickets,
  ticket_status: ticketStatus,
  who_is_away: whoIsAway,
  my_time_away: myTimeAway,
};

/** Run one tool. Never throws: an error comes back as { error }. */
export async function executeAssistantTool(name, input, ctx) {
  const run = EXECUTORS[name];
  if (!run) return { tool: name, error: `Unknown tool ${name}`, errorKind: 'unknown_tool' };
  try {
    const result = await run(input && typeof input === 'object' ? input : {}, ctx);
    return { tool: name, input: input || {}, ...result };
  } catch (err) {
    return { tool: name, input: input || {}, error: 'That lookup did not work just now.', errorKind: 'failed', detail: String(err?.message || err).slice(0, 200) };
  }
}

// ---------------------------------------------------------------- what the model sees

/** Subjects for the model: 80 characters, scrubbed; null in a sensitive workspace. */
function modelSubject(subject, workspaceId, ctx) {
  if (!subject) return null;
  if (ctx.sensitiveWorkspaces?.has(Number(workspaceId))) return null;
  return clip(scrubPii(String(subject)), 80);
}

const PICK = {
  my_pending_approvals: (r, ctx) => ({ id: r.id, ref: r.ref, subject: modelSubject(r.subject, r.workspaceId, ctx), category: r.category, requester: r.requesterName, ...(r.approverName !== undefined ? { approver: r.approverName } : {}), workspace: r.workspaceName, tier: r.tier, amount: r.amount, status: r.status, since: fmtDay(r.since) }),
  time_away_waiting_for_me: (r) => ({ id: r.id, person: r.name, type: r.leaveType, range: r.range, amount: r.amount, submitted: fmtDay(r.submittedAt), teams: r.teams, yours_to_decide: r.mine }),
  my_tickets: (r, ctx) => ({ id: r.id, ref: r.ref, subject: modelSubject(r.subject, r.workspaceId, ctx), priority: r.priority, status: r.status, due: r.due, overdue: r.overdue, workspace: r.workspaceName }),
  ticket_status: (r, ctx) => ({ id: r.id, ref: r.ref, subject: modelSubject(r.subject, r.workspaceId, ctx), status: r.status, priority: r.priority, assignee: r.assignee, group: r.group, origin: r.origin, created: r.created, updated: r.updated, due: r.due, pending_approvals: r.pendingApprovals, workspace: r.workspaceName }),
  who_is_away: (r) => ({ id: r.id, person: r.you ? 'you' : r.name, label: r.label, part: r.part, availability: r.availability, waiting: r.waiting || undefined }),
  my_time_away: (r) => ({ id: r.id, type: r.leaveType, range: r.range, amount: r.amount, status: r.status }),
};

/** The fenced JSON a tool result becomes for the model. */
export function modelView(result, ctx = {}) {
  if (!result) return null;
  if (result.error) return { tool: result.tool, error: result.error };
  const pick = PICK[result.tool] || ((r) => ({ id: r.id }));
  const out = { tool: result.tool, counts: result.counts || {}, rows: (result.rows || []).map((r) => pick(r, ctx)) };
  if (result.side) out.side = result.side;
  if (result.filter) out.filter = result.filter;
  if (result.date) out.date = result.dateLabel || result.date;
  if (result.scope) out.scope = result.scope;
  if (result.balances) out.balances = result.balances;
  if (result.notAnAgent) out.note = 'The person is not an agent, so no tickets are assigned to them.';
  if (result.noTicketAccess) out.note = 'The person cannot open tickets in any workspace.';
  if (result.noTeam) out.note = 'The person is not on a team the calendar can show.';
  if ((result.counts?.total ?? result.counts?.matching ?? 0) > (result.rows || []).length) out.more = true;
  return JSON.parse(JSON.stringify(out));
}

/** Every row id a result carries (what confirm / focus_ids may name). */
export function idsOf(result) {
  return (result?.rows || []).map((r) => r.id).filter(Boolean);
}

export default { ASSISTANT_TOOLS, SUBMIT_ANSWER_TOOL, executeAssistantTool, modelView, idsOf, resolveDay, fmtWhen, fmtDay };
