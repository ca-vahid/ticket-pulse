import { jest } from '@jest/globals';

/**
 * Ticket grouping (plans/TICKET_GROUPING_PLAN.md): the same alert again while
 * its ticket is open is closed into that ticket and counted there; a person's
 * second ticket about one request is combined (sure + same person + still
 * open) or suggested; everything has an undo. Cases are the two that started
 * it: the Edmonton backup failure of 9-11 Oct 2026 and the laptop reported
 * taken on 29 Sep 2026 (#244717 by mail, #244718 by a Teams relay).
 */
const model = (...names) => Object.fromEntries(names.map((n) => [n, jest.fn()]));
const prismaMock = {
  ticket: model('findFirst', 'findMany', 'findUnique', 'count', 'update'),
  ticketGroupingEvent: model('findFirst', 'findMany', 'create', 'update'),
  ticketGroupingSender: model('findUnique', 'findFirst', 'findMany', 'create', 'update'),
  ticketLink: model('findMany', 'findFirst'),
  ticketThreadEntry: model('findFirst', 'findMany'),
  ticketActivity: model('findFirst'),
  assignmentPipelineRun: model('updateMany', 'create'),
  requester: model('findMany'),
  workspace: model('findMany'),
};
const settingsMock = { get: jest.fn(), set: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const rules = await import('../src/services/ticketGrouping/rules.js');
const { default: grouping, settingsKey } = await import('../src/services/ticketGrouping/groupingService.js');

const tickets = { addPrivateNote: jest.fn(), changeStatus: jest.fn(), updateFsTicket: jest.fn() };
const links = { link: jest.fn(), notDuplicate: jest.fn(), unlink: jest.fn() };
const gateway = { sendJson: jest.fn() };
const embeddings = { similarByContent: jest.fn() };
grouping._tickets = async () => tickets;
grouping._links = async () => links;
grouping._gateway = async () => gateway;
grouping._embeddings = async () => embeddings;

const RR = { id: 900, name: 'Rapidrecovery', email: 'rapidrecovery@bgcengineering.ca' };
const TYLER = { id: 1121, name: 'Tyler Southam', email: 'tsoutham@bgcengineering.ca' };
const TEAMS = { id: 490, name: 'Ryan Tang in Teams', email: 'no-reply@teams.mail.microsoft' };
const FILE3 = 'BGC-EDM-HV02 - Error: Transfer has failed for BGC-EDM-FILE3';
const at = (iso) => new Date(iso);
const ticket = (over = {}) => ({
  id: 1, workspaceId: 1, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 246525n, subject: FILE3, descriptionText: 'Transfer failed.',
  status: 'Open', createdAt: at('2026-10-09T23:00:00Z'), resolvedAt: null, closedAt: null, isNoise: false, triageMode: null, externalRef: null,
  requesterId: RR.id, assignedTechId: null, internalCategoryId: null, internalSubcategoryId: null, occurrenceCount: 0, lastOccurrenceAt: null,
  requester: RR, assignedTech: null, ...over,
});
const CARD = { id: 7, workspaceId: 1, sender: RR.email, template: rules.coarseTemplate(FILE3), kind: 'repeating', enabled: true };

beforeEach(() => {
  jest.clearAllMocks();
  for (const m of Object.values(prismaMock)) for (const fn of Object.values(m)) fn.mockReset();
  settingsMock.get.mockResolvedValue(JSON.stringify({ mode: 'on' }));
  prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue(null);
  prismaMock.ticketGroupingEvent.create.mockImplementation(async ({ data }) => ({ id: 55, ...data }));
  prismaMock.ticketGroupingEvent.update.mockImplementation(async ({ data }) => ({ id: 55, ...data }));
  prismaMock.ticketLink.findFirst.mockResolvedValue(null);
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketActivity.findFirst.mockResolvedValue(null);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.count.mockResolvedValue(200);
  prismaMock.ticketGroupingSender.findFirst.mockResolvedValue(null);
  prismaMock.ticketGroupingSender.update.mockResolvedValue({});
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.requester.findMany.mockResolvedValue([]);
  embeddings.similarByContent.mockResolvedValue([]);
});

describe('the key', () => {
  test('server names keep their digits; dates, clock times, long numbers and addresses do not', () => {
    expect(rules.fineKey(FILE3)).toBe('bgc-edm-hv02 - error: transfer has failed for bgc-edm-file3');
    expect(rules.fineKey('BGC-EDM-HV02 - Error: Transfer has failed for BGC-EDM-DC3')).not.toBe(rules.fineKey(FILE3));
    expect(rules.fineKey('RE: Fired:Sev3 Azure Monitor Alert VM Availability - pembina at 10/9/2026 2:20:11 PM'))
      .toBe(rules.fineKey('Fired:Sev3 Azure Monitor Alert VM Availability - pembina at 10/11/2026 9:05:40 AM'));
    expect(rules.fineKey('[10.2.4.148] - LIDAR1 backup failed')).toBe(rules.fineKey('[10.2.4.9] - LIDAR1 backup failed'));
    expect(rules.fineKey('Job 123456 failed on 12 Oct 2026')).toBe(rules.fineKey('Job 987654 failed on 3 Nov 2026'));
  });

  test('one sender card covers every server of a shape', () => {
    expect(rules.coarseTemplate(FILE3)).toBe(rules.coarseTemplate('BGC-KAM-HV01 - Error: Transfer has failed for BGC-KAM-FILE2'.replaceAll('KAM', 'EDM')));
    expect(rules.coarseTemplate(FILE3)).toBe('bgc-edm-hv# - error: transfer has failed for bgc-edm-file#');
  });

  test('a Teams relay names the person; ordinary mail does not', () => {
    expect(rules.relayedPerson('Tyler Southam sent a message', TEAMS.email)).toBe('Tyler Southam');
    expect(rules.relayedPerson('Tyler Southam sent a message', TYLER.email)).toBeNull();
    expect(rules.relayedPerson('Weekly report', TEAMS.email)).toBeNull();
    expect(rules.looksAutomated('no-reply@teams.mail.microsoft')).toBe(true);
    expect(rules.looksAutomated('tsoutham@bgcengineering.ca')).toBe(false);
  });
});

describe('what to do with a verdict', () => {
  const sure = { relation: 'same_request', confidence: 'high' };
  test('combined only when sure, the same person, and the older ticket is open', () => {
    expect(rules.decide(sure, { samePerson: true, candidateOpen: true })).toBe('combine');
    expect(rules.decide(sure, { samePerson: false, candidateOpen: true })).toBe('suggest');
    expect(rules.decide(sure, { samePerson: true, candidateOpen: false })).toBe('suggest');
    expect(rules.decide(sure, { samePerson: true, candidateOpen: true, peopleAuto: false })).toBe('suggest');
    expect(rules.decide({ relation: 'update', confidence: 'medium' }, { samePerson: true, candidateOpen: true })).toBe('suggest');
  });
  test('unsure or unrelated is left alone; related is only ever a suggestion', () => {
    expect(rules.decide({ relation: 'same_request', confidence: 'low' }, { samePerson: true, candidateOpen: true })).toBe('none');
    expect(rules.decide({ relation: 'unrelated', confidence: 'high' }, { samePerson: true, candidateOpen: true })).toBe('none');
    expect(rules.decide({ relation: 'related', confidence: 'high' }, { samePerson: true, candidateOpen: true })).toBe('suggest');
    expect(rules.decide({ relation: 'related', confidence: 'medium' }, {})).toBe('none');
    expect(rules.decide({ relation: 'nonsense', confidence: 'high' }, {})).toBe('none');
  });
  test('the strongest verdict wins', () => {
    const best = rules.bestMatch([{ candidate: 1, relation: 'related', confidence: 'high' }, { candidate: 2, relation: 'same_request', confidence: 'medium' }, { candidate: 3, relation: 'unrelated', confidence: 'high' }]);
    expect(best.candidate).toBe(2);
    expect(rules.bestMatch([{ candidate: 1, relation: 'unrelated', confidence: 'high' }])).toBeNull();
  });
  test('the open ticket gets a note at 2, 10, 25, 50, 100 and then every 100', () => {
    expect([2, 3, 10, 25, 50, 51, 100, 150, 200].filter(rules.noteAtCount)).toEqual([2, 10, 25, 50, 100, 200]);
  });
  test('settings default to off, and to combining for people once on', () => {
    expect(rules.normalizeSettings()).toEqual({ mode: 'off', peopleAuto: true });
    expect(rules.normalizeSettings({ mode: 'on', peopleAuto: false })).toEqual({ mode: 'on', peopleAuto: false });
    expect(rules.normalizeSettings({ mode: 'shadow' }).mode).toBe('off');
  });
});

describe('a repeat of an open alert', () => {
  const root = ticket({ id: 10, freshserviceTicketId: 246525n, internalCategoryId: 3, internalSubcategoryId: 31 });
  const repeat = ticket({ id: 11, freshserviceTicketId: 246530n, createdAt: at('2026-10-10T00:00:00Z') });

  test('off: nothing is read beyond the setting', async () => {
    settingsMock.get.mockResolvedValue(null);
    expect(await grouping.evaluateTicket(11, 1)).toBeNull();
    expect(settingsMock.get).toHaveBeenCalledWith(settingsKey(1));
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
  });

  test('a known repeating sender: closed into the open ticket, counted there, filed like it, no model call', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(repeat);
    prismaMock.ticket.findMany.mockResolvedValue([root]);
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue(CARD);
    const out = await grouping.evaluateTicket(11, 1);
    expect(out).toMatchObject({ handled: true, skipAi: true, kind: 'repeat', targetId: 10, targetRef: '#246525', count: 2 });
    expect(gateway.sendJson).not.toHaveBeenCalled();
    expect(links.link).toHaveBeenCalledWith(11, 1, { relatedTicketId: 10, kind: 'duplicate_of' }, expect.objectContaining({ role: 'system' }));
    expect(tickets.updateFsTicket).toHaveBeenCalledWith(11, 1, { status: 'Resolved' }, expect.anything());
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { isNoise: true, noiseRuleMatched: 'Grouped: repeat of #246525', internalCategoryId: 3, internalSubcategoryId: 31 } });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 10 }, data: expect.objectContaining({ occurrenceCount: 2, lastOccurrenceAt: repeat.createdAt }) });
    // The first repeat puts one note on the open ticket; the copy always gets its pointer.
    expect(tickets.addPrivateNote.mock.calls.map((c) => c[0])).toEqual([11, 10]);
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { ticketId: 11, status: 'queued' } }));
    expect(prismaMock.ticketGroupingEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ ticketId: 11, targetTicketId: 10, kind: 'repeat', state: 'applied', senderId: 7 }) });
  });

  test('the third repeat counts 4 and adds no note to the open ticket', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(repeat);
    prismaMock.ticket.findMany.mockResolvedValue([{ ...root, occurrenceCount: 3 }]);
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue(CARD);
    expect((await grouping.evaluateTicket(11, 1)).count).toBe(4);
    expect(tickets.addPrivateNote.mock.calls.map((c) => c[0])).toEqual([11]);
  });

  test('a different server is not a repeat (FILE3 is open, DC3 arrives)', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ticket({ id: 12, subject: 'BGC-EDM-HV02 - Error: Transfer has failed for BGC-EDM-DC3', createdAt: at('2026-10-10T00:00:05Z') }));
    prismaMock.ticket.findMany.mockResolvedValue([root]);
    expect(await grouping.evaluateTicket(12, 1, { machineOnly: true })).toBeNull();
    expect(links.link).not.toHaveBeenCalled();
  });

  test('a new sender is asked about once: the model says repeating, the card is kept, the repeat is closed', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(repeat);
    prismaMock.ticket.findMany.mockImplementation(async ({ select }) => (select?.descriptionText ? [root] : [{ subject: FILE3 }]));
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue(null);
    prismaMock.ticketGroupingSender.create.mockImplementation(async ({ data }) => ({ id: 8, enabled: true, ...data }));
    gateway.sendJson.mockResolvedValue({ parsed: { kind: 'repeating', reason: 'A backup system reporting the same failed transfer.' } });
    const out = await grouping.evaluateTicket(11, 1);
    expect(gateway.sendJson).toHaveBeenCalledTimes(1);
    expect(gateway.sendJson.mock.calls[0][0]).toMatchObject({ operation: 'ticket_grouping', workspaceId: 1 });
    expect(prismaMock.ticketGroupingSender.create).toHaveBeenCalledWith({ data: expect.objectContaining({ sender: RR.email, template: CARD.template, kind: 'repeating', decidedBy: 'ai' }) });
    expect(out).toMatchObject({ handled: true, kind: 'repeat' });
  });

  test('"every mail is its own item" (invoices) is never closed, and a person is never a repeating sender', async () => {
    const invoice = ticket({ id: 21, subject: 'New Invoice from Instacart Business', requester: { id: 5, name: 'Balance', email: 'noreply@getbalance.com' }, requesterId: 5, createdAt: at('2026-10-10T00:00:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(invoice);
    prismaMock.ticket.findMany.mockImplementation(async ({ select }) => (select?.descriptionText ? [{ ...invoice, id: 20, createdAt: at('2026-10-09T00:00:00Z') }] : []));
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue({ ...CARD, kind: 'distinct' });
    expect(await grouping.evaluateTicket(21, 1, { machineOnly: true })).toBeNull();
    expect(tickets.updateFsTicket).not.toHaveBeenCalled();

    // The model calls a person "repeating": stored as unsure, nothing closed.
    const person = ticket({ id: 31, subject: 'Serial Number Request', requester: TYLER, requesterId: TYLER.id, createdAt: at('2026-10-10T00:04:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(person);
    prismaMock.ticket.findMany.mockImplementation(async ({ select }) => (select?.descriptionText ? [{ ...person, id: 30, createdAt: at('2026-10-10T00:00:00Z') }] : []));
    prismaMock.ticket.count.mockResolvedValue(4);
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue(null);
    prismaMock.ticketGroupingSender.create.mockImplementation(async ({ data }) => ({ id: 9, enabled: true, ...data }));
    gateway.sendJson.mockResolvedValue({ parsed: { kind: 'repeating', reason: 'x' } });
    expect(await grouping.evaluateTicket(31, 1, { machineOnly: true })).toBeNull();
    expect(prismaMock.ticketGroupingSender.create.mock.calls[0][0].data.kind).toBe('unsure');
  });

  test('left alone: a sender an admin switched off, a ticket a person worked, trusted intake, an API alert, a family child', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([root]);
    prismaMock.ticket.findFirst.mockResolvedValue(repeat);
    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue({ ...CARD, enabled: false });
    expect(await grouping.evaluateTicket(11, 1, { machineOnly: true })).toBeNull();

    prismaMock.ticketGroupingSender.findUnique.mockResolvedValue(CARD);
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue({ id: 1 });
    expect(await grouping.evaluateTicket(11, 1, { machineOnly: true })).toBeNull();
    prismaMock.ticketThreadEntry.findFirst.mockResolvedValue(null);

    for (const over of [{ triageMode: 'trusted' }, { externalRef: 'sentinel:x' }, { status: 'Closed' }, { isNoise: true }, { requesterId: null }]) {
      prismaMock.ticket.findFirst.mockResolvedValue({ ...repeat, ...over });
      expect(await grouping.evaluateTicket(11, 1, { machineOnly: true })).toBeNull();
    }
    prismaMock.ticket.findFirst.mockResolvedValue(repeat);
    prismaMock.ticketLink.findFirst.mockResolvedValue({ id: 4 });
    expect(await grouping.evaluateTicket(11, 1, { machineOnly: true })).toBeNull();
    expect(links.link).not.toHaveBeenCalled();
  });

  test('a ticket the sweep already closed tells the pipeline to skip the AI without a second record', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ id: 3, state: 'applied', kind: 'repeat', targetTicketId: 10 });
    expect(await grouping.evaluateTicket(11, 1)).toEqual({ handled: true, skipAi: true, already: true, kind: 'repeat', eventId: 3, targetId: 10 });
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ id: 3, state: 'suggested', kind: 'duplicate', targetTicketId: 10 });
    expect(await grouping.evaluateTicket(11, 1)).toBeNull();
  });
});

describe('the same request from a person', () => {
  const first = ticket({ id: 60892, freshserviceTicketId: 244717n, subject: 'Disable or locate computer', descriptionText: 'Can you lock my laptop it seems someone walked away with my computer.', requester: TYLER, requesterId: TYLER.id, createdAt: at('2026-09-30T02:59:00Z') });
  const relay = ticket({ id: 60893, freshserviceTicketId: 244718n, subject: 'Tyler Southam sent a message', descriptionText: 'Tyler Southam sent a message in chat. Can you lock my laptop...', requester: TEAMS, requesterId: TEAMS.id, createdAt: at('2026-09-30T03:54:00Z') });
  const judge = (matches, retraction = false) => gateway.sendJson.mockResolvedValue({ parsed: { matches, retraction } });

  test('the Teams copy of the laptop report is combined into the mail ticket, and the keeper is told why', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(relay);
    prismaMock.requester.findMany.mockResolvedValue([{ id: TYLER.id }]);
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.requesterId?.in ? [first] : []));
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ ticketId: 60892, bodyText: 'The backpack and computer turned up. Please disregard the last email.', occurredAt: at('2026-09-30T03:06:00Z') }]);
    judge([{ candidate: 1, relation: 'same_request', confidence: 'high', reason: 'Both ask IT to lock the same laptop taken at the same event.' }], false);
    const out = await grouping.evaluateTicket(60893, 1);
    expect(out).toMatchObject({ handled: true, skipAi: true, kind: 'duplicate', targetId: 60892, targetRef: '#244717' });
    // The model saw the requester's later "turned up" message on the first ticket.
    expect(gateway.sendJson.mock.calls[0][0].userMessage).toContain('Requester later wrote: The backpack and computer turned up');
    expect(gateway.sendJson.mock.calls[0][0].userMessage).toContain('relaying a chat message from: Tyler Southam');
    expect(tickets.addPrivateNote.mock.calls[0][0]).toBe(60892);
    expect(tickets.addPrivateNote.mock.calls[0][2].bodyText).toContain('combined #244718');
    expect(tickets.updateFsTicket).toHaveBeenCalledWith(60893, 1, { status: 'Resolved' }, expect.anything());
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 60893 }, data: expect.objectContaining({ isNoise: true, noiseRuleMatched: 'Grouped: same request as #244717' }) });
    expect(prismaMock.ticketGroupingEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'duplicate', state: 'applied', details: expect.objectContaining({ via: 'relay', samePerson: true, relay: 'Tyler Southam' }) }) });
  });

  test('a "never mind" follow-up is combined and the keeper says the requester no longer needs it', async () => {
    const followUp = ticket({ id: 70, freshserviceTicketId: 244800n, subject: 'Laptop found', descriptionText: 'It turned up, please disregard.', requester: TYLER, requesterId: TYLER.id, createdAt: at('2026-09-30T04:00:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(followUp);
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.requesterId === TYLER.id && !where.status?.notIn?.includes('Resolved') ? [first] : []));
    judge([{ candidate: 1, relation: 'update', confidence: 'high', reason: 'Says the laptop from the earlier ticket was found.' }], true);
    const out = await grouping.evaluateTicket(70, 1);
    expect(out).toMatchObject({ handled: true, kind: 'update', retraction: true });
    expect(tickets.addPrivateNote.mock.calls[0][2].bodyText).toMatch(/^The requester says this is no longer needed\./);
  });

  test('another person, a lower confidence, or "only suggest": a suggestion, the ticket goes on to triage', async () => {
    const other = ticket({ id: 80, subject: 'VPN is down', descriptionText: 'VPN down in Calgary', requester: TYLER, requesterId: TYLER.id, createdAt: at('2026-10-10T16:00:00Z') });
    const theirs = ticket({ id: 79, freshserviceTicketId: 1n, subject: 'Cannot connect to VPN', requester: { id: 2, name: 'Mo', email: 'mo@bgcengineering.ca' }, requesterId: 2, createdAt: at('2026-10-10T15:50:00Z') });
    prismaMock.ticket.findFirst.mockResolvedValue(other);
    embeddings.similarByContent.mockResolvedValue([{ ticketId: 79, score: 0.9 }]);
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in ? [theirs] : []));
    judge([{ candidate: 1, relation: 'same_request', confidence: 'high', reason: 'Same outage.' }]);
    expect(await grouping.evaluateTicket(80, 1)).toBeNull();
    expect(prismaMock.ticketGroupingEvent.create).toHaveBeenCalledWith({ data: expect.objectContaining({ kind: 'duplicate', state: 'suggested', targetTicketId: 79 }) });
    expect(tickets.updateFsTicket).not.toHaveBeenCalled();

    settingsMock.get.mockResolvedValue(JSON.stringify({ mode: 'on', peopleAuto: false }));
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.requesterId === TYLER.id ? [{ ...theirs, requester: TYLER, requesterId: TYLER.id }] : []));
    embeddings.similarByContent.mockResolvedValue([]);
    prismaMock.ticketGroupingEvent.create.mockClear();
    expect(await grouping.evaluateTicket(80, 1)).toBeNull();
    expect(prismaMock.ticketGroupingEvent.create.mock.calls[0][0].data.state).toBe('suggested');
  });

  test('no candidates: no model call, marked as looked at; unrelated: marked too', async () => {
    const lone = ticket({ id: 90, subject: 'New monitor please', requester: TYLER, requesterId: TYLER.id });
    prismaMock.ticket.findFirst.mockResolvedValue(lone);
    expect(await grouping.evaluateTicket(90, 1)).toBeNull();
    expect(gateway.sendJson).not.toHaveBeenCalled();
    expect(prismaMock.ticketGroupingEvent.create).toHaveBeenCalledWith({ data: { workspaceId: 1, ticketId: 90, kind: 'checked', state: 'none' } });

    prismaMock.ticketGroupingEvent.create.mockClear();
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.requesterId === TYLER.id ? [first] : []));
    judge([{ candidate: 1, relation: 'unrelated', confidence: 'high', reason: 'Different requests.' }]);
    expect(await grouping.evaluateTicket(90, 1)).toBeNull();
    expect(prismaMock.ticketGroupingEvent.create.mock.calls[0][0].data.kind).toBe('checked');
  });

  test('a failed model call does nothing and leaves no mark, so the sweep tries again; robots are not judged', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue(ticket({ id: 91, subject: 'New monitor please', requester: TYLER, requesterId: TYLER.id }));
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.requesterId === TYLER.id ? [first] : []));
    gateway.sendJson.mockRejectedValue(new Error('overloaded'));
    expect(await grouping.evaluateTicket(91, 1)).toBeNull();
    expect(prismaMock.ticketGroupingEvent.create).not.toHaveBeenCalled();

    gateway.sendJson.mockClear();
    prismaMock.ticket.findFirst.mockResolvedValue(ticket({ id: 92, subject: 'Your weekly digest', requester: { id: 3, name: 'X', email: 'noreply@vendor.com' }, requesterId: 3 }));
    expect(await grouping.evaluateTicket(92, 1)).toBeNull();
    expect(gateway.sendJson).not.toHaveBeenCalled();
  });
});

describe('review', () => {
  const applied = { id: 55, workspaceId: 1, ticketId: 11, targetTicketId: 10, kind: 'repeat', state: 'applied' };
  const actor = { email: 'vhaeri@bgcengineering.ca', name: 'Vahid' };

  test('undo: the link goes, the FreshService copy reopens, it counts again, the open ticket loses one', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue(applied);
    prismaMock.ticket.findFirst.mockResolvedValue(ticket({ id: 11, status: 'Resolved', isNoise: true }));
    prismaMock.ticket.findUnique.mockResolvedValue({ occurrenceCount: 5 });
    const out = await grouping.undo(55, 1, actor);
    expect(out.changed).toBe(true);
    expect(links.notDuplicate).toHaveBeenCalledWith(11, 1, actor);
    expect(tickets.updateFsTicket).toHaveBeenCalledWith(11, 1, { status: 'Open' }, actor);
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 11 }, data: { isNoise: false, noiseRuleMatched: null } });
    expect(prismaMock.ticket.update).toHaveBeenCalledWith({ where: { id: 10 }, data: { occurrenceCount: 4 } });
    expect(prismaMock.ticketGroupingEvent.update).toHaveBeenCalledWith({ where: { id: 55 }, data: expect.objectContaining({ state: 'undone', decidedBy: actor.email }) });
  });

  test('undo twice, or of a suggestion, changes nothing; an unknown entry is a 404', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ ...applied, state: 'undone' });
    expect((await grouping.undo(55, 1, actor)).changed).toBe(false);
    expect(links.notDuplicate).not.toHaveBeenCalled();
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue(null);
    await expect(grouping.undo(99, 1, actor)).rejects.toMatchObject({ statusCode: 404 });
  });

  test('accepting a suggestion combines the two; "not related" only records the answer', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ ...applied, kind: 'duplicate', state: 'suggested', reason: 'Same outage.', retraction: false });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => ticket({ id: where.id, freshserviceTicketId: BigInt(where.id) }));
    expect((await grouping.accept(55, 1, actor)).changed).toBe(true);
    expect(links.link).toHaveBeenCalledWith(11, 1, { relatedTicketId: 10, kind: 'duplicate_of' }, expect.anything());
    expect(tickets.updateFsTicket).toHaveBeenCalledWith(11, 1, { status: 'Resolved' }, expect.anything());
    expect(prismaMock.ticketGroupingEvent.update.mock.calls[0][0].data).toMatchObject({ state: 'applied', decidedBy: actor.email });

    jest.clearAllMocks();
    expect((await grouping.dismiss(55, 1, actor)).changed).toBe(true);
    expect(links.link).not.toHaveBeenCalled();
    expect(prismaMock.ticketGroupingEvent.update.mock.calls[0][0].data.state).toBe('dismissed');
  });

  test('a related suggestion becomes a plain link: nothing is closed', async () => {
    prismaMock.ticketGroupingEvent.findFirst.mockResolvedValue({ ...applied, kind: 'related', state: 'suggested' });
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => ticket({ id: where.id }));
    await grouping.accept(55, 1, actor);
    expect(links.link).toHaveBeenCalledWith(11, 1, { relatedTicketId: 10, kind: 'related_to' }, actor);
    expect(tickets.updateFsTicket).not.toHaveBeenCalled();
  });

  test('the page: repeats are folded into one line per open ticket; suggestions and combined pairs are listed', async () => {
    const e = (id, over) => ({ id, workspaceId: 1, ticketId: 100 + id, targetTicketId: 10, kind: 'repeat', state: 'applied', confidence: 'high', retraction: false, reason: 'r', details: null, createdAt: at(`2026-10-1${id}T00:00:00Z`), decidedAt: null, decidedBy: null, ...over });
    prismaMock.ticketGroupingEvent.findMany.mockResolvedValue([e(1), e(2), e(3, { kind: 'duplicate', state: 'suggested', targetTicketId: 20 }), e(4, { kind: 'update', targetTicketId: 20, retraction: true })]);
    prismaMock.ticketGroupingSender.findMany.mockResolvedValue([{ ...CARD, decidedBy: 'ai', reason: 'x', sampleSubject: FILE3, repeatCount: 2, lastRepeatAt: null }]);
    prismaMock.ticket.findMany.mockResolvedValue([10, 20, 101, 102, 103, 104].map((id) => ticket({ id, freshserviceTicketId: BigInt(id), occurrenceCount: id === 10 ? 3 : 0 })));
    const page = await grouping.overview(1, { days: 14 });
    expect(page.settings).toEqual({ mode: 'on', peopleAuto: true });
    expect(page.repeats).toHaveLength(1);
    expect(page.repeats[0]).toMatchObject({ count: 2, target: { ref: '#10', occurrenceCount: 3 } });
    expect(page.waiting.map((x) => x.id)).toEqual([3]);
    expect(page.combined.map((x) => [x.id, x.retraction])).toEqual([[4, true]]);
    expect(page.senders[0]).toMatchObject({ sender: RR.email, kind: 'repeating', enabled: true });
  });

  test('an admin changes what a sender is; the change is signed', async () => {
    prismaMock.ticketGroupingSender.findFirst.mockResolvedValue(CARD);
    prismaMock.ticketGroupingSender.update.mockImplementation(async ({ data }) => ({ ...CARD, ...data }));
    const row = await grouping.updateSender(7, 1, { kind: 'distinct', enabled: false, nonsense: 1 }, actor);
    expect(prismaMock.ticketGroupingSender.update).toHaveBeenCalledWith({ where: { id: 7 }, data: { kind: 'distinct', enabled: false, decidedBy: actor.email } });
    expect(row.kind).toBe('distinct');
  });

  test('the morning mail: counts per open ticket, pairs, and what waits; nothing to say is null', async () => {
    const win = { since: at('2026-10-11T15:00:00Z'), until: at('2026-10-12T15:00:00Z') };
    prismaMock.ticketGroupingEvent.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    expect(await grouping.digest(1, win)).toBeNull();
    const ev = (id, over) => ({ id, ticketId: 100 + id, targetTicketId: 10, kind: 'repeat', state: 'applied', reason: 'r', retraction: false, ...over });
    prismaMock.ticketGroupingEvent.findMany.mockResolvedValueOnce([ev(1), ev(2), ev(3, { kind: 'duplicate', targetTicketId: 20 })]).mockResolvedValueOnce([ev(4, { kind: 'duplicate', state: 'suggested', targetTicketId: 20 })]);
    prismaMock.ticket.findMany.mockResolvedValue([10, 20, 101, 102, 103, 104].map((id) => ticket({ id, freshserviceTicketId: BigInt(id) })));
    const d = await grouping.digest(1, win);
    expect(d).toMatchObject({ repeatTotal: 2, repeats: [{ ref: '#10', count: 2 }] });
    expect(d.combined).toHaveLength(1);
    expect(d.waiting).toHaveLength(1);
  });
});

describe('the sweep', () => {
  test('looks only at open tickets with no entry yet, oldest first, and records a run for what it groups', async () => {
    prismaMock.workspace.findMany.mockResolvedValue([{ id: 1 }, { id: 2 }]);
    settingsMock.get.mockImplementation(async (key) => (key === settingsKey(1) ? JSON.stringify({ mode: 'on' }) : null));
    const now = at('2026-10-12T04:00:00Z');
    prismaMock.ticket.findMany.mockResolvedValueOnce([{ id: 11, createdAt: at('2026-10-10T00:00:00Z') }, { id: 12, createdAt: at('2026-10-12T03:00:00Z') }]);
    prismaMock.ticketGroupingEvent.findMany.mockResolvedValue([{ ticketId: 12 }]);
    const spy = jest.spyOn(grouping, 'evaluateTicket').mockResolvedValue({ handled: true, skipAi: true, kind: 'repeat', targetId: 10, targetRef: '#246525', reason: 'x' });
    prismaMock.assignmentPipelineRun.create.mockResolvedValue({ id: 1 });
    const out = await grouping.sweep(now);
    expect(out).toEqual({ workspaces: 1, looked: 1, handled: 1 });
    expect(spy).toHaveBeenCalledWith(11, 1, { machineOnly: true });
    expect(prismaMock.assignmentPipelineRun.create.mock.calls[0][0].data).toMatchObject({ ticketId: 11, decision: 'duplicate_dismissed', triggerSource: 'grouping_sweep', llmModel: 'ticket-grouping' });
    spy.mockRestore();
  });
});
