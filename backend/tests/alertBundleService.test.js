import { jest } from '@jest/globals';

/**
 * Alert bundles (17 Oct 2026): a burst of one check from a connected monitor
 * becomes one parent incident with each server's ticket under it; later
 * alerts of the check join it; children take the parent's owner; the parent
 * resolves when every child is done. Off by default.
 */
const store = new Map();
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), count: jest.fn() },
  ticketLink: { findMany: jest.fn(), count: jest.fn() },
  requester: { findUnique: jest.fn() },
  assignmentPipelineRun: { updateMany: jest.fn() },
  workspace: { findMany: jest.fn() },
};
const ticketServiceMock = {
  createTicket: jest.fn(),
  addPrivateNote: jest.fn(),
  assignTicket: jest.fn(),
  changeStatus: jest.fn(),
  updateTicketFields: jest.fn(),
};
const setParent = jest.fn();
const childrenOf = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => store.get(k) ?? null), set: jest.fn(async (k, v) => { store.set(k, v); }) },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({
  default: { statusNamesForBase: jest.fn(async (_ws, bases) => (bases.length === 1 && bases[0] === 'Resolved' ? ['Resolved'] : ['Resolved', 'Closed'])) },
}));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: ticketServiceMock }));
jest.unstable_mockModule('../src/services/ticketLinkService.js', () => ({ default: { setParent } }));
jest.unstable_mockModule('../src/services/ticketRollUpService.js', () => ({ childrenOf }));

const { default: service, checkOf, titleStem, ACTOR, BUNDLE_PREFIX } = await import('../src/services/alertBundleService.js');

const NOW = new Date('2026-10-17T14:00:00Z');
const alert = (id, host, minutesAgo, check = 'hw-storage') => ({
  id,
  subject: `[Infra] Storage / RAID hardware fault: ${host}`,
  customFields: { alert_fingerprint: `${check}|${host}` },
  priority: 2,
  groupId: 1000208184n,
  internalGroupId: null,
  createdAt: new Date(NOW.getTime() - minutesAgo * 60000),
});

beforeEach(() => {
  jest.clearAllMocks();
  store.clear();
  prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where.externalRef ? null : { id: where.id, requesterId: 3877 }));
  prismaMock.ticketLink.findMany.mockResolvedValue([]);
  prismaMock.requester.findUnique.mockResolvedValue({ email: 'sentinel@bgcengineering.ca', name: 'Microsoft Sentinel (monitoring)' });
  prismaMock.assignmentPipelineRun.updateMany.mockResolvedValue({ count: 1 });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  ticketServiceMock.createTicket.mockResolvedValue({ id: 900, nativeNumber: 10300, origin: 'ticketpulse', assignedTechId: null });
  ticketServiceMock.addPrivateNote.mockResolvedValue({ entry: { id: 1 } });
  setParent.mockResolvedValue({});
});

const on = (over = {}) => service.setSettings(1, { enabled: true, minCount: 3, windowMinutes: 60, ...over });

describe('the check an alert belongs to', () => {
  test('fingerprint, then alert id, then the title before the server name', () => {
    expect(checkOf({ fingerprintDisplay: 'hw-storage|BGC-VAN-HV52' })).toBe('hw-storage');
    expect(checkOf({ alertId: 'dc-timesource|BGC-BRI-DC1|2026-10-17T14:31' })).toBe('dc-timesource');
    expect(checkOf({ title: '[Infra] Hardware fault: BGC-VAN-HV41' })).toBe('[infra] hardware fault');
    expect(checkOf({ title: 'no server here' })).toBeNull();
    expect(titleStem('[Infra] Storage / RAID hardware fault: BGC-VAN-HV52')).toBe('[Infra] Storage / RAID hardware fault');
  });
});

describe('afterAlertCreated', () => {
  test('off by default: nothing is looked at', async () => {
    await service.setSettings(1, { enabled: false });
    expect((await service.afterAlertCreated(1, 50, { fingerprintDisplay: 'hw-storage|A' }, NOW)).action).toBe('off');
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('below the count: waits, no incident', async () => {
    await on();
    prismaMock.ticket.findMany.mockResolvedValue([alert(49, 'BGC-CAL-HV03', 40), alert(50, 'BGC-EDM-HV02', 0)]);
    const out = await service.afterAlertCreated(1, 50, { fingerprintDisplay: 'hw-storage|BGC-EDM-HV02' }, NOW);
    expect(out).toEqual({ action: 'waiting', count: 2 });
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
  });

  test('the third alert of a check in the hour opens one incident over all three; other checks and bundled tickets stay out', async () => {
    await on();
    prismaMock.ticket.findMany.mockResolvedValue([
      alert(48, 'BGC-CAL-HV03', 55),
      alert(47, 'BGC-VAN-DC2', 50, 'dc-timesource'),
      alert(49, 'BGC-EDM-HV02', 30),
      alert(46, 'BGC-KAM-HV02', 20),
      alert(50, 'BGC-EDM-HV03', 0),
    ]);
    prismaMock.ticketLink.findMany.mockResolvedValue([{ relatedTicketId: 46 }]); // already in another bundle
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => {
      if (where.id?.in) return where.id.in.map((id) => ({ id, nativeNumber: id, origin: 'ticketpulse', subject: `x: HOST${id}` }));
      return [alert(48, 'BGC-CAL-HV03', 55), alert(47, 'BGC-VAN-DC2', 50, 'dc-timesource'), alert(49, 'BGC-EDM-HV02', 30), alert(46, 'BGC-KAM-HV02', 20), alert(50, 'BGC-EDM-HV03', 0)];
    });
    const out = await service.afterAlertCreated(1, 50, { fingerprintDisplay: 'hw-storage|BGC-EDM-HV03' }, NOW);
    expect(out).toEqual({ action: 'created', parentId: 900, children: [48, 49, 50] });
    const [ws, input, actor, opts] = ticketServiceMock.createTicket.mock.calls[0];
    expect(ws).toBe(1);
    expect(input.subject).toBe('[Infra] Storage / RAID hardware fault — 3 servers');
    expect(input.externalRef.startsWith(`${BUNDLE_PREFIX}3877:hw-storage:`)).toBe(true);
    expect(input.requesterEmail).toBe('sentinel@bgcengineering.ca');
    expect(actor).toBe(ACTOR);
    expect(opts.sourceChannel).toBe(106);
    expect(setParent.mock.calls.map((c) => c[0])).toEqual([48, 49, 50]);
    expect(setParent).toHaveBeenCalledWith(48, 1, { parentTicketId: 900 }, ACTOR);
    expect(prismaMock.assignmentPipelineRun.updateMany).toHaveBeenCalledTimes(3);
    expect(ticketServiceMock.addPrivateNote).toHaveBeenCalledWith(900, 1, expect.objectContaining({ bodyText: expect.stringContaining('3 alerts bundled') }), ACTOR, [], { systemNote: true });
  });

  test('a later alert of the check joins the open incident and takes its owner', async () => {
    await on();
    prismaMock.ticketLink.count.mockResolvedValue(4);
    prismaMock.ticket.findFirst.mockImplementation(async ({ where }) => (where.externalRef
      ? { id: 900, nativeNumber: 10300, origin: 'ticketpulse', assignedTechId: 7, subject: 'x — 3 servers' }
      : { id: where.id, requesterId: 3877 }));
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in ? where.id.in.map((id) => ({ id, status: 'Open', assignedTechId: null, nativeNumber: id, origin: 'ticketpulse', subject: 'x: HOST' })) : []));
    const out = await service.afterAlertCreated(1, 60, { fingerprintDisplay: 'hw-storage|BGC-VAN-HV43' }, NOW);
    expect(out).toEqual({ action: 'joined', parentId: 900 });
    expect(ticketServiceMock.createTicket).not.toHaveBeenCalled();
    expect(setParent).toHaveBeenCalledWith(60, 1, { parentTicketId: 900 }, ACTOR);
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(60, 1, 7, ACTOR, { allowAssignableOnly: true });
    // the title keeps its count true, quietly
    expect(ticketServiceMock.updateTicketFields).toHaveBeenCalledWith(900, 1, { subject: 'x — 4 servers' }, ACTOR, { emitEvent: false });
  });

  test('a failure never reaches the alert call', async () => {
    await on();
    prismaMock.ticket.findFirst.mockRejectedValue(new Error('db down'));
    expect((await service.afterAlertCreated(1, 50, { fingerprintDisplay: 'hw-storage|A' }, NOW)).action).toBe('error');
  });
});

describe('bundleOpenBursts', () => {
  test("bursts already open are bundled: 17 Oct 2026's nine storage faults (three inside an hour) become one incident; two of another check do not", async () => {
    await on();
    const storage = [['BGC-CAL-HV03', 225], ['BGC-EDM-HV02', 165], ['BGC-EDM-HV03', 119], ['BGC-KAM-HV02', 105], ['BGC-VAN-HV43', 59], ['BGC-VAN-HV42', 59], ['BGC-VAN-HV41', 15], ['BGC-VAN-HV32', 0]]
      .map(([host, ago], i) => ({ ...alert(100 + i, host, ago), requesterId: 3877 }));
    const platform = [{ ...alert(200, 'BGC-VAN-HV41', 15, 'hw-platform'), requesterId: 3877 }, { ...alert(201, 'BGC-VAN-HV43', 0, 'hw-platform'), requesterId: 3877 }];
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where.id?.in
      ? where.id.in.map((id) => ({ id, nativeNumber: id, origin: 'ticketpulse', subject: `x: HOST${id}`, status: 'Open', assignedTechId: null }))
      : [...storage, ...platform].sort((a, b) => a.createdAt - b.createdAt)));
    const out = await service.bundleOpenBursts(1, NOW);
    expect(out).toEqual({ created: 1, joined: 0 });
    expect(ticketServiceMock.createTicket).toHaveBeenCalledTimes(1);
    expect(ticketServiceMock.createTicket.mock.calls[0][1].subject).toBe('[Infra] Storage / RAID hardware fault — 8 servers');
    expect(setParent.mock.calls.map((c) => c[0]).sort()).toEqual(storage.map((t) => t.id).sort());
    expect(prismaMock.ticket.findMany.mock.calls[0][0].where.source).toBe(106);
  });

  test('off: nothing is looked at', async () => {
    await service.setSettings(1, { enabled: false });
    expect(await service.bundleOpenBursts(1, NOW)).toEqual({ created: 0, joined: 0 });
    expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
  });
});

describe('tidy', () => {
  test('owners for unowned open children; an incident whose servers are all done is resolved with a note', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      { id: 900, nativeNumber: 10300, origin: 'ticketpulse', assignedTechId: 7 },
      { id: 901, nativeNumber: 10301, origin: 'ticketpulse', assignedTechId: null },
    ]);
    childrenOf.mockImplementation(async (id) => (id === 900
      ? [{ id: 1, status: 'Open', assignedTechId: null }, { id: 2, status: 'Resolved', assignedTechId: null }]
      : [{ id: 3, status: 'Resolved' }, { id: 4, status: 'Closed' }]));
    const out = await service.tidy(1);
    expect(out).toEqual({ owned: 1, resolved: 1 });
    expect(ticketServiceMock.assignTicket).toHaveBeenCalledWith(1, 1, 7, ACTOR, { allowAssignableOnly: true });
    expect(ticketServiceMock.changeStatus).toHaveBeenCalledWith(901, 1, 'Resolved', ACTOR);
    expect(ticketServiceMock.changeStatus).not.toHaveBeenCalledWith(900, expect.anything(), expect.anything(), expect.anything());
  });
});
