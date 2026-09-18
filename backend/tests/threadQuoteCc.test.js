import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * Vahid, 18 Sep 2026: "the original request, if they've cc'ed multiple people it
 * should also list those as well. like a cc line or something."
 *
 * The quoted header gets a "Cc:" line — people only. The sender, our own
 * mailboxes (and their +tags) and the FreshService relay address are plumbing.
 */

const findMany = jest.fn();
const count = jest.fn();
const findUnique = jest.fn();
const mailboxes = jest.fn();
const requesters = jest.fn();
const prismaMock = {
  ticketThreadEntry: { findMany, count },
  ticket: { findUnique },
  mailboxConnection: { findMany: mailboxes },
  requester: { findMany: requesters },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const entry = (over = {}) => ({
  bodyHtml: null, bodyText: 'We will look at it on Monday morning.', content: null,
  actorName: 'Reza Zaim', actorEmail: 'rzaim@bgcengineering.ca',
  occurredAt: new Date('2026-09-17T14:38:03Z'),
  isPrivate: false, eventType: 'reply', rawPayload: null, ...over,
});
const ticketRow = (over = {}) => ({
  description: '<p>Please set up the new plotter in the Calgary office.</p>',
  descriptionText: 'Please set up the new plotter in the Calgary office.',
  createdAt: new Date('2026-09-11T16:52:00Z'),
  ccEmails: [], workspaceId: 1,
  requester: { name: 'Dana Richard', email: 'drichard@bgcengineering.ca' },
  workspace: { defaultTimezone: 'America/Vancouver' }, ...over,
});
const headerOf = (html, label) => {
  const start = html.indexOf(`>${label}</div>`);
  return html.slice(start, html.indexOf('<blockquote', start));
};

beforeEach(() => {
  for (const fn of [findMany, count, findUnique, mailboxes, requesters]) fn.mockReset();
  count.mockResolvedValue(0);
  findMany.mockResolvedValue([]);
  mailboxes.mockResolvedValue([{ address: 'IT@bgcengineering.ca' }]);
  requesters.mockResolvedValue([]);
});

describe('the original request lists who was Cc’d', () => {
  test('names where the directory has them, the bare address where it does not', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['jparinas@bgcengineering.ca', 'lkassab@bgcengineering.ca'] }));
    requesters.mockResolvedValue([{ name: 'Jo Parinas', email: 'JParinas@bgcengineering.ca' }]);
    const quote = await ticketService._lastInboundQuote(1, null);
    const header = headerOf(quote.html, 'Original request');
    expect(header).toContain('Cc:</span>');
    expect(header).toContain('Jo Parinas</span> &lt;jparinas@bgcengineering.ca&gt;');
    expect(header).toContain('lkassab@bgcengineering.ca');
    expect(quote.text).toContain('> Cc: Jo Parinas <jparinas@bgcengineering.ca>; lkassab@bgcengineering.ca');
  });

  test('plumbing is not a person: the FreshService relay, our mailbox and its +tags, ticketpulse@, the sender', async () => {
    findUnique.mockResolvedValue(ticketRow({
      ccEmails: [
        'bgcengineeringcait@efusion.freshservice.com', 'it@bgcengineering.ca', 'IT+tp1285@bgcengineering.ca',
        'ticketpulse@bgcengineering.ca', 'drichard@bgcengineering.ca', 'lkassab@bgcengineering.ca',
      ],
    }));
    const quote = await ticketService._lastInboundQuote(1, null);
    const header = headerOf(quote.html, 'Original request');
    expect(header).toContain('lkassab@bgcengineering.ca');
    for (const gone of ['freshservice.com', 'it@bgcengineering', 'it+tp1285', 'ticketpulse@']) expect(header.toLowerCase()).not.toContain(gone);
    // The requester is the sender of the original request — shown once, as the sender.
    expect(header.match(/drichard@bgcengineering\.ca/g)).toHaveLength(1);
  });

  test('nobody Cc’d (or only plumbing) → no Cc line at all', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['bgcengineeringcait@efusion.freshservice.com'] }));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Cc:');
    expect(quote.text).not.toContain('Cc:');
  });

  test('a long list is capped and says how many more', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: Array.from({ length: 10 }, (_, i) => `person${i}@bgcengineering.ca`) }));
    const quote = await ticketService._lastInboundQuote(1, null);
    const header = headerOf(quote.html, 'Original request');
    expect(header.match(/person\d@/g)).toHaveLength(8);
    expect(header).toContain('and 2 more');
  });

  test('duplicates and case variants collapse', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['LKassab@bgcengineering.ca', 'lkassab@bgcengineering.ca'] }));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(headerOf(quote.html, 'Original request').match(/lkassab@/g)).toHaveLength(1);
  });
});

describe('each quoted message lists its own Cc', () => {
  test('from the message’s cc_emails, with an inline "Name <addr>" kept', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['someoneelse@bgcengineering.ca'] }));
    findMany.mockResolvedValue([entry({ rawPayload: { cc_emails: ['Jo Parinas <jparinas@bgcengineering.ca>', 'bgcengineeringcait@efusion.freshservice.com'] } })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    const message = headerOf(quote.html, 'Earlier in this conversation');
    expect(message).toContain('Jo Parinas</span> &lt;jparinas@bgcengineering.ca&gt;');
    expect(message).not.toContain('someoneelse@');
    expect(headerOf(quote.html, 'Original request')).toContain('someoneelse@bgcengineering.ca');
  });

  test('a message with no cc_emails has no Cc line', async () => {
    findUnique.mockResolvedValue(ticketRow());
    findMany.mockResolvedValue([entry({ rawPayload: { to_emails: ['x@bgcengineering.ca'] } })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Cc:');
  });
});

describe('it can only cost the Cc line', () => {
  test('a name is escaped', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['x@bgcengineering.ca'] }));
    requesters.mockResolvedValue([{ name: '<img src=x onerror=1>', email: 'x@bgcengineering.ca' }]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('<img src=x');
  });

  test('a failed directory lookup still quotes, with bare addresses', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['lkassab@bgcengineering.ca'] }));
    requesters.mockRejectedValue(new Error('db'));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('plotter');
    expect(quote.html).toContain('lkassab@bgcengineering.ca');
  });

  test('no lookups at all when nobody is Cc’d', async () => {
    findUnique.mockResolvedValue(ticketRow());
    await ticketService._lastInboundQuote(1, null);
    expect(requesters).not.toHaveBeenCalled();
    expect(mailboxes).not.toHaveBeenCalled();
  });

  test('the plain-text "On … wrote:" line the inbound stripper keys on is still first', async () => {
    findUnique.mockResolvedValue(ticketRow({ ccEmails: ['lkassab@bgcengineering.ca'] }));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.text).toMatch(/On .+, Dana Richard wrote:\n> Cc: lkassab@bgcengineering\.ca\n>\n> Please set up/);
  });
});
