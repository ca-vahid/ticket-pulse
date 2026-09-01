import { jest } from '@jest/globals';

const prismaMock = {
  ticketThreadEntry: {
    findMany: jest.fn(),
    update: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  threadingHeadersForTicket, plusAddressReplyTo, buildOutboundMessageId, normalizeMessageId,
  domainOfAddress, storeEntryMessageId, DEFAULT_MESSAGE_ID_DOMAIN,
} = await import('../src/services/emailThreadingService.js');

// Mega 08-31 Phase MB-1b/1c/1h — threading anchors shared by every outbound lane.
describe('emailThreadingService.threadingHeadersForTicket', () => {
  beforeEach(() => jest.clearAllMocks());

  test('newest stored id is In-Reply-To; References lists the last ids oldest → newest', async () => {
    // findMany returns newest-first (that is the orderBy the helper asks for).
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { emailMessageId: '<c@graph>' },
      { emailMessageId: '<b@inbound>' },
      { emailMessageId: '<a@graph>' },
    ]);

    const headers = await threadingHeadersForTicket(501);

    expect(headers).toEqual({ inReplyTo: '<c@graph>', references: ['<a@graph>', '<b@inbound>', '<c@graph>'] });
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenCalledWith({
      where: { ticketId: 501, emailMessageId: { not: null } },
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: 10,
      select: { emailMessageId: true },
    });
  });

  test('normalizes bare ids to <...>, dedupes, and drops junk', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      { emailMessageId: 'x@y' },
      { emailMessageId: '<x@y>' },
      { emailMessageId: 'not-an-id' },
      { emailMessageId: null },
    ]);
    expect(await threadingHeadersForTicket(1)).toEqual({ inReplyTo: '<x@y>', references: ['<x@y>'] });
  });

  test('empty shape when nothing is stored, the id is bogus, or prisma throws (never fails the send)', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    expect(await threadingHeadersForTicket(9)).toEqual({ inReplyTo: null, references: [] });
    expect(await threadingHeadersForTicket(null)).toEqual({ inReplyTo: null, references: [] });
    prismaMock.ticketThreadEntry.findMany.mockRejectedValue(new Error('db down'));
    expect(await threadingHeadersForTicket(9)).toEqual({ inReplyTo: null, references: [] });
  });

  test('caps References at 10 (limit clamps 1..50)', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
    await threadingHeadersForTicket(1, { limit: 500 });
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 50 }));
    await threadingHeadersForTicket(1, { limit: 0 });
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenLastCalledWith(expect.objectContaining({ take: 10 }));
  });
});

describe('emailThreadingService.plusAddressReplyTo', () => {
  const tpTicket = { origin: 'ticketpulse', nativeNumber: 1234 };

  test('TP-born ticket → local+tp<n>@domain from the connected mailbox', () => {
    expect(plusAddressReplyTo('patickets@bgcengineering.ca', tpTicket)).toBe('patickets+tp1234@bgcengineering.ca');
    expect(plusAddressReplyTo('  PATickets@BGCEngineering.CA ', tpTicket)).toBe('patickets+tp1234@bgcengineering.ca');
  });

  test('never stacks plus tags when the mailbox itself carries one', () => {
    expect(plusAddressReplyTo('helpdesk+intake@x.com', tpTicket)).toBe('helpdesk+tp1234@x.com');
  });

  test('null for FS-born tickets, missing native number, or an unusable address', () => {
    expect(plusAddressReplyTo('patickets@x.com', { origin: 'freshservice', freshserviceTicketId: 225001, nativeNumber: null })).toBeNull();
    expect(plusAddressReplyTo('patickets@x.com', { origin: 'ticketpulse', nativeNumber: null })).toBeNull();
    expect(plusAddressReplyTo('patickets@x.com', null)).toBeNull();
    expect(plusAddressReplyTo('', tpTicket)).toBeNull();
    expect(plusAddressReplyTo('nodomain@', tpTicket)).toBeNull();
    expect(plusAddressReplyTo('@nolocal.com', tpTicket)).toBeNull();
  });
});

describe('emailThreadingService.buildOutboundMessageId', () => {
  test('mints <tp-<ticketId>-<random>@<domain>> and accepts a full address as the domain hint', () => {
    const mid = buildOutboundMessageId(501, 'bgcengineering.ca');
    expect(mid).toMatch(/^<tp-501-[a-z0-9]+\.[0-9a-f]{18}@bgcengineering\.ca>$/);
    expect(buildOutboundMessageId(7, 'ticketpulse@bgcengineering.ca')).toMatch(/@bgcengineering\.ca>$/);
    expect(buildOutboundMessageId(7, 'Weird Domain!.com')).toMatch(/@weirddomain\.com>$/);
  });

  test('falls back to the app domain and is unique per call', () => {
    expect(buildOutboundMessageId(3)).toMatch(new RegExp(`@${DEFAULT_MESSAGE_ID_DOMAIN.replace(/\\./g, '\\\\.')}>$`));
    expect(buildOutboundMessageId(null)).toMatch(/^<tp-x-/);
    expect(buildOutboundMessageId(3)).not.toBe(buildOutboundMessageId(3));
  });
});

describe('emailThreadingService misc helpers', () => {
  beforeEach(() => jest.clearAllMocks());

  test('normalizeMessageId / domainOfAddress', () => {
    expect(normalizeMessageId(' <abc@def> ')).toBe('<abc@def>');
    expect(normalizeMessageId('abc@def')).toBe('<abc@def>');
    expect(normalizeMessageId('<<abc@def>>')).toBe('<abc@def>');
    expect(normalizeMessageId('nope')).toBeNull();
    expect(normalizeMessageId(null)).toBeNull();
    expect(domainOfAddress('Ticket@BGC.ca')).toBe('bgc.ca');
    expect(domainOfAddress('bad')).toBeNull();
  });

  test('storeEntryMessageId writes the normalized id and swallows failures', async () => {
    prismaMock.ticketThreadEntry.update.mockResolvedValue({});
    expect(await storeEntryMessageId(9001, 'tp-1-x@bgc.ca')).toBe(true);
    expect(prismaMock.ticketThreadEntry.update).toHaveBeenCalledWith({ where: { id: 9001 }, data: { emailMessageId: '<tp-1-x@bgc.ca>' } });

    prismaMock.ticketThreadEntry.update.mockRejectedValue(new Error('gone'));
    expect(await storeEntryMessageId(9001, '<a@b>')).toBe(false);
    expect(await storeEntryMessageId(null, '<a@b>')).toBe(false);
    expect(await storeEntryMessageId(9001, '')).toBe(false);
  });
});
