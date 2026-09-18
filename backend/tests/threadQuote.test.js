import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * FR 09-10 — "when an agent replies to the requester for the first time, carry
 * over the ticket information in an email thread style so the requester knows
 * what the reply is about."
 *
 * The old quote carried exactly ONE message (the requester's own last mail), so
 * a reply arrived with no ticket context — which is what Alvina's reply to
 * David looked like.
 *
 * The highest-severity risk in this change is an internal note reaching a
 * customer, so that is the first thing asserted here and it is asserted twice:
 * once on the query the service builds, once on rows the query wrongly returns.
 */

const findMany = jest.fn();
const prismaMock = { ticketThreadEntry: { findMany } };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: ticketService } = await import('../src/services/ticketService.js');

const entry = (over = {}) => ({
  bodyHtml: '<p>body</p>', bodyText: 'body', content: 'body',
  actorName: 'Someone', actorEmail: 's@x.com',
  occurredAt: new Date('2026-09-10T15:11:00Z'),
  isPrivate: false, eventType: 'reply', ...over,
});

beforeEach(() => findMany.mockReset());

describe('an internal note must never reach the requester', () => {
  test('the query asks only for public messages, by allowlist AND isPrivate', async () => {
    findMany.mockResolvedValue([]);
    await ticketService._lastInboundQuote(1);
    const where = findMany.mock.calls[0][0].where;
    expect(where.isPrivate).toBe(false);
    const allow = where.OR.find((c) => c.eventType)?.eventType?.in || [];
    expect(allow).toEqual(expect.arrayContaining(['reply', 'public_reply', 'original_email']));
    // The private kinds must not be requestable at all.
    expect(allow).not.toContain('note');
    expect(allow).not.toContain('private_note');
    expect(allow).not.toContain('forward');
  });

  test('a private row that slipped through the query is still dropped', async () => {
    findMany.mockResolvedValue([
      entry({ isPrivate: true, bodyText: 'INTERNAL: customer is being difficult', bodyHtml: '<p>INTERNAL: customer is being difficult</p>' }),
      entry({ bodyText: 'public answer', bodyHtml: '<p>public answer</p>' }),
    ]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('public answer');
    expect(quote.html).not.toContain('INTERNAL');
    expect(quote.text).not.toContain('INTERNAL');
  });

  test('nothing public at all means no quote, not an empty shell', async () => {
    findMany.mockResolvedValue([entry({ isPrivate: true })]);
    expect(await ticketService._lastInboundQuote(1)).toBeNull();
  });
});

describe('the whole conversation, newest first', () => {
  test('every public message is quoted, not just the last', async () => {
    findMany.mockResolvedValue([
      entry({ bodyHtml: '<p>third</p>', bodyText: 'third', actorName: 'David' }),
      entry({ bodyHtml: '<p>second</p>', bodyText: 'second', actorName: 'Alvina' }),
      entry({ bodyHtml: '<p>first</p>', bodyText: 'first', actorName: 'David' }),
    ]);
    const quote = await ticketService._lastInboundQuote(1);
    for (const part of ['third', 'second', 'first']) expect(quote.html).toContain(part);
    expect(quote.html.indexOf('third')).toBeLessThan(quote.html.indexOf('first'));
  });

  test('each block is attributed and dated', async () => {
    findMany.mockResolvedValue([entry({ actorName: 'Alvina Chen' })]);
    const quote = await ticketService._lastInboundQuote(1);
    // HTML: a mail-client style header — name on its own line, full date under it.
    expect(quote.html).toContain('>Alvina Chen</span>');
    expect(quote.html).toMatch(/September 10, 2026/);
    // Plain text keeps the line replyQuoteStripper keys on.
    expect(quote.text).toMatch(/On .+, Alvina Chen wrote:/);
  });

  test('the plain-text twin keeps "> " quoting', async () => {
    findMany.mockResolvedValue([entry({ bodyText: 'line one\nline two' })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.text).toContain('> line one');
    expect(quote.text).toContain('> line two');
  });
});

describe('it cannot run away', () => {
  test('more than 8 messages is capped and says so', async () => {
    findMany.mockResolvedValue(Array.from({ length: 9 }, (_, i) => entry({ bodyHtml: `<p>msg${i}</p>`, bodyText: `msg${i}` })));
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('earlier messages omitted');
    expect(findMany.mock.calls[0][0].take).toBe(9);
  });

  test('a huge thread is truncated rather than mailed whole', async () => {
    const big = `<p>${'x'.repeat(19 * 1024)}</p>`;
    findMany.mockResolvedValue(Array.from({ length: 8 }, () => entry({ bodyHtml: big, bodyText: 'x' })));
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html.length).toBeLessThan(100 * 1024);
    expect(quote.html).toContain('earlier messages omitted');
  });

  test('the entry being sent right now is excluded', async () => {
    findMany.mockResolvedValue([]);
    await ticketService._lastInboundQuote(1, 4242);
    expect(findMany.mock.calls[0][0].where.id).toEqual({ not: 4242 });
  });

  test('bodiless rows are skipped without producing an empty block', async () => {
    findMany.mockResolvedValue([
      entry({ bodyHtml: null, bodyText: null, content: null }),
      entry({ bodyHtml: '<p>real</p>', bodyText: 'real' }),
    ]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('real');
    expect(quote.html.match(/blockquote/g).length).toBe(2); // one open, one close
  });
});

describe('the source still matches these assumptions', () => {
  test('the private event types are named nowhere in the allowlist', () => {
    const src = readFileSync(new URL('../src/services/ticketService.js', import.meta.url), 'utf8');
    const line = src.split('\n').find((l) => l.includes('QUOTABLE_EVENT_TYPES ='));
    expect(line).toBeTruthy();
    expect(line).not.toMatch(/'note'|'private_note'|'forward'/);
  });
});

describe('FR 09-11 #3 (review): a quoted text-only original is not double-spaced', () => {
  // The real TP-1291 body: forwarded in with no HTML, a blank line after
  // every line. The conversation view was fixed in 3.8.57; the SAME defect
  // sat in the quote we append to outbound replies, so the requester's email
  // showed Chelsea's message with an empty line between each line.
  const body = 'Hi PA Team,\n\nCan we please have an A-code opened?\n\nStart date – August 17, 2026\n\nBST Tasks\n\nPlanning\n\nPacking/Moving';

  test('blank lines become paragraphs, never <br/><br/>', async () => {
    findMany.mockResolvedValue([entry({ bodyHtml: null, bodyText: body, content: body, actorName: 'Chelsea Simpson' })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).not.toMatch(/<br\s*\/?>\s*<br\s*\/?>/);
    expect(quote.html).toContain('<p>Planning</p>');
    expect(quote.html).toContain('<p>Packing/Moving</p>');
  });

  test('a single newline inside a paragraph is still a line break', async () => {
    findMany.mockResolvedValue([entry({ bodyHtml: null, bodyText: 'Line one\nLine two', content: 'Line one\nLine two' })]);
    const quote = await ticketService._lastInboundQuote(1);
    // The email sanitizer normalises <br> to <br />; either is a line break.
    expect(quote.html).toMatch(/Line one<br\s*\/?>Line two/);
  });

  test('HTML in the text is escaped, and stored HTML is still preferred over text', async () => {
    findMany.mockResolvedValue([
      entry({ bodyHtml: null, bodyText: '<script>x</script> & co', content: '<script>x</script> & co' }),
      entry({ bodyHtml: '<p>real html</p>', bodyText: 'ignored' }),
    ]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('&lt;script&gt;');
    expect(quote.html).not.toContain('<script>');
    expect(quote.html).toContain('<p>real html</p>');
    expect(quote.html).not.toContain('ignored');
  });
});
