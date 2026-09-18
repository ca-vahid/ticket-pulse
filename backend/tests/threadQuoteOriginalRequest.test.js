import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * TP-1285 (18 Sep 2026). Anton asked Vahid a question in FreshService on the
 * 17th and again in Ticket Pulse on the 18th. The e-mail Vahid received showed
 * the same paragraph twice — the reply, then the quoted earlier copy — and no
 * trace of the ticket's own description, because the description was quoted
 * only when the thread had no public message at all.
 */

const findMany = jest.fn();
const count = jest.fn();
const findUnique = jest.fn();
const prismaMock = { ticketThreadEntry: { findMany, count }, ticket: { findUnique } };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const QUESTION = 'What account/group should I use as a break-glass/emergency-access account to prevent lockout due to policy misconfiguration? Do we have something non-adm?';
const DESCRIPTION = 'Source: Mirai Security — BGC External Network Penetration Test. Finding 1 of 7. Severity: High. Disable legacy authentication (ROPC) on the Entra ID tenant.';

const entry = (over = {}) => ({
  bodyHtml: null, bodyText: 'body', content: null,
  actorName: 'Someone', actorEmail: 's@x.com',
  occurredAt: new Date('2026-09-17T21:38:00Z'),
  isPrivate: false, eventType: 'reply', ...over,
});
const ticketRow = (over = {}) => ({
  description: `<p>${DESCRIPTION}</p>`, descriptionText: DESCRIPTION,
  createdAt: new Date('2026-09-11T16:52:00Z'),
  requester: { name: 'Vahid Haeri', email: 'vhaeri@bgcengineering.ca' },
  workspace: { defaultTimezone: 'America/Vancouver' }, ...over,
});
const antonReply = { text: `${QUESTION}\nThank you,`, authorName: 'Anton Kuzmychev', authorEmail: 'akuzmychev@bgcengineering.ca' };
const blockCount = (quote) => (quote.html.match(/<blockquote/g) || []).length;

beforeEach(() => {
  findMany.mockReset(); count.mockReset(); findUnique.mockReset();
  count.mockResolvedValue(0);
  findUnique.mockResolvedValue(ticketRow());
});

describe('the same message is not mailed twice', () => {
  test('TP-1285: the agent’s own earlier copy (FreshService wrapper, other address) is dropped', async () => {
    findMany.mockResolvedValue([entry({
      bodyText: `Hi Vahid, Ticket: [#SR-241753] PENTEST HIGH 1/2 ${QUESTION} Thank you, Anton Kuzmychev`,
      actorName: 'Anton Kuzmychev', actorEmail: '"Anton Kuzmychev" <it@bgcengineering.ca>',
    })]);
    const quote = await ticketService._lastInboundQuote(44329, 1, { reply: antonReply });
    expect(quote.html).not.toContain('break-glass');
    expect(quote.html).toContain('Mirai Security');
    expect(blockCount(quote)).toBe(1);
  });

  test('a DIFFERENT person quoting the same words is a separate message', async () => {
    findMany.mockResolvedValue([entry({
      bodyText: `Forwarding Anton’s question: ${QUESTION} Thank you,`, actorName: 'Neville Vyland', actorEmail: 'nv@bgcengineering.ca',
    })]);
    const quote = await ticketService._lastInboundQuote(44329, 1, { reply: antonReply });
    expect(quote.html).toContain('break-glass');
  });

  test('two short acknowledgements are two messages', async () => {
    findMany.mockResolvedValue([
      entry({ bodyText: 'Thank you', actorName: 'Vahid Haeri' }),
      entry({ bodyText: 'Thank you', actorName: 'Vahid Haeri', occurredAt: new Date('2026-09-16T10:00:00Z') }),
    ]);
    const quote = await ticketService._lastInboundQuote(1, null, { reply: { text: 'Thank you', authorName: 'Vahid Haeri' } });
    expect(blockCount(quote)).toBe(3); // both, plus the original request
  });

  test('a reconciled FreshService copy and the Ticket Pulse copy of one message collapse to the newest', async () => {
    findMany.mockResolvedValue([
      entry({ bodyText: QUESTION, actorName: 'Anton Kuzmychev', occurredAt: new Date('2026-09-18T14:01:00Z') }),
      entry({ bodyText: QUESTION, actorName: 'Anton Kuzmychev', occurredAt: new Date('2026-09-17T21:38:00Z') }),
    ]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html.match(/break-glass/g)).toHaveLength(1);
  });

  test('without the reply context nothing changes for older callers', async () => {
    findMany.mockResolvedValue([entry({ bodyText: QUESTION, actorName: 'Anton Kuzmychev' })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('break-glass');
  });
});

describe('the original request closes every quote', () => {
  test('it is the LAST block, under the conversation, attributed to the requester', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'We will look at it Monday.', actorName: 'Anton Kuzmychev' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html.indexOf('Monday')).toBeLessThan(quote.html.indexOf('Mirai Security'));
    expect(quote.html).toContain('>Vahid Haeri</span>');
    expect(quote.text).toMatch(/On .+, Vahid Haeri wrote:/);
    expect(quote.text).toContain('> Source: Mirai Security');
  });

  test('a mail-born ticket is not described twice — by the row in hand', async () => {
    findMany.mockResolvedValue([entry({ eventType: 'original_email', bodyText: 'Can we please have an A-code opened' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Mirai Security');
    expect(blockCount(quote)).toBe(1);
  });

  test('…nor when the original e-mail lies beyond the eight quoted messages', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'latest' })]);
    count.mockResolvedValue(1);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('Mirai Security');
  });

  test('a description that a quoted message already carries is not repeated', async () => {
    findMany.mockResolvedValue([entry({ bodyText: DESCRIPTION, actorName: 'Vahid Haeri', actorEmail: 'vhaeri@bgcengineering.ca' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html.match(/Mirai Security/g)).toHaveLength(1);
  });

  test('it survives the total-size cap: it sits below the omitted-messages marker', async () => {
    const big = (i) => `<p>${String(i).repeat(19 * 1024)}</p>`;
    findMany.mockResolvedValue(Array.from({ length: 8 }, (_, i) => entry({ bodyHtml: big(i), bodyText: `message number ${i} `.repeat(4) })));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('earlier messages omitted');
    expect(quote.html.indexOf('earlier messages omitted')).toBeLessThan(quote.html.indexOf('Mirai Security'));
  });

  test('a failed description lookup costs the description, never the quote', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'still here' })]);
    findUnique.mockRejectedValue(new Error('db'));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('still here');
  });

  test('the description passes through the same sanitiser', async () => {
    findMany.mockResolvedValue([]);
    findUnique.mockResolvedValue(ticketRow({ description: '<p>hello</p><script>alert(1)</script>', descriptionText: 'hello' }));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('hello');
    expect(quote.html).not.toContain('<script');
  });
});

describe('quoted dates are in the workspace timezone, not the server\'s', () => {
  test('TP-1285: 14:38 UTC reads 7:38 a.m. in Vancouver', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'We will look at it Monday.', occurredAt: new Date('2026-09-17T14:38:03Z') })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toMatch(/Thursday, September 17, 2026.*7:38 a\.m\..*PDT/);
    expect(quote.text).toContain('On Sep 17, 2026, 7:38 a.m., Someone wrote:');
  });

  test('an unknown zone name falls back instead of losing the quote', async () => {
    findUnique.mockResolvedValue(ticketRow({ workspace: { defaultTimezone: 'Not/AZone' } }));
    findMany.mockResolvedValue([entry({ bodyText: 'still quoted' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('still quoted');
  });
});

describe('the quoted header reads like a mail client\'s reply header', () => {
  test('label, sender with a bare address, and the date each get their own line', async () => {
    findMany.mockResolvedValue([entry({
      bodyText: 'We will look at it Monday.', actorName: 'Anton Kuzmychev',
      actorEmail: '"Anton Kuzmychev" <it@bgcengineering.ca>', occurredAt: new Date('2026-09-17T14:38:03Z'),
    })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).toContain('Earlier in this conversation');
    expect(quote.html).toContain('Original request');
    expect(quote.html).toContain('>Anton Kuzmychev</span>');
    expect(quote.html).toContain('&lt;it@bgcengineering.ca&gt;');
    expect(quote.html).not.toContain('&quot;Anton');
    expect(quote.html).toContain('>AK<');
    expect(quote.html).toContain('>VH<');
  });

  test('no gradients, and every coloured cell states bgcolor AND background-color (Outlook)', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'hello there' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toMatch(/gradient/i);
    expect(quote.html).toContain('bgcolor="#e0e7ff"');
  });

  test('a sender with no name shows the address once, not twice', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'hello there', actorName: null, actorEmail: 'someone@x.com' })]);
    findUnique.mockResolvedValue(ticketRow({ description: null, descriptionText: null }));
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html.match(/someone@x\.com/g)).toHaveLength(1);
  });

  test('a name is escaped in the header', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'hello there', actorName: '<img src=x onerror=1>' })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.html).not.toContain('<img src=x');
  });

  test('the plain-text twin is unchanged — the inbound stripper keys on it', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'hello there', actorName: 'Anton Kuzmychev', occurredAt: new Date('2026-09-17T14:38:03Z') })]);
    const quote = await ticketService._lastInboundQuote(1, null);
    expect(quote.text).toContain('On Sep 17, 2026, 7:38 a.m., Anton Kuzmychev wrote:');
    expect(quote.html).toContain('class="gmail_quote"');
  });
});

