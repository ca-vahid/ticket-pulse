import { jest } from '@jest/globals';

/**
 * Autofill v2 (AF2) — ticketIntakeRunService: run persistence, link-time
 * validation and the `applied` comparison that makes the AI Usage list
 * meaningful. Prisma is mocked; the query shapes are probed live by
 * scripts/qa-0902-intake-probe.mjs.
 */

const prismaMock = {
  ticketIntakeRun: { create: jest.fn(), findFirst: jest.fn(), update: jest.fn(), findMany: jest.fn() },
};
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: service, computeApplied } = await import('../src/services/ticketIntakeRunService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const DATA = {
  subject: 'ChatGPT account for Simon',
  requesterNameOrEmail: 'Simon Dickinson',
  requesterMatch: { status: 'matched', candidate: { requesterId: 99, email: 'sdickinson@example.com', name: 'Simon Dickinson', source: 'requester' }, candidates: [], reason: 'r' },
  assigneeHint: { name: 'Soheil', reason: 'x' },
  assigneeMatch: { status: 'matched', technician: { id: 12, name: 'Soheil Nasiri', email: 's@example.com' }, candidates: [], reason: 'r' },
  conversingAgent: { name: 'Vahid Haeri', technicianId: 4, email: 'v@example.com' },
  categoryHint: 'Procurement & Licensing > AI / SaaS Licensing',
  categoryLevel: 'leaf',
  priorityHint: 2,
  typeHint: 'Service Request',
  sourceSummary: 'Teams chat screenshot',
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketIntakeRun.create.mockResolvedValue({ id: 41 });
});

describe('record', () => {
  test('stores the proposal, the resolver outcome and a request summary WITHOUT image bytes', async () => {
    const buffer = Buffer.alloc(1234, 1);
    const id = await service.record({
      workspaceId: 1,
      actor: { email: 'Vahid@Example.com', name: 'Vahid Haeri' },
      text: 'x'.repeat(900),
      images: [{ mimeType: 'image/png', buffer, fileName: 'teams.png' }],
      data: DATA,
      meta: { provider: 'anthropic', model: 'claude-sonnet-5', imageCount: 1, textChars: 900, durationMs: 4321.6, inputTokens: 2000, outputTokens: 400 },
    });
    expect(id).toBe(41);
    const arg = prismaMock.ticketIntakeRun.create.mock.calls[0][0];
    expect(arg.data).toMatchObject({
      workspaceId: 1,
      actorEmail: 'vahid@example.com',
      actorName: 'Vahid Haeri',
      textChars: 900,
      imageCount: 1,
      provider: 'anthropic',
      model: 'claude-sonnet-5',
      durationMs: 4322,
      inputTokens: 2000,
      outputTokens: 400,
      result: DATA,
      resolved: { requesterMatch: DATA.requesterMatch, assigneeMatch: DATA.assigneeMatch, conversingAgent: DATA.conversingAgent, categoryLevel: 'leaf' },
    });
    expect(arg.data.requestSummary).toEqual({
      sourceSummary: 'Teams chat screenshot',
      textPreview: 'x'.repeat(500),
      images: [{ name: 'teams.png', size: 1234, type: 'image/png' }],
    });
    expect(JSON.stringify(arg.data)).not.toContain(buffer.toString('base64').slice(0, 20));
  });

  test('a persistence failure is non-fatal → null', async () => {
    prismaMock.ticketIntakeRun.create.mockRejectedValue(new Error('relation does not exist'));
    expect(await service.record({ workspaceId: 1, data: DATA, meta: {} })).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringMatching(/not recorded/));
  });
});

describe('assertLinkable', () => {
  test('rejects bad ids, foreign-workspace runs and already-linked runs', async () => {
    await expect(service.assertLinkable('abc', 1)).rejects.toThrow(ValidationError);
    await expect(service.assertLinkable(0, 1)).rejects.toThrow(/positive integer/);
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue(null);
    await expect(service.assertLinkable(41, 1)).rejects.toThrow(/Unknown intakeRunId/);
    expect(prismaMock.ticketIntakeRun.findFirst).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 41, workspaceId: 1 } }));
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue({ id: 41, ticketId: 500, result: {}, resolved: {} });
    await expect(service.assertLinkable('41', 1)).rejects.toThrow(/already linked to ticket 500/);
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue({ id: 41, ticketId: null, result: {}, resolved: {} });
    await expect(service.assertLinkable('41', 1)).resolves.toMatchObject({ id: 41 });
  });
});

describe('computeApplied', () => {
  const TICKET = {
    id: 900,
    subject: 'ChatGPT account for Simon',
    priority: 2,
    ticketType: 'service request',
    assignedTechId: 12,
    requester: { id: 99, email: 'SDickinson@example.com' },
    internalCategory: { name: 'Procurement & Licensing' },
    internalSubcategory: { name: 'AI / SaaS Licensing' },
  };

  test('everything kept → all true', () => {
    expect(computeApplied(DATA, TICKET)).toEqual({ subject: true, requester: true, category: true, priority: true, type: true, assignee: true });
  });

  test('changed fields → false; fields the run did not propose → null', () => {
    const ticket = { ...TICKET, subject: 'Other', priority: 3, assignedTechId: null, requester: { email: 'x@example.com' }, internalSubcategory: null };
    expect(computeApplied(DATA, ticket)).toEqual({ subject: false, requester: false, category: false, priority: false, type: true, assignee: false });
    expect(computeApplied({ subject: '', requesterNameOrEmail: null, categoryHint: null, priorityHint: null, typeHint: null }, TICKET))
      .toEqual({ subject: null, requester: null, category: null, priority: null, type: null, assignee: null });
    // An unresolved email hint still compares by address.
    expect(computeApplied({ requesterNameOrEmail: 'sdickinson@example.com' }, TICKET).requester).toBe(true);
  });
});

describe('linkToTicket', () => {
  test('links the run, stamps applied + linkedAt on resolved (merging what was there)', async () => {
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue({ id: 41, ticketId: null, result: DATA, resolved: { categoryLevel: 'leaf' } });
    prismaMock.ticketIntakeRun.update.mockImplementation(async ({ data }) => ({ id: 41, ticketId: data.ticketId, resolved: data.resolved }));
    const out = await service.linkToTicket(41, 1, {
      id: 900, subject: 'ChatGPT account for Simon', priority: 2, ticketType: 'Service Request', assignedTechId: 7,
      requester: { email: 'sdickinson@example.com' }, internalCategory: { name: 'Procurement & Licensing' }, internalSubcategory: { name: 'AI / SaaS Licensing' },
    });
    expect(prismaMock.ticketIntakeRun.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 41 } }));
    expect(out.ticketId).toBe(900);
    expect(out.resolved.categoryLevel).toBe('leaf');
    expect(out.resolved.applied).toEqual({ subject: true, requester: true, category: true, priority: true, type: true, assignee: false });
    expect(typeof out.resolved.linkedAt).toBe('string');
  });

  test('is non-fatal', async () => {
    prismaMock.ticketIntakeRun.findFirst.mockResolvedValue(null);
    expect(await service.linkToTicket(41, 1, { id: 900 })).toBeNull();
    expect(loggerMock.warn).toHaveBeenCalledWith(expect.stringMatching(/not linked/));
  });
});

describe('listing', () => {
  test('listForTicket / listRecent shape the rows and clamp the limit', async () => {
    const row = {
      id: 41, workspaceId: 1, ticketId: 900, actorEmail: 'v@example.com', actorName: 'V', textChars: 0, imageCount: 1,
      provider: 'anthropic', model: 'm', durationMs: 10, inputTokens: 1, outputTokens: 2,
      requestSummary: { sourceSummary: 's' }, result: DATA, resolved: { applied: {} }, createdAt: new Date('2026-09-02T00:00:00Z'),
      ticket: { id: 900, nativeNumber: 12, subject: 'S' },
    };
    prismaMock.ticketIntakeRun.findMany.mockResolvedValue([row]);
    const forTicket = await service.listForTicket(900, 1);
    expect(prismaMock.ticketIntakeRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { ticketId: 900, workspaceId: 1 } }));
    expect(forTicket[0]).toMatchObject({ id: 41, ticketId: 900, result: DATA, ticket: { id: 900, nativeNumber: 12, subject: 'S' } });

    await service.listRecent(1, 9999);
    expect(prismaMock.ticketIntakeRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { workspaceId: 1 }, take: 200 }));
    await service.listRecent(1, 'nope');
    expect(prismaMock.ticketIntakeRun.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 50 }));
  });
});
