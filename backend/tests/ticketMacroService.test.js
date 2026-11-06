import { jest } from '@jest/globals';

/**
 * Macros as an ordered action list (QA 11-05 #2): every action runs through
 * the normal service path, variables render, FreshService-born tickets only
 * get what the app already writes back, and a reply to an unattended
 * requester sends nothing.
 */

const prismaMock = {
  ticketMacro: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), delete: jest.fn() },
  ticket: { findFirst: jest.fn() },
  technician: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
  group: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketTag: { findMany: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const ticketServiceMock = {
  assignTicket: jest.fn(),
  updateTicketFields: jest.fn(),
  updateFsTicket: jest.fn(),
  addPrivateNote: jest.fn(),
  addReply: jest.fn(),
  changeStatus: jest.fn(),
  setTags: jest.fn(),
  _audit: jest.fn(),
  _validateTaxonomy: jest.fn(),
  _validateTechnician: jest.fn(),
};
const laneMock = { isFsBornRepliesViaTicketPulseEnabled: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/fsBornReplyLaneService.js', () => laneMock);
const settingsGet = jest.fn();
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: settingsGet, set: jest.fn() } }));
const closedInsteadOfResolved = jest.fn(async (_ws, status) => status);
jest.unstable_mockModule('../src/services/autoCloseResolvedService.js', () => ({ default: { closedInsteadOfResolved } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: {
    normalizeStatusName: jest.fn(async (_ws, name) => (['open', 'pending', 'resolved', 'closed'].includes(String(name).toLowerCase())
      ? String(name).charAt(0).toUpperCase() + String(name).slice(1).toLowerCase() : null)),
    listStatuses: jest.fn(async () => [{ name: 'Open' }, { name: 'Pending' }, { name: 'Resolved' }, { name: 'Closed' }]),
  },
}));
jest.unstable_mockModule('../src/services/ticketTypeService.js', () => ({
  default: { normalizeTypeName: jest.fn(async (_ws, name) => (String(name).toLowerCase() === 'incident' ? 'Incident' : Promise.reject(new Error('ticketType must be one of: Incident')))) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: svc, macroSteps, UNATTENDED_REPLY_REASON } = await import('../src/services/ticketMacroService.js');
const { clearMailSubjectCache } = await import('../src/services/mailSubjectService.js');

const ACTOR = { email: 'sam@example.com', name: 'Sam Ortiz', technicianId: 42 };
const tpTicket = (over = {}) => ({
  id: 501, workspaceId: 1, origin: 'ticketpulse', status: 'Open', subject: 'Laptop <slow>', nativeNumber: 11340,
  freshserviceTicketId: null, assignedTechId: null, ccEmails: [],
  requester: { name: 'Alex Rivera', email: 'alex@example.com', unattended: false },
  assignedTech: null, tagLinks: [{ tagId: 3 }],
  ...over,
});

const FULL_MACRO = {
  id: 9, name: 'Spam / phishing', isActive: true,
  actions: {
    version: 2,
    steps: [
      { type: 'reply', subject: 'Re: {{ticket.ref}} {{ticket.subject}}', html: '<p>Hi {{requester.firstName}}, {{assignee.firstName}} has it.</p>' },
      { type: 'note', html: '<p>{{agent.firstName}} applied this for {{workspace.name}}</p><p><img src="data:image/png;base64,iVBORw0KGgo=" alt=""></p>' },
      { type: 'category', categoryId: 10, subcategoryId: 11 },
      { type: 'group', groupId: 5 },
      { type: 'type', ticketType: 'Incident' },
      { type: 'priority', priority: 1 },
      { type: 'due', amount: 2, unit: 'days' },
      { type: 'custom_field', key: 'asset_tag', label: 'Asset tag', value: 'A-1' },
      { type: 'assign', to: 'applier' },
      { type: 'tags', tagIds: [7] },
      { type: 'status', status: 'Closed', resolutionReason: 'false_positive' },
    ],
  },
};
const RESOLUTION = { resolutionReason: 'false_positive', resolutionNote: null };

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketMacro.findFirst.mockResolvedValue(FULL_MACRO);
  prismaMock.ticket.findFirst.mockResolvedValue(tpTicket());
  prismaMock.technician.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([{ id: 10, name: 'Security' }, { id: 11, name: 'Phishing' }]);
  prismaMock.group.findMany.mockResolvedValue([{ id: 5, name: 'Service Desk', origin: 'local', freshserviceId: null }]);
  prismaMock.group.findFirst.mockResolvedValue({ id: 5 });
  prismaMock.ticketTag.findMany.mockResolvedValue([{ id: 7, name: 'phish' }]);
  prismaMock.workspace.findUnique.mockResolvedValue({ name: 'IT' });
  laneMock.isFsBornRepliesViaTicketPulseEnabled.mockResolvedValue(false);
  for (const fn of Object.values(ticketServiceMock)) fn.mockResolvedValue({});
  settingsGet.mockResolvedValue(null);
  closedInsteadOfResolved.mockImplementation(async (_ws, status) => status);
  clearMailSubjectCache();
});

describe('reply subject follows the workspace ticket-number position (4.3.45)', () => {
  const replyOnly = (subject) => ({ id: 12, name: 'Ack', isActive: true, actions: { version: 2, steps: [{ type: 'reply', ...(subject !== undefined ? { subject } : {}), html: '<p>Hi</p>' }] } });

  test.each([
    ['after', 'Re: Laptop <slow> [TP-11340]'],
    ['before', 'Re: [TP-11340] Laptop <slow>'],
  ])('empty subject = the workspace reply subject (%s): nothing overridden, preview shows it', async (position, expected) => {
    settingsGet.mockImplementation(async (key) => (key === 'mail_subject_ws1' ? JSON.stringify({ refPosition: position }) : null));
    prismaMock.ticketMacro.findFirst.mockResolvedValue(replyOnly(undefined));
    const preview = await svc.preview(501, 1, 12, ACTOR);
    expect(preview.steps[0]).toEqual(expect.objectContaining({ subject: expected, subjectIsDefault: true }));
    await svc.apply(501, 1, 12, ACTOR);
    // No override sent: addReply's effectiveReplySubject builds the same default.
    expect(ticketServiceMock.addReply.mock.calls[0][2]).not.toHaveProperty('subject');
  });

  test.each([
    ['after', 'Laptop update [TP-11340]'],
    ['before', '[TP-11340] Laptop update'],
  ])('a typed subject overrides it and gets the number where the workspace puts it (%s)', async (position, expected) => {
    settingsGet.mockImplementation(async (key) => (key === 'mail_subject_ws1' ? JSON.stringify({ refPosition: position }) : null));
    prismaMock.ticketMacro.findFirst.mockResolvedValue(replyOnly('Laptop update'));
    const preview = await svc.preview(501, 1, 12, ACTOR);
    expect(preview.steps[0]).toEqual(expect.objectContaining({ subject: expected, subjectIsDefault: false }));
    await svc.apply(501, 1, 12, ACTOR);
    expect(ticketServiceMock.addReply.mock.calls[0][2].subject).toBe('Laptop update');
  });

  test('a stored "[{{ticket.ref}}] {{ticket.subject}}" (the early editor default) reads as empty', () => {
    const [step] = macroSteps({ steps: [{ type: 'reply', subject: '[{{ ticket.ref }}] {{ticket.subject}}', html: '<p>x</p>' }] });
    expect(step).not.toHaveProperty('subject');
  });
});

describe('Resolved retired in the workspace (QA 10-30 #2)', () => {
  beforeEach(() => {
    closedInsteadOfResolved.mockImplementation(async (_ws, status) => (status === 'Resolved' ? 'Closed' : status));
  });

  test('"Set status Resolved" lands as Closed, and the preview says so', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue({ id: 13, name: 'Done', isActive: true, actions: { setStatus: 'Resolved' } });
    const preview = await svc.preview(501, 1, 13, ACTOR);
    expect(preview.steps[0]).toEqual(expect.objectContaining({ summary: 'Set status to Closed', notice: expect.stringMatching(/Resolved is retired/) }));
    await svc.apply(501, 1, 13, ACTOR);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, 1, 'Closed', ACTOR);
  });

  test('saving a Resolved step in a retired workspace stores Closed', async () => {
    prismaMock.ticketMacro.create.mockImplementation(({ data }) => Promise.resolve({ id: 14, ...data }));
    const m = await svc.create(1, { name: 'Done', actions: { steps: [{ type: 'status', status: 'resolved' }] } }, ACTOR);
    expect(m.actions.steps[0].status).toBe('Closed');
  });
});

describe('stored shape', () => {
  test('a macro saved in the old key shape reads as ordered steps (assign, priority, note, reply, status)', () => {
    expect(macroSteps({ setStatus: 'Resolved', addNote: 'n', replyBody: 'r', setPriority: 2, assignToTechnicianId: 4 })).toEqual([
      { type: 'assign', to: 'technician', technicianId: 4 },
      { type: 'priority', priority: 2 },
      { type: 'note', text: 'n' },
      { type: 'reply', text: 'r' },
      { type: 'status', status: 'Resolved' },
    ]);
    expect(macroSteps({ steps: [{ type: 'note', text: 'x' }] })).toEqual([{ type: 'note', text: 'x' }]);
  });

  test('list() hands every macro out in the v2 shape', async () => {
    prismaMock.ticketMacro.findMany.mockResolvedValue([{ id: 1, name: 'Old', actions: { setStatus: 'Resolved' } }]);
    const [m] = await svc.list(1, { includeInactive: true });
    expect(m.actions).toEqual({ version: 2, steps: [{ type: 'status', status: 'Resolved' }] });
  });

  test('create validates and stores the step list', async () => {
    prismaMock.ticketMacro.create.mockImplementation(({ data }) => Promise.resolve({ id: 3, ...data }));
    const m = await svc.create(1, { name: 'Close it', actions: { steps: [{ type: 'status', status: 'closed', id: 'k1' }, { type: 'due', amount: 4, unit: 'hours' }] } }, ACTOR);
    expect(m.actions.steps).toEqual([{ type: 'status', status: 'Closed', id: 'k1' }, { type: 'due', amount: 4, unit: 'hours' }]);
  });

  test('validation refuses unknown actions, empty notes and bad types', async () => {
    await expect(svc.create(1, { name: 'x', actions: { steps: [{ type: 'launch_rocket' }] } })).rejects.toThrow(/unknown macro action/i);
    await expect(svc.create(1, { name: 'x', actions: { steps: [{ type: 'note', html: '<p> </p>' }] } })).rejects.toThrow(/note is empty/i);
    await expect(svc.create(1, { name: 'x', actions: { steps: [{ type: 'type', ticketType: 'Nope' }] } })).rejects.toThrow(/ticketType must be/i);
    await expect(svc.create(1, { name: 'x', actions: { steps: [] } })).rejects.toThrow(/at least one action/i);
  });
});

describe('apply on a Ticket Pulse-born ticket', () => {
  test('runs every action through the normal paths, in the macro\'s exact order (adjacent fields in one write)', async () => {
    const result = await svc.apply(501, 1, 9, ACTOR);
    expect(result.ok).toBe(true);

    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledTimes(1);
    const [, , patch] = ticketServiceMock.updateTicketFields.mock.calls[0];
    expect(patch).toEqual(expect.objectContaining({
      internalCategoryId: 10, internalSubcategoryId: 11, internalGroupId: 5, groupId: null,
      ticketType: 'Incident', priority: 1, customFields: { asset_tag: 'A-1' },
    }));
    const dueMs = new Date(patch.dueBy).getTime() - Date.now();
    expect(dueMs).toBeGreaterThan(2 * 24 * 3600e3 - 60e3);
    expect(dueMs).toBeLessThanOrEqual(2 * 24 * 3600e3);

    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(501, 1, 42, ACTOR, { allowAssignableOnly: true });
    // Tags are ADDED to the ones already on the ticket.
    expect(ticketServiceMock.setTags).toHaveBeenCalledWith(501, 1, [3, 7], ACTOR);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock.addReply).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, 1, 'Closed', ACTOR, RESOLUTION);
    // QA 11-05b #4: exactly the macro's order — reply, note, the fields, assign, tags, status (last because it is last in the list).
    const order = (fn) => fn.mock.invocationCallOrder[0];
    const seq = ['addReply', 'addPrivateNote', 'updateTicketFields', 'assignTicket', 'setTags', 'changeStatus'].map((k) => order(ticketServiceMock[k]));
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);

    // One "applied macro" history row.
    expect(ticketServiceMock._audit).toHaveBeenCalledTimes(1);
    const [, type, , details] = ticketServiceMock._audit.mock.calls[0];
    expect(type).toBe('macro_applied');
    expect(details.note).toMatch(/^Applied macro “Spam \/ phishing”: reply to the requester; add an internal note; set category to Security \/ Phishing/);
  });

  test('variables render in the reply and the note (HTML-escaped), the picture stays inline for the reply path to lift', async () => {
    await svc.apply(501, 1, 9, ACTOR);
    const [, , reply] = ticketServiceMock.addReply.mock.calls[0];
    expect(reply.subject).toBe('Re: TP-11340 Laptop <slow>');
    // The assignee is the macro's pick (the applier), not the empty current one.
    expect(reply.bodyHtml).toBe('<p>Hi Alex, Sam has it.</p>');
    const [, , note] = ticketServiceMock.addPrivateNote.mock.calls[0];
    expect(note.bodyHtml).toContain('<p>Sam applied this for IT</p>');
    expect(note.bodyHtml).toContain('data:image/png;base64,');
  });

  // 6 Nov 2026, first real use: "Set category Security" then "Set status Closed"
  // with no reason failed on Apply (a Security ticket needs a resolution reason).
  test('closing into Security without a resolution reason is skipped up front, with the reason in the preview', async () => {
    const noReason = JSON.parse(JSON.stringify(FULL_MACRO));
    delete noReason.actions.steps.at(-1).resolutionReason;
    prismaMock.ticketMacro.findFirst.mockResolvedValue(noReason);
    const preview = await svc.preview(501, 1, 9, ACTOR);
    const status = preview.steps.find((s) => s.type === 'status');
    expect(status.run).toBe(false);
    expect(status.reason).toMatch(/resolution reason/i);
    await svc.apply(501, 1, 9, ACTOR);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
  });

  test('a ticket already in Security closes when the step carries a reason; another category needs none', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue({ id: 14, name: 'Close', isActive: true, actions: { steps: [{ type: 'status', status: 'Closed' }] } });
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({ internalCategory: { name: 'Hardware' } }));
    await svc.apply(501, 1, 14, ACTOR);
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(501, 1, 'Closed', ACTOR);
  });

  test('saving a status step validates its resolution reason', async () => {
    await expect(svc.create(1, { name: 'x', actions: { steps: [{ type: 'status', status: 'Closed', resolutionReason: 'nope' }] } })).rejects.toThrow(/Unknown resolution reason/);
    await expect(svc.create(1, { name: 'x', actions: { steps: [{ type: 'status', status: 'Closed', resolutionReason: 'other' }] } })).rejects.toThrow(/needs a note/);
  });

  test('a failing step is reported and the rest still run', async () => {
    ticketServiceMock.addPrivateNote.mockRejectedValueOnce(new Error('storage down'));
    const result = await svc.apply(501, 1, 9, ACTOR);
    expect(result.ok).toBe(false);
    expect(result.steps.find((s) => s.type === 'note')).toEqual(expect.objectContaining({ ok: false, error: 'storage down' }));
    expect(result.steps.find((s) => s.type === 'status').ok).toBe(true);
  });
});

describe('apply on a FreshService-born ticket', () => {
  beforeEach(() => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 230001 }));
  });

  test('only what the app already writes back: FS-first fields, Ticket Pulse tags, note, reply; group/type/custom fields skipped', async () => {
    const result = await svc.apply(501, 1, 9, ACTOR);

    expect(ticketServiceMock.updateTicketFields).not.toHaveBeenCalled();
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalled();
    expect(ticketServiceMock.assignTicket).not.toHaveBeenCalled();
    const fsCalls = ticketServiceMock.updateFsTicket.mock.calls.map((c) => c[2]);
    expect(fsCalls[0]).toEqual(expect.objectContaining({ internalCategoryId: 10, internalSubcategoryId: 11, priority: 1 }));
    expect(fsCalls[0]).not.toHaveProperty('ticketType');
    expect(fsCalls[0]).not.toHaveProperty('internalGroupId');
    expect(fsCalls[0]).not.toHaveProperty('customFields');
    expect(fsCalls).toContainEqual({ assignedTechId: 42 });
    expect(fsCalls.at(-1)).toEqual({ status: 'Closed' });

    for (const type of ['group', 'type', 'custom_field']) {
      expect(result.steps.find((s) => s.type === type)).toEqual(expect.objectContaining({ skipped: true, reason: expect.stringMatching(/FreshService owns/) }));
    }
    // FreshService composes the subject: none is sent.
    const [, , reply] = ticketServiceMock.addReply.mock.calls[0];
    expect(reply.subject).toBeUndefined();
  });
});

describe('unattended requester (alert and integration senders)', () => {
  test('FS-born on the FreshService lane: the reply is not sent at all and the preview says why', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({
      origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 230002,
      requester: { name: 'Sentinel', email: 'sentinel@example.com', unattended: true },
    }));
    const preview = await svc.preview(501, 1, 9, ACTOR);
    const step = preview.steps.find((s) => s.type === 'reply');
    expect(step).toEqual(expect.objectContaining({ run: false, reason: UNATTENDED_REPLY_REASON }));

    const result = await svc.apply(501, 1, 9, ACTOR);
    expect(ticketServiceMock.addReply).not.toHaveBeenCalled();
    expect(result.steps.find((s) => s.type === 'reply')).toEqual(expect.objectContaining({ skipped: true, reason: UNATTENDED_REPLY_REASON }));
  });

  test('Ticket Pulse lane: the reply goes through the agent-reply path, whose guard sends nothing; preview and result say so', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({ requester: { name: 'Modelling Monitor', email: 'monitor@example.com', unattended: true } }));
    ticketServiceMock.addReply.mockResolvedValue({ email: { sent: false, skipped: 'unattended_requester' } });

    const preview = await svc.preview(501, 1, 9, ACTOR);
    expect(preview.steps.find((s) => s.type === 'reply').notice).toMatch(/nothing is sent/);

    const result = await svc.apply(501, 1, 9, ACTOR);
    expect(ticketServiceMock.addReply).toHaveBeenCalledTimes(1);
    expect(result.steps.find((s) => s.type === 'reply')).toEqual(expect.objectContaining({ ok: true, detail: expect.stringMatching(/not e-mailed/) }));
  });
});

describe('QA 11-05b #4: macros run in exactly the order the admin set', () => {
  const macro = (steps) => ({ id: 21, name: 'Close and thank', isActive: true, actions: { version: 2, steps } });
  const order = (fn, i = 0) => fn.mock.invocationCallOrder[i];

  test('a close placed BEFORE the reply runs first; the reply still goes out, and the preview says so', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue(macro([{ type: 'status', status: 'Closed' }, { type: 'reply', html: '<p>Thanks, {{requester.firstName}}</p>' }]));
    const preview = await svc.preview(501, 1, 21, ACTOR);
    expect(preview.steps.map((s) => s.type)).toEqual(['status', 'reply']);
    expect(preview.steps[1]).toEqual(expect.objectContaining({ run: true, notice: 'This reply runs after the ticket is set to Closed: it is still sent, and the ticket stays Closed.' }));
    const result = await svc.apply(501, 1, 21, ACTOR);
    expect(result.ok).toBe(true);
    expect(order(ticketServiceMock.changeStatus)).toBeLessThan(order(ticketServiceMock.addReply));
    expect(ticketServiceMock.addReply).toHaveBeenCalledWith(501, 1, { bodyHtml: '<p>Thanks, Alex</p>' }, ACTOR);
  });

  test('a reply on a ticket that is already closed says it is still sent; one after a reopen says nothing', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({ status: 'Closed' }));
    prismaMock.ticketMacro.findFirst.mockResolvedValue(macro([{ type: 'reply', html: '<p>Hi</p>' }, { type: 'status', status: 'Open' }, { type: 'reply', html: '<p>Again</p>' }]));
    const preview = await svc.preview(501, 1, 21, ACTOR);
    expect(preview.steps[0].notice).toBe('This ticket is Closed: the reply is still sent, and the ticket stays Closed.');
    expect(preview.steps[2].notice).toBeUndefined();
  });

  test('fields split by a note are two writes, in place; every status step runs in turn', async () => {
    prismaMock.ticketMacro.findFirst.mockResolvedValue(macro([
      { type: 'priority', priority: 3 },
      { type: 'status', status: 'Pending' },
      { type: 'note', html: '<p>Waiting on the vendor</p>' },
      { type: 'category', categoryId: 10, subcategoryId: 11 },
      // Category 10 is Security in these mocks: closing it needs a reason.
      { type: 'status', status: 'Closed', resolutionReason: 'no_action_required' },
    ]));
    const result = await svc.apply(501, 1, 21, ACTOR);
    expect(ticketServiceMock.updateTicketFields.mock.calls.map((c) => c[2])).toEqual([{ priority: 3 }, { internalCategoryId: 10, internalSubcategoryId: 11 }]);
    expect(ticketServiceMock.changeStatus.mock.calls.map((c) => c[2])).toEqual(['Pending', 'Closed']);
    const seq = [
      order(ticketServiceMock.updateTicketFields, 0), order(ticketServiceMock.changeStatus, 0), order(ticketServiceMock.addPrivateNote, 0),
      order(ticketServiceMock.updateTicketFields, 1), order(ticketServiceMock.changeStatus, 1),
    ];
    expect([...seq].sort((a, b) => a - b)).toEqual(seq);
    expect(result.steps.map((s) => [s.type, s.ok, Boolean(s.skipped)])).toEqual([
      ['priority', true, false], ['status', true, false], ['note', true, false], ['category', true, false], ['status', true, false],
    ]);
  });

  test('FS-born: a status step before the reply goes to FreshService first, then the reply', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(tpTicket({ origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 230001 }));
    prismaMock.ticketMacro.findFirst.mockResolvedValue(macro([{ type: 'status', status: 'Closed' }, { type: 'reply', html: '<p>Done</p>' }]));
    await svc.apply(501, 1, 21, ACTOR);
    expect(ticketServiceMock.updateFsTicket.mock.calls[0][2]).toEqual({ status: 'Closed' });
    expect(order(ticketServiceMock.updateFsTicket)).toBeLessThan(order(ticketServiceMock.addReply));
  });

  test('only the last of several assign steps runs (where it sits)', async () => {
    prismaMock.technician.findMany.mockResolvedValue([{ id: 4, name: 'Kim Lee' }, { id: 5, name: 'Robin Vale' }]);
    prismaMock.ticketMacro.findFirst.mockResolvedValue(macro([{ type: 'assign', to: 'technician', technicianId: 4 }, { type: 'note', html: '<p>x</p>' }, { type: 'assign', to: 'technician', technicianId: 5 }]));
    const result = await svc.apply(501, 1, 21, ACTOR);
    expect(ticketServiceMock.assignTicket.mock.calls.map((c) => c[2])).toEqual([5]);
    expect(order(ticketServiceMock.addPrivateNote)).toBeLessThan(order(ticketServiceMock.assignTicket));
    expect(result.steps[0]).toEqual(expect.objectContaining({ skipped: true, reason: 'A later assign step in this macro wins' }));
  });
});