/**
 * Shared mocks for the Teams assistant tests (mocked Prisma: the client is
 * not regenerated, so the three new tables exist only here). Invented people:
 *   alex.rivera  — an agent in IT (technician 7)
 *   sam.ortiz    — a workspace member of Accounting (access row, no agent profile)
 *   jordan.lee   — a manager who only approves (no access row, no agent profile)
 *   casey.kim    — a super admin, also an agent in IT (technician 9)
 */
import { jest } from '@jest/globals';

export const ALEX = 'alex.rivera@example.com';
export const SAM = 'sam.ortiz@example.com';
export const JORDAN = 'jordan.lee@example.com';
export const CASEY = 'casey.kim@example.com';
export const OTHER = 'riley.chen@example.com';

export const WORKSPACES = [
  { id: 1, name: 'IT', slug: 'it' },
  { id: 2, name: 'Accounting', slug: 'accounting' },
  { id: 4, name: 'Field Equipment', slug: 'field-equipment' },
  { id: 5, name: 'Project Accounting', slug: 'project-accounting' },
];
export const TECHS = [
  { id: 7, name: 'Alex Rivera', email: ALEX, workspaceId: 1, timezone: 'America/Vancouver', isActive: true },
  { id: 9, name: 'Casey Kim', email: CASEY, workspaceId: 1, timezone: 'America/Vancouver', isActive: true },
  { id: 99, name: 'Riley Chen', email: OTHER, workspaceId: 1, timezone: 'America/Vancouver', isActive: true },
];
const day = (n) => new Date(Date.now() + n * 86400_000);
export const TICKETS = [
  { id: 101, workspaceId: 1, assignedTechId: 7, subject: 'VPN drops every hour', status: 'Open', priority: 3, dueBy: day(-2), origin: 'ticketpulse', nativeNumber: 10422, freshserviceTicketId: null, isNoise: false, createdAt: day(-5), updatedAt: day(-1) },
  { id: 102, workspaceId: 1, assignedTechId: 7, subject: 'New monitor for the Calgary office', status: 'Pending', priority: 2, dueBy: day(3), origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 246762n, isNoise: false, createdAt: day(-3), updatedAt: day(-1) },
  { id: 103, workspaceId: 1, assignedTechId: 7, subject: 'Outlook asks for a password', status: 'Open', priority: 1, dueBy: null, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 231164n, isNoise: false, createdAt: day(-1), updatedAt: day(0) },
  { id: 104, workspaceId: 1, assignedTechId: 99, subject: 'Someone else\'s ticket', status: 'Open', priority: 4, dueBy: day(-1), origin: 'ticketpulse', nativeNumber: 10500, freshserviceTicketId: null, isNoise: false, createdAt: day(-2), updatedAt: day(0) },
  { id: 202, workspaceId: 2, assignedTechId: null, subject: 'Purchase order for Riley', status: 'Open', priority: 2, dueBy: null, origin: 'ticketpulse', nativeNumber: 10600, freshserviceTicketId: null, isNoise: false, createdAt: day(-4), updatedAt: day(-2) },
  { id: 201, workspaceId: 2, assignedTechId: null, subject: 'Invoice 4410 for Acme Supplies', status: 'Open', priority: 2, dueBy: null, origin: 'ticketpulse', nativeNumber: 10422, freshserviceTicketId: null, isNoise: false, createdAt: day(-4), updatedAt: day(-2) },
];
export const APPROVALS = [
  { id: 12, workspaceId: 2, ticketId: 201, approverEmail: JORDAN, requestedBy: ALEX, status: 'pending', tier: 1, createdAt: day(-2), updatedAt: day(-2) },
  { id: 15, workspaceId: 1, ticketId: 101, approverEmail: ALEX, requestedBy: CASEY, status: 'pending', tier: 1, createdAt: day(-1), updatedAt: day(-1) },
  { id: 16, workspaceId: 1, ticketId: 102, approverEmail: CASEY, requestedBy: ALEX, status: 'info_requested', tier: 1, createdAt: day(-3), updatedAt: day(-1) },
  { id: 20, workspaceId: 2, ticketId: 202, approverEmail: OTHER, requestedBy: SAM, status: 'pending', tier: 1, createdAt: day(-1), updatedAt: day(-1) },
];

const lc = (s) => String(s || '').trim().toLowerCase();
const inList = (cond, v) => (cond === undefined ? true : cond?.in ? cond.in.map(lc).includes(lc(v)) : (typeof cond === 'object' && cond !== null && 'equals' in cond ? lc(cond.equals) === lc(v) : lc(cond) === lc(v)));
const numIn = (cond, v) => (cond === undefined ? true : cond?.in ? cond.in.map(Number).includes(Number(v)) : Number(cond) === Number(v));

function ticketMatches(where, t) {
  if (!where) return true;
  if (where.isNoise === false && t.isNoise) return false;
  if (where.id !== undefined && !numIn(where.id, t.id)) return false;
  if (where.workspaceId !== undefined && !numIn(where.workspaceId, t.workspaceId)) return false;
  if (where.assignedTechId !== undefined && !numIn(where.assignedTechId, t.assignedTechId)) return false;
  if (where.status !== undefined && !inList(where.status, t.status)) return false;
  if (where.dueBy) {
    if (!t.dueBy) return false;
    if (where.dueBy.lt && !(t.dueBy < where.dueBy.lt)) return false;
    if (where.dueBy.gte && !(t.dueBy >= where.dueBy.gte)) return false;
    if (where.dueBy.lte && !(t.dueBy <= where.dueBy.lte)) return false;
  }
  if (where.OR && !where.OR.some((s) => ticketMatches(s, t))) return false;
  return true;
}
function approvalMatches(where, a) {
  if (where.id !== undefined && Number(where.id) !== a.id) return false;
  if (where.ticketId !== undefined && Number(where.ticketId) !== a.ticketId) return false;
  if (where.workspaceId !== undefined && !numIn(where.workspaceId, a.workspaceId)) return false;
  if (where.approverEmail !== undefined && lc(where.approverEmail) !== a.approverEmail) return false;
  if (where.requestedBy !== undefined && lc(where.requestedBy) !== a.requestedBy) return false;
  if (where.status !== undefined && !inList(where.status, a.status)) return false;
  return true;
}

export function buildMocks() {
  const state = {
    settings: new Map(), // workspaceId -> row
    people: new Map(), // email -> row
    turns: [],
    spend: [],
    teamsOn: new Set([1, 2]),
    nextTurnId: 1,
  };
  const ticketRow = (t) => (t ? { ...t, assignedTech: TECHS.find((x) => x.id === t.assignedTechId) ? { name: TECHS.find((x) => x.id === t.assignedTechId).name } : null, internalGroup: { name: 'Service Desk' }, requester: { name: 'Sam Ortiz' }, workspace: { defaultTimezone: 'America/Vancouver' } } : null);
  const prismaMock = {
    teamsAssistantSetting: {
      findUnique: jest.fn(async ({ where }) => state.settings.get(where.workspaceId) || null),
      upsert: jest.fn(async ({ where, update, create }) => {
        const cur = state.settings.get(where.workspaceId);
        const row = cur ? { ...cur, ...update } : { ...create };
        state.settings.set(where.workspaceId, row);
        return row;
      }),
    },
    teamsAssistantPerson: {
      findUnique: jest.fn(async ({ where }) => state.people.get(where.email) || null),
      upsert: jest.fn(async ({ where, update, create }) => {
        const row = state.people.has(where.email) ? { ...state.people.get(where.email), ...update } : { ...create };
        state.people.set(where.email, row);
        return row;
      }),
    },
    teamsAssistantTurn: {
      create: jest.fn(async ({ data }) => { const row = { id: state.nextTurnId++, createdAt: new Date(), ...data }; state.turns.push(row); return row; }),
      update: jest.fn(async ({ where, data }) => { const row = state.turns.find((t) => t.id === where.id); Object.assign(row, data); return row; }),
      updateMany: jest.fn(async ({ where, data }) => { let count = 0; for (const t of state.turns) if (t.id === where.id && t.email === where.email) { Object.assign(t, data); count++; } return { count }; }),
      findMany: jest.fn(async ({ where, take }) => state.turns
        .filter((t) => (!where?.conversationId || t.conversationId === where.conversationId) && (!where?.email || t.email === where.email) && (!where?.createdAt?.gte || t.createdAt >= where.createdAt.gte))
        .sort((a, b) => b.id - a.id).slice(0, take || 50)),
      deleteMany: jest.fn(async ({ where }) => { const before = state.turns.length; state.turns = state.turns.filter((t) => !(t.createdAt < where.createdAt.lt)); return { count: before - state.turns.length }; }),
    },
    aiProviderAttempt: { findMany: jest.fn(async () => state.spend), create: jest.fn(), update: jest.fn() },
    notificationWorkspaceSetting: { findUnique: jest.fn(async ({ where }) => ({ workspaceId: where.workspaceId, teamsEnabled: state.teamsOn.has(where.workspaceId), defaults: null })) },
    technician: {
      findMany: jest.fn(async ({ where = {} } = {}) => TECHS.filter((t) => (where.isActive === undefined || t.isActive === where.isActive)
        && (where.email === undefined || inList(where.email, t.email))
        && (where.workspaceId === undefined || numIn(where.workspaceId, t.workspaceId))
        && (where.id === undefined || numIn(where.id, t.id)))),
      findFirst: jest.fn(async ({ where = {} } = {}) => TECHS.find((t) => (where.email === undefined || inList(where.email, t.email)) && (where.workspaceId === undefined || numIn(where.workspaceId, t.workspaceId))) || null),
    },
    ticket: {
      findMany: jest.fn(async ({ where, take }) => TICKETS.filter((t) => ticketMatches(where, t)).slice(0, take || 1000)),
      count: jest.fn(async ({ where }) => TICKETS.filter((t) => ticketMatches(where, t)).length),
      findFirst: jest.fn(async ({ where }) => ticketRow(TICKETS.find((t) => ticketMatches({ id: where.id, ...(where.workspaceId !== undefined ? { workspaceId: where.workspaceId } : {}) }, t)) || null)),
    },
    ticketApproval: {
      groupBy: jest.fn(async ({ where }) => {
        const by = new Map();
        for (const a of APPROVALS) if (approvalMatches(where, a)) by.set(a.workspaceId, (by.get(a.workspaceId) || 0) + 1);
        return [...by].map(([workspaceId, n]) => ({ workspaceId, _count: { _all: n } }));
      }),
      findMany: jest.fn(async ({ where }) => APPROVALS.filter((a) => approvalMatches(where, a)).map((a) => ({ ...a, approverName: 'Jordan Lee', approvalCategory: { name: 'Laptop purchase' }, ticket: ticketRow(TICKETS.find((t) => t.id === a.ticketId)) }))),
      findFirst: jest.fn(async ({ where }) => APPROVALS.find((a) => approvalMatches(where, a)) || null),
      count: jest.fn(async ({ where }) => APPROVALS.filter((a) => approvalMatches(where, a)).length),
    },
    approvalCategory: { findUnique: jest.fn(async () => ({ name: 'Laptop purchase' })) },
    workspace: {
      findMany: jest.fn(async ({ where }) => WORKSPACES.filter((w) => numIn(where?.id, w.id))),
      findUnique: jest.fn(async ({ where }) => ({ ...WORKSPACES.find((w) => w.id === where.id), nativeTicketingEnabled: true })),
    },
    avPerson: { findUnique: jest.fn(async ({ where }) => ([ALEX, CASEY].includes(where.email) ? { id: 1, email: where.email } : null)) },
    avLeaveType: { findMany: jest.fn(async () => [{ id: 1, name: 'Vacation', unit: 'day' }]) },
    group: { findFirst: jest.fn(async () => null) },
    teamsDelivery: { create: jest.fn(async () => ({})), findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
    teamsConversation: { findFirst: jest.fn(async () => null), findUnique: jest.fn(async () => null) },
    workspaceAccess: { findMany: jest.fn(async () => []) },
  };

  const botMock = {
    isTeamsConfigured: jest.fn(() => true),
    teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
    cardActivity: jest.fn((card, o = {}) => ({ type: 'message', card, ...o })),
    replyToActivity: jest.fn(async () => ({ id: 'reply-1' })),
    sendToConversation: jest.fn(async () => 'act-1'),
    updateActivity: jest.fn(async () => {}),
    findUser: jest.fn(async () => null),
    describeError: (e) => e.message,
  };

  const access = {
    getAdminEmails: jest.fn(async () => [CASEY]),
    resolveUserAccess: jest.fn(async (email, role) => {
      if (role === 'admin') return { role: 'admin', availableWorkspaces: WORKSPACES.map((w) => ({ ...w, role: 'admin' })), agentProfiles: [] };
      if (email === ALEX) return { role: 'agent', availableWorkspaces: [{ ...WORKSPACES[0], role: 'agent' }], agentProfiles: [{ id: 7 }] };
      if (email === SAM) return { role: 'viewer', availableWorkspaces: [{ ...WORKSPACES[1], role: 'viewer' }], agentProfiles: [] };
      return { role, availableWorkspaces: [], agentProfiles: [] };
    }),
  };

  const inboxRow = (a) => ({ id: a.id, ticketId: a.ticketId, status: a.status, tier: a.tier, tierCount: 1, tierName: 'Tier 1', displayRef: TICKETS.find((t) => t.id === a.ticketId)?.nativeNumber ? `TP-${TICKETS.find((t) => t.id === a.ticketId).nativeNumber}` : '#246762', subject: TICKETS.find((t) => t.id === a.ticketId)?.subject, requesterName: 'Sam Ortiz', categoryName: 'Laptop purchase', approverEmail: a.approverEmail, amountLabel: null, createdAt: a.createdAt });
  const approvals = {
    inboxFor: jest.fn(async (wsId, actor) => APPROVALS.filter((a) => a.workspaceId === wsId && a.status === 'pending' && a.approverEmail === lc(actor.email)).map(inboxRow)),
    waitingFor: jest.fn(async (wsId, actor) => APPROVALS.filter((a) => a.workspaceId === wsId && a.status === 'info_requested' && a.approverEmail === lc(actor.email)).map((a) => ({ ...inboxRow(a), waitingSince: a.updatedAt }))),
    decideInApp: jest.fn(),
  };

  const availability = {
    listPendingFor: jest.fn(async (user) => {
      const rows = [];
      if ([JORDAN, CASEY].includes(lc(user.email))) rows.push({ id: 31, email: SAM, name: 'Sam Ortiz', leaveTypeId: 1, startDate: '2026-11-16', endDate: '2026-11-20', dayPart: 'full', days: 5, mine: true, teams: ['Accounting'], createdAt: day(-1), note: 'PRIVATE LEAVE NOTE' });
      if (lc(user.email) === CASEY) rows.push({ id: 32, email: ALEX, name: 'Alex Rivera', leaveTypeId: 1, startDate: '2026-12-01', endDate: '2026-12-01', dayPart: 'am', days: 0.5, mine: false, teams: ['IT'], createdAt: day(-2) });
      return rows;
    }),
    calendar: jest.fn(async () => ({ people: [{ email: SAM, name: 'Sam Ortiz' }, { email: ALEX, name: 'Alex Rivera' }], entries: [{ email: SAM, label: 'Vacation', dayPart: 'full', availability: 'OFF', status: 'approved' }, { email: ALEX, label: 'Working from home', dayPart: 'full', availability: 'WFH', status: 'approved' }] })),
    listMine: jest.fn(async () => [{ id: 41, leaveTypeId: 1, startDate: '2026-12-21', endDate: '2026-12-31', status: 'approved', days: 7, dayPart: 'full', note: 'PRIVATE LEAVE NOTE' }]),
    balances: jest.fn(async () => [{ name: 'Vacation', entitled: 15, taken: 5, scheduled: 7, pending: 0, remaining: 3 }]),
  };

  const gateway = { runToolTurn: jest.fn() };
  const mail = { sendTransactionalEmail: jest.fn(async () => ({ sent: true, via: 'sendgrid' })) };
  const recipients = { superAdminEmails: jest.fn(async () => [CASEY]) };
  const statusNamesForBase = jest.fn(async (_ws, bases) => bases);
  const resolveTicketRef = jest.fn(async (raw, wsId) => {
    const ref = String(raw).trim();
    const tp = ref.match(/^tp-?(\d+)$/i);
    const n = Number(ref.replace(/^#/, ''));
    const hit = TICKETS.find((t) => t.workspaceId === wsId && (tp ? t.nativeNumber === Number(tp[1]) : (t.freshserviceTicketId !== null && Number(t.freshserviceTicketId) === n) || (!ref.startsWith('#') && t.nativeNumber === n)));
    return hit ? { id: hit.id } : null;
  });

  return { state, prismaMock, botMock, access, approvals, availability, gateway, mail, recipients, statusNamesForBase, resolveTicketRef };
}

/** Register every mock, then import the modules under test. */
export async function setupAssistant() {
  process.env.PUBLIC_APP_URL = 'https://tp.example.com';
  const m = buildMocks();
  const log = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: m.prismaMock }));
  jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: log }));
  jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: m.botMock }));
  jest.unstable_mockModule('../src/routes/auth.routes.js', () => ({ ...m.access, default: {} }));
  jest.unstable_mockModule('../src/services/ticketApprovalService.js', () => ({ default: m.approvals }));
  jest.unstable_mockModule('../src/services/availability/availabilityService.js', () => ({
    default: m.availability,
    describeRange: (r) => (r.startDate === r.endDate ? `${r.startDate}${r.dayPart === 'am' ? ' (morning)' : ''}` : `${r.startDate} – ${r.endDate}`),
    describeAmount: (r) => `${r.days} day${Number(r.days) === 1 ? '' : 's'}`,
  }));
  jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({ default: m.gateway }));
  jest.unstable_mockModule('../src/services/tokenUsageService.js', () => ({ costUsdFor: ({ inputTokens = 0, outputTokens = 0 }) => inputTokens * 1e-7 + outputTokens * 5e-7 }));
  jest.unstable_mockModule('../src/services/transactionalEmailService.js', () => ({ sendTransactionalEmail: m.mail.sendTransactionalEmail, default: m.mail }));
  jest.unstable_mockModule('../src/services/reportRecipients.js', () => ({ superAdminEmails: m.recipients.superAdminEmails, default: m.recipients }));
  jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { statusNamesForBase: m.statusNamesForBase, resolveBaseStatus: jest.fn() } }));
  jest.unstable_mockModule('../src/services/ticketRefResolver.js', () => ({ resolveTicketRef: m.resolveTicketRef }));
  jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { assignTicket: jest.fn(), addPrivateNote: jest.fn(), addReply: jest.fn() } }));

  const svcModule = await import('../../src/services/teamsAssistantService.js');
  const tools = await import('../../src/services/teamsAssistantTools.js');
  const accessModule = await import('../../src/services/teamsAssistantAccess.js');
  const settingsModule = await import('../../src/services/teamsAssistantSettings.js');
  const { default: notifications } = await import('../../src/services/teamsNotificationService.js');
  const intake = await import('../../src/services/teamsIntakeService.js');
  return { ...m, log, svcModule, svc: svcModule.default, tools, accessModule, settings: settingsModule.default, settingsModule, notifications, intake };
}

/** A model reply in the shape providerGateway.runToolTurn returns. */
export function toolTurn(blocks, { provider = 'anthropic', model = 'claude-haiku-5-5', inputTokens = 2000, outputTokens = 100 } = {}) {
  return {
    provider, model,
    usage: { inputTokens, outputTokens },
    message: {
      stop_reason: 'tool_use',
      content: blocks.map((b, i) => ({ type: 'tool_use', id: `tu_${i}_${Math.random().toString(36).slice(2, 7)}`, name: b.name, input: b.input || {} })),
    },
  };
}

export function message(text, { from = 'aad-alex', id = `m-${Math.random()}`, conversation = 'conv-1' } = {}) {
  return { type: 'message', id, text, serviceUrl: 'https://smba.example.com/', conversation: { id: conversation, conversationType: 'personal' }, from: { aadObjectId: from }, attachments: [] };
}

export const cardText = (card) => JSON.stringify(card);
