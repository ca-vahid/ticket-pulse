import { jest } from '@jest/globals';

/**
 * 14 Oct 2026 (Vahid): the departure notice for Sam Okafor (#245000-ish, from the
 * Human Resources Team mailbox) showed Related 10: its own five children twice, and
 * under "Other tickets from this requester" the five children of Priya Nair's
 * departure, plus other people's departure notices "similar by content".
 */
const prismaMock = {
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn() },
  ticketLink: { findMany: jest.fn() },
};
const similarByContentMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => false) } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketEmbeddingService.js', () => ({
  default: { similarByContent: similarByContentMock },
}));

const { default: ticketService, BULK_REQUESTER_30D } = await import('../src/services/ticketService.js');

const HR = 280;
const PERSON = 77;
const THIS = 45123; // Sam Okafor's departure notice (FS-born parent)
const OWN_CHILDREN = [45124, 45125, 45126, 45127, 45128];
const ANNA_PARENT = 63083; // TP-1929
const ANNA_CHILDREN = [63084, 63085, 63086, 63087, 63088]; // TP-1930..1934
const row = (id, over = {}) => ({
  id, nativeNumber: null, freshserviceTicketId: BigInt(id + 200000), origin: 'freshservice',
  subject: `Ticket ${id}`, status: 'Open', createdAt: new Date('2026-10-13T12:00:00Z'), requesterId: HR, assignedTech: null, ...over,
});

function arrange({ requesterId = HR, count30 = 46, sameRequesterRows = [], similar = [], similarRows = [] }) {
  prismaMock.ticket.findFirst.mockResolvedValue({ id: THIS, requesterId, subject: 'Departure Notification: Sam Okafor from the Calgary office will be departing', createdAt: new Date('2026-09-15T21:30:52Z') });
  prismaMock.ticket.count.mockImplementation(async ({ where }) => (where.createdAt ? count30 : 1361));
  prismaMock.ticketLink.findMany.mockImplementation(async ({ where }) => {
    if (where.OR) return OWN_CHILDREN.map((c) => ({ ticketId: THIS, relatedTicketId: c }));
    const ids = where.relatedTicketId?.in || [];
    return [
      ...ANNA_CHILDREN.filter((c) => ids.includes(c)).map((c) => ({ ticketId: ANNA_PARENT, relatedTicketId: c })),
      ...OWN_CHILDREN.filter((c) => ids.includes(c)).map((c) => ({ ticketId: THIS, relatedTicketId: c })),
    ];
  });
  prismaMock.ticket.findMany.mockImplementation(async ({ where }) => {
    if (where.requesterId !== undefined) return sameRequesterRows;
    if (where.id?.in) return similarRows;
    return [];
  });
  similarByContentMock.mockResolvedValue(similar);
}

beforeEach(() => { jest.clearAllMocks(); });

describe('relatedTickets accuracy (14 Oct 2026)', () => {
  test('a high-volume sender is not listed ticket by ticket, and its own mail is not "similar"', async () => {
    arrange({
      similar: [{ ticketId: 245882, score: 0.86 }, { ticketId: 63083, score: 0.82 }, { ticketId: 50001, score: 0.8 }],
      similarRows: [row(245882), row(63083), row(50001, { requesterId: PERSON })],
    });
    const out = await ticketService.relatedTickets(THIS, 1);

    expect(out.requesterVolume).toEqual({ last30Days: 46 });
    expect(out.sameRequester).toEqual([]);
    expect(out.sameRequesterCount).toBe(1361);
    expect(out.similarByContent.map((t) => t.id)).toEqual([50001]);
    expect(out.similarByContent[0]).not.toHaveProperty('requesterId');
  });

  test("another ticket's children and this ticket's own family are never offered", async () => {
    arrange({
      requesterId: PERSON,
      count30: 3,
      sameRequesterRows: [...ANNA_CHILDREN.map((id) => row(id, { requesterId: PERSON })), row(50002, { requesterId: PERSON })],
      similar: [{ ticketId: OWN_CHILDREN[0], score: 0.95 }, { ticketId: ANNA_CHILDREN[0], score: 0.9 }, { ticketId: 50003, score: 0.78 }],
      similarRows: [row(OWN_CHILDREN[0]), row(ANNA_CHILDREN[0]), row(50003)],
    });
    const out = await ticketService.relatedTickets(THIS, 1);

    expect(out.requesterVolume).toBeNull();
    expect(out.sameRequester.map((t) => t.id)).toEqual([50002]);
    expect(out.similarByContent.map((t) => t.id)).toEqual([50003]);
  });

  test('the threshold is a real sender volume', () => {
    expect(BULK_REQUESTER_30D).toBe(20);
  });

  test('a weak wording match (under 70%) is not offered', async () => {
    arrange({
      requesterId: PERSON,
      count30: 3,
      similar: [{ ticketId: 50004, score: 0.71 }, { ticketId: 50005, score: 0.64 }],
      similarRows: [row(50004), row(50005)],
    });
    const out = await ticketService.relatedTickets(THIS, 1);
    expect(out.similarByContent.map((t) => t.id)).toEqual([50004]);
  });
});
