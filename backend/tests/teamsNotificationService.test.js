import { jest } from '@jest/globals';

/**
 * Teams notifications (plans/TEAMS_NOTIFICATIONS_PLAN.md): preferences, the
 * never-yourself / mute / digest / away rules, coalescing, cards and card actions.
 */

const prismaMock = {
  notificationWorkspaceSetting: { findUnique: jest.fn(), upsert: jest.fn() },
  notificationPreference: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn(), update: jest.fn() },
  ticketNotificationMute: { findUnique: jest.fn(), upsert: jest.fn(), findMany: jest.fn(), deleteMany: jest.fn() },
  teamsDelivery: { create: jest.fn().mockResolvedValue({}), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  teamsConversation: { findUnique: jest.fn(), findFirst: jest.fn(), upsert: jest.fn(), update: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn() },
  technicianLeave: { findFirst: jest.fn().mockResolvedValue(null) },
  technicianNotificationPreference: { findUnique: jest.fn().mockResolvedValue(null) },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketThreadEntry: { findUnique: jest.fn() },
  ticketApproval: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  approvalCategory: { findUnique: jest.fn() },
  workspace: { findUnique: jest.fn().mockResolvedValue({ nativeTicketingEnabled: true }) },
  group: { findFirst: jest.fn() },
  groupMember: { findMany: jest.fn() },
};
const botMock = {
  isTeamsConfigured: jest.fn(() => true),
  teamsConfig: jest.fn(() => ({ appId: 'app', tenantId: 'tenant' })),
  sendToConversation: jest.fn().mockResolvedValue('act-1'),
  cardActivity: jest.fn((card, o) => ({ type: 'message', card, ...o })),
  sendActivityFeed: jest.fn().mockResolvedValue(),
  findUser: jest.fn(),
  installForUser: jest.fn().mockResolvedValue('installed'),
  createPersonalConversation: jest.fn().mockResolvedValue({ conversationId: 'conv-1', serviceUrl: 'https://smba/' }),
  postToWorkflowWebhook: jest.fn().mockResolvedValue(),
  describeError: (e) => e.message,
  updateActivity: jest.fn().mockResolvedValue(),
};
const assignTicket = jest.fn().mockResolvedValue({});
const addPrivateNote = jest.fn().mockResolvedValue({});
const decideInApp = jest.fn().mockResolvedValue({});

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/teamsBotClient.js', () => ({ default: botMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: { assignTicket, addPrivateNote, addReply: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketApprovalService.js', () => ({ default: { decideInApp } }));
const statusNamesForBase = jest.fn();
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { statusNamesForBase, resolveBaseStatus: jest.fn() } }));

const { default: svc, effectivePrefs, cleanPrefs, eventActor, EVENTS, approvalClosedStage } = await import('../src/services/teamsNotificationService.js');
const { ticketCard, approvalCard } = await import('../src/services/teamsCards.js');

const ctx = (type, extra = {}, over = {}) => ({
  event: { type, extra },
  workspace: { id: 1, timezone: 'America/Vancouver' },
  ticket: { id: 50, displayRef: '#244001', subject: 'VPN down', priority: 2, descriptionText: 'Cannot connect', status: 'Open', groupId: null, isNoise: false },
  requester: { name: 'Rita' },
  assignedAgent: { id: 7, name: 'Adrian Lo', email: 'adrian@x.io' },
  previousAgent: null,
  ...over,
});
const ADRIAN = { id: 7, name: 'Adrian Lo', email: 'adrian@x.io', timezone: 'America/Vancouver', workStartTime: null, workEndTime: null };

beforeEach(() => {
  jest.useRealTimers();
  svc.pending.clear();
  prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 1, teamsEnabled: true, defaults: null });
  prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
  prismaMock.ticketNotificationMute.findUnique.mockResolvedValue(null);
  prismaMock.technician.findFirst.mockResolvedValue(ADRIAN);
  prismaMock.teamsConversation.findUnique.mockResolvedValue({ email: 'adrian@x.io', conversationId: 'conv-1', serviceUrl: 'https://smba/', aadObjectId: 'aad-7' });
  prismaMock.teamsDelivery.create.mockClear();
  botMock.sendToConversation.mockClear();
});

describe('preferences', () => {
  test('own choice beats the workspace default, which beats the built-in default', () => {
    const p = effectivePrefs({ events: { status_changed: 'teams' }, options: { dailyDigest: true } }, { events: { assigned: 'digest' }, options: { respectAway: false } });
    expect(p.events.assigned).toBe('digest');
    expect(p.events.status_changed).toBe('teams');
    expect(p.events.group_unassigned).toBe('off');
    expect(p.options).toMatchObject({ dailyDigest: true, respectAway: false, urgentBypassesQuiet: true });
  });
  test('cleanPrefs drops unknown keys and bad values', () => {
    expect(cleanPrefs({ events: { assigned: 'teams', bogus: 'teams', reopened: 'loud' }, options: { digestTime: '25:00', groupMinPriority: 9, dailyDigest: true } }))
      .toEqual({ events: { assigned: 'teams' }, options: { groupMinPriority: 4, dailyDigest: true } });
  });
  test('every event has a label and a group', () => {
    for (const e of EVENTS) expect(e.label && e.group && ['teams', 'digest', 'off'].includes(e.mode)).toBeTruthy();
  });
  test('eventActor reads the actor from any event shape', () => {
    expect(eventActor(ctx('ticket.note_added', { byEmail: 'Adrian@X.io' })).email).toBe('adrian@x.io');
    expect(eventActor(ctx('ticket.status_changed', { actor: { email: 'a@b.c', technicianId: 3 } }))).toEqual({ email: 'a@b.c', technicianId: 3 });
  });
});

describe('rules before a card is sent', () => {
  test('never about your own action', async () => {
    await svc._onTicketEvent(ctx('ticket.note_added', { byEmail: 'adrian@x.io', bodyText: 'mine' }));
    expect(svc.pending.size).toBe(0);
  });
  test("someone else's note on my ticket is queued once, then sent as one card", async () => {
    await svc._onTicketEvent(ctx('ticket.note_added', { byEmail: 'sam@x.io', author: 'Sam', bodyText: 'Checked the VPN logs' }));
    await svc._onTicketEvent(ctx('ticket.public_reply_added', { byEmail: 'sam@x.io', author: 'Sam', bodyText: 'Second' }));
    expect(svc.pending.size).toBe(1);
    const key = [...svc.pending.keys()][0];
    clearTimeout(svc.pending.get(key).timer);
    await svc._flush(key);
    expect(botMock.sendToConversation).toHaveBeenCalledTimes(1);
    const card = botMock.cardActivity.mock.calls.at(-1)[0];
    expect(JSON.stringify(card)).toContain('Checked the VPN logs');
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'sent', eventKey: 'teammate_update', ticketId: 50 }) }));
  });
  test('off means nothing, digest is held, mute is recorded as skipped', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValueOnce({ events: { requester_replied: 'off' } });
    await svc._onTicketEvent(ctx('ticket.reply_received', {}));
    expect(svc.pending.size).toBe(0);
    expect(prismaMock.teamsDelivery.create).not.toHaveBeenCalled();

    prismaMock.notificationPreference.findUnique.mockResolvedValueOnce({ events: { requester_replied: 'digest' } });
    await svc._onTicketEvent(ctx('ticket.reply_received', {}));
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'digest' }) }));

    prismaMock.ticketNotificationMute.findUnique.mockResolvedValueOnce({ until: new Date(Date.now() + 3600e3) });
    await svc._onTicketEvent(ctx('ticket.reply_received', {}));
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'skipped', reason: 'muted' }) }));
    expect(svc.pending.size).toBe(0);
  });
  test('on leave = silent, but an SLA breach still comes through', async () => {
    prismaMock.technicianLeave.findFirst.mockResolvedValue({ category: 'OFF', isFullDay: true });
    await svc._onTicketEvent(ctx('ticket.reply_received', {}));
    expect(prismaMock.teamsDelivery.create).toHaveBeenLastCalledWith(expect.objectContaining({ data: expect.objectContaining({ reason: 'on_leave' }) }));
    await svc._onTicketEvent(ctx('ticket.sla_breach', {}));
    expect(svc.pending.size).toBe(1);
    prismaMock.technicianLeave.findFirst.mockResolvedValue(null);
    for (const v of svc.pending.values()) clearTimeout(v.timer);
  });
  test('workspace switch off = nothing', async () => {
    prismaMock.notificationWorkspaceSetting.findUnique.mockResolvedValue({ workspaceId: 1, teamsEnabled: false });
    await svc._onTicketEvent(ctx('ticket.assigned', {}));
    expect(svc.pending.size).toBe(0);
  });
  test('system notes never notify', async () => {
    await svc._onTicketEvent(ctx('ticket.note_added', { systemNote: true, byEmail: 'bot@x.io' }));
    expect(svc.pending.size).toBe(0);
  });
});

describe('cards', () => {
  const t = { id: 50, workspaceId: 1, ref: '#244001', subject: 'VPN down', requesterName: 'Rita', priorityLabel: 'High', dueLabel: 'Oct 1', url: 'https://tp/tickets/50' };
  test('Take it only on unassigned tickets; note and reply only where Ticket Pulse can write', () => {
    const a = ticketCard({ ...t, isUnassigned: true, canWrite: false }, [{ eventKey: 'group_unassigned', text: 'x' }]);
    expect(a.actions.map((x) => x.title)).toEqual(['✋ Take it', 'Open ticket', '💤 Snooze 4 hours', '🔕 Mute this ticket']);
    const b = ticketCard({ ...t, isUnassigned: false, canWrite: true }, [{ eventKey: 'assigned', text: 'x' }]);
    expect(b.actions.map((x) => x.title)).toEqual(['Open ticket', 'Add note', 'Reply', '💤 Snooze 4 hours', '🔕 Mute this ticket']);
    // D2-a: banner with the linked subject and the state as icon + word on the right; facts panel next.
    const bannerCols = b.body[0].items[0].columns;
    expect(bannerCols[0].items[0].text).toBe('VPN down  ↗');
    expect(b.body[0].selectAction.url).toBe('https://tp/tickets/50');
    expect(bannerCols[1].items.map((i) => i.text)).toEqual(['🎫', 'Assigned']);
    expect(JSON.stringify(b.body[1])).toContain('CATEGORY');
  });
  test('approval card: nothing is decided in one click', () => {
    const a = { approvalId: 9, ticketId: 50, workspaceId: 1, categoryName: 'Laptop', decisionUrl: 'https://tp/approval/tok' };
    const ask = approvalCard(a);
    expect(ask.actions.filter((x) => x.verb).map((x) => x.verb)).toEqual(['approval.prepare', 'approval.prepare']);
    const confirm = approvalCard(a, { confirm: 'rejected' });
    expect(confirm.body.find((b) => b.type === 'Input.Text').isRequired).toBe(true);
    expect(confirm.actions[0].verb).toBe('approval.confirm');
  });
});

describe('card actions', () => {
  const invoke = (verb, data) => ({ type: 'invoke', name: 'adaptiveCard/action', from: { aadObjectId: 'aad-7' }, value: { action: { verb, data } } });
  beforeEach(() => {
    prismaMock.teamsConversation.findFirst.mockResolvedValue({ email: 'adrian@x.io' });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 50, workspaceId: 1, subject: 'VPN down', priority: 3, freshserviceTicketId: 244001n, origin: 'freshservice', assignedTechId: null, requester: { name: 'Rita' }, workspace: { defaultTimezone: 'America/Vancouver' } });
  });
  test('Take it assigns the ticket to the person who pressed it', async () => {
    const res = await svc.handleActivity(invoke('take', { ticketId: 50, workspaceId: 1 }));
    expect(assignTicket).toHaveBeenCalledWith(50, 1, 7, expect.objectContaining({ email: 'adrian@x.io', technicianId: 7 }));
    expect(res.type).toBe('application/vnd.microsoft.card.adaptive');
    expect(JSON.stringify(res.value)).toContain('Taken by you');
  });
  test('Add note posts an internal note as that agent', async () => {
    const res = await svc.handleActivity(invoke('note', { ticketId: 50, workspaceId: 1, noteText: 'On it' }));
    expect(addPrivateNote).toHaveBeenCalledWith(50, 1, expect.objectContaining({ bodyText: 'On it' }), expect.objectContaining({ technicianId: 7 }));
    expect(JSON.stringify(res.value)).toContain('Note added');
  });
  test('approval confirm decides as the named approver only', async () => {
    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 9, ticketId: 50, workspaceId: 1, approverEmail: 'adrian@x.io', status: 'pending', approvalCategoryId: null });
    botMock.findUser.mockResolvedValue({ displayName: 'Adrian Lo' });
    const res = await svc.handleActivity(invoke('approval.confirm', { approvalId: 9, ticketId: 50, workspaceId: 1, decision: 'approved', decisionNote: 'ok' }));
    expect(decideInApp).toHaveBeenCalledWith(50, 1, 9, 'approved', 'ok', expect.objectContaining({ email: 'adrian@x.io' }));
    expect(JSON.stringify(res.value)).toContain('You approved this');

    prismaMock.ticketApproval.findFirst.mockResolvedValue({ id: 9, ticketId: 50, workspaceId: 1, approverEmail: 'someone.else@x.io', status: 'pending' });
    decideInApp.mockClear();
    const refused = await svc.handleActivity(invoke('approval.confirm', { approvalId: 9, ticketId: 50, workspaceId: 1, decision: 'approved' }));
    expect(decideInApp).not.toHaveBeenCalled();
    expect(JSON.stringify(refused.value)).toContain('Only the named approver');
  });
});

describe('disconnect (QA 10-01 #4)', () => {
  beforeEach(() => {
    botMock.uninstallForUser = jest.fn().mockResolvedValue('removed');
    botMock.installForUser.mockClear();
    prismaMock.teamsConversation.upsert.mockReset().mockResolvedValue({});
    prismaMock.teamsConversation.update.mockReset().mockImplementation(({ data }) => Promise.resolve({ email: 'adrian@x.io', conversationId: null, aadObjectId: 'aad-7', ...data }));
  });

  test('removes the app, clears the chat and marks the person disconnected', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 7, email: 'Adrian@x.io' }]);
    const out = await svc.disconnectAgents(1, [7], 'boss@x.io');
    expect(botMock.uninstallForUser).toHaveBeenCalledWith('aad-7');
    expect(prismaMock.teamsConversation.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { email: 'adrian@x.io' },
      update: expect.objectContaining({ conversationId: null, disconnectedBy: 'boss@x.io', disconnectedAt: expect.any(Date) }),
    }));
    expect(out).toEqual({ disconnected: 1, appRemoved: 1, failed: [] });
  });

  test('a Graph refusal still disconnects here and reports why the app stayed', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 7, email: 'adrian@x.io' }]);
    botMock.uninstallForUser.mockRejectedValue(new Error('Forbidden'));
    const out = await svc.disconnectAgents(1, [7], 'boss@x.io');
    expect(out.disconnected).toBe(1);
    expect(out.failed[0].error).toContain('Forbidden');
  });

  test('a disconnected person gets nothing and the app is NOT re-installed (recorded as skipped)', async () => {
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ email: 'adrian@x.io', conversationId: null, aadObjectId: 'aad-7', disconnectedAt: new Date() });
    const sent = await svc._send('adrian@x.io', { type: 'AdaptiveCard' }, { summary: 'x', workspaceId: 1, technicianId: 7, eventKey: 'assigned' });
    expect(sent).toBeNull();
    expect(botMock.installForUser).not.toHaveBeenCalled();
    expect(botMock.sendToConversation).not.toHaveBeenCalled();
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ status: 'skipped', reason: 'disconnected' }) });
  });

  test('"Connect all" leaves disconnected people alone; the row\'s Connect reconnects them', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 7, email: 'adrian@x.io' }]);
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ email: 'adrian@x.io', conversationId: null, aadObjectId: 'aad-7', disconnectedAt: new Date() });
    const all = await svc.installForAgents(1);
    expect(all).toMatchObject({ connected: 0, skippedDisconnected: 1, failed: [] });
    expect(botMock.installForUser).not.toHaveBeenCalled();

    const one = await svc.installForAgents(1, [7]);
    expect(one).toMatchObject({ connected: 1, skippedDisconnected: 0 });
    expect(prismaMock.teamsConversation.update).toHaveBeenCalledWith({ where: { email: 'adrian@x.io' }, data: { disconnectedAt: null, disconnectedBy: null } });
    expect(botMock.installForUser).toHaveBeenCalledWith('aad-7');
  });
});

// 5 Oct 2026 (Vahid): an approval card in Teams follows the approval.
describe('approval cards follow the approval', () => {
  const AP = {
    id: 31, ticketId: 50, workspaceId: 1, status: 'approved', approverEmail: 'sam@x.io', approvalCategoryId: null, tier: 1,
    requestNote: null, decidedAt: new Date('2026-10-05T16:41:00Z'), decidedVia: 'app', createdAt: new Date('2026-10-05T15:00:00Z'), escalationLog: null,
  };
  const DELIVERY = { id: 9, email: 'sam@x.io', ticketId: 50, eventKey: 'approval_waiting', status: 'sent', activityId: 'act-31', conversationId: 'conv-s', reason: 'approval:31', createdAt: new Date('2026-10-05T15:00:05Z') };
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    botMock.updateActivity.mockClear();
    prismaMock.teamsDelivery.findMany.mockResolvedValue([DELIVERY]);
    prismaMock.teamsConversation.findUnique.mockResolvedValue({ email: 'sam@x.io', conversationId: 'conv-s', serviceUrl: 'https://smba/' });
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 50, subject: 'New laptop', nativeNumber: 1500, origin: 'ticketpulse', requester: { name: 'Rita' } });
    prismaMock.teamsDelivery.findFirst.mockResolvedValue(null);
  });

  test('the approval card is sent with the approval it is about', async () => {
    prismaMock.notificationPreference.findUnique.mockResolvedValue(null);
    await svc._notifyApproval({ approval: { ...AP, status: 'pending', approverEmail: 'adrian@x.io' }, ticket: { id: 50, workspaceId: 1, subject: 'New laptop' }, decisionUrl: 'https://tp/a', categoryName: 'Laptop' });
    expect(prismaMock.teamsDelivery.create).toHaveBeenCalledWith({ data: expect.objectContaining({ eventKey: 'approval_waiting', reason: 'approval:31' }) });
  });

  test('decided in Ticket Pulse → the Teams card is rewritten as decided, without buttons to decide', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([AP]);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(AP);
    await expect(svc._refreshApprovalCards(50)).resolves.toBe(1);
    const [where, activity] = botMock.updateActivity.mock.calls[0];
    expect(where).toEqual({ serviceUrl: 'https://smba/', conversationId: 'conv-s', activityId: 'act-31' });
    const text = JSON.stringify(activity.card);
    expect(text).toContain('You approved this');
    expect(text).not.toContain('approval.prepare');
  });

  test('still waiting → the card is left alone', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([{ ...AP, status: 'pending', decidedAt: null }]);
    await expect(svc._refreshApprovalCards(50)).resolves.toBe(0);
    expect(botMock.updateActivity).not.toHaveBeenCalled();
  });

  test('withdrawn (row deleted) → "withdrawn" card', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([]);
    await svc._refreshApprovalCards(50);
    expect(JSON.stringify(botMock.updateActivity.mock.calls[0][1].card)).toContain('withdrawn');
  });

  test('cards sent before the approval id was recorded match the approver and send time', async () => {
    prismaMock.teamsDelivery.findMany.mockResolvedValue([{ ...DELIVERY, reason: null }]);
    prismaMock.ticketApproval.findMany.mockResolvedValue([{ ...AP, approverEmail: 'other@x.io' }]);
    await expect(svc._refreshApprovalCards(50)).resolves.toBe(0);
    prismaMock.ticketApproval.findMany.mockResolvedValue([AP]);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(AP);
    await expect(svc._refreshApprovalCards(50)).resolves.toBe(1);
  });

  test('a failed Teams update is logged, never thrown', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValue([AP]);
    prismaMock.ticketApproval.findFirst.mockResolvedValue(AP);
    botMock.updateActivity.mockRejectedValueOnce(new Error('gone'));
    await expect(svc._refreshApprovalCards(50)).resolves.toBe(0);
    svc.refreshApprovalCards(50);
    await flush();
  });

  test('closed states read plainly', () => {
    expect(approvalClosedStage({ ...AP, status: 'pending' }, 'sam@x.io')).toBeNull();
    expect(approvalClosedStage({ ...AP, status: 'info_requested' }, 'sam@x.io')).toBeNull();
    expect(approvalClosedStage({ ...AP, status: 'rejected', decidedVia: 'link' }, 'sam@x.io')).toMatchObject({ done: 'rejected', headline: 'You did not approve this', detail: expect.stringContaining('from the e-mail link') });
    expect(approvalClosedStage({ ...AP, status: 'cancelled', decisionNote: 'Superseded — approved by Jane Doe' }, 'sam@x.io')).toMatchObject({ done: 'closed', headline: 'No longer needed', detail: 'Superseded — approved by Jane Doe' });
    expect(approvalClosedStage({ ...AP, status: 'forwarded', escalationLog: [{ kind: 'forwarded', toEmails: ['cfo@x.io'], byName: 'Sam' }] }, 'sam@x.io'))
      .toMatchObject({ word: 'Handed on', detail: 'Forwarded to cfo@x.io by Sam. Nothing is needed from you.' });
    expect(approvalClosedStage({ ...AP, conditionNote: 'Under 2k' }, 'sam@x.io').detail).toContain('Condition: Under 2k');
  });
});

// 7 Oct 2026: Vahid's digest read "200 open, 200 overdue". The numbers were
// counted from a list capped at 200, and "open" matched Closed and Deleted
// tickets that had no resolved/closed date.
describe('daily digest counts', () => {
  const past = new Date(Date.now() - 3 * 86400_000);
  const ROWS = Array.from({ length: 10 }, (_, i) => ({ id: 900 + i, subject: `Ticket ${i}`, dueBy: past, priority: 2, freshserviceTicketId: BigInt(245000 + i), nativeNumber: null, origin: 'freshservice' }));

  beforeEach(() => {
    prismaMock.technician.findMany.mockResolvedValue([
      { id: 59, name: 'Vahid Haeri', workspaceId: 1, timezone: 'America/Vancouver' },
      { id: 901914, name: 'Vahid Haeri', workspaceId: 2, timezone: 'America/Vancouver' },
    ]);
    statusNamesForBase.mockImplementation(async (ws) => (ws === 1 ? ['Open', 'Pending', 'Pending Response'] : ['Open', 'Pending']));
    prismaMock.ticket.findMany.mockImplementation(async (args) => (args.select?.subject ? ROWS : [{ dueBy: new Date() }]));
    prismaMock.ticket.count.mockImplementation(async ({ where }) => (where.dueBy ? 4 : 14));
    prismaMock.teamsDelivery.findMany.mockResolvedValue([]);
    prismaMock.ticket.count.mockClear();
    prismaMock.ticket.findMany.mockClear();
  });

  test('open means an open or pending status in each workspace, never "no closed date"', async () => {
    await svc._digestCardFor('vhaeri@x.io');
    const where = prismaMock.ticket.count.mock.calls[0][0].where;
    expect(where).toEqual({
      OR: [
        { workspaceId: 1, assignedTechId: { in: [59] }, status: { in: ['Open', 'Pending', 'Pending Response'] } },
        { workspaceId: 2, assignedTechId: { in: [901914] }, status: { in: ['Open', 'Pending'] } },
      ],
      isNoise: false,
    });
    expect(JSON.stringify(where)).not.toContain('resolvedAt');
  });

  test('the three numbers are real counts, the list shows ten, and "more" follows the open count', async () => {
    const card = await svc._digestCardFor('vhaeri@x.io');
    const text = JSON.stringify(card);
    expect(text).toContain('"text":"14"');
    expect(text).toContain('"text":"4"');
    expect(text).toContain('"text":"1"');
    expect(text).toContain('and 4 more');
    expect(prismaMock.ticket.findMany.mock.calls[0][0].take).toBe(10);
  });

  test('a status registry that cannot be read falls back to Open and Pending', async () => {
    statusNamesForBase.mockRejectedValue(new Error('registry down'));
    await svc._digestCardFor('vhaeri@x.io');
    expect(prismaMock.ticket.count.mock.calls[0][0].where.OR[0].status).toEqual({ in: ['Open', 'Pending'] });
  });
});
