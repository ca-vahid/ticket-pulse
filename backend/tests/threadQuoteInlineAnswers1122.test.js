import { jest, describe, expect, test, beforeEach } from '@jest/globals';

/**
 * 22 Nov 2026: answers a requester typed inline in our earlier mail are kept on
 * the entry (raw_payload.inlineAnswers, since 4.4.03) and its body is only their
 * top text. The quoted history of the NEXT reply must carry those answers under
 * that message, in the "Answered inline" form the FreshService copy uses.
 * Invented names and example.com only.
 */
const findMany = jest.fn();
const prismaMock = { ticketThreadEntry: { findMany } };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { inlineAnswersText } = await import('../src/utils/inlineAnswers.js');

const inbound = (over = {}) => ({
  id: 71, source: 'email_inbound', eventType: 'reply', isPrivate: false,
  bodyHtml: '<p>Thanks, answers below.</p>', bodyText: 'Thanks, answers below.', content: 'Thanks, answers below.',
  actorName: 'Dana Fox', actorEmail: 'dana.fox@example.com',
  occurredAt: new Date('2026-11-20T17:05:00Z'), ...over,
});

const pairs = [
  { context: 'Which laptop model do you need?', answer: 'The 14-inch one' },
  { context: 'When do you start?', answer: 'Monday 30 Nov\nat the Vancouver office' },
];

beforeEach(() => findMany.mockReset());

describe('the quoted history carries inline answers', () => {
  test('the pairs sit under the message they were typed in, in the "Answered inline" form', async () => {
    findMany.mockResolvedValue([inbound({ rawPayload: { inlineAnswers: pairs } })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).toContain('Answered inline');
    expect(quote.html).toContain('<b>Which laptop model do you need?</b>');
    expect(quote.html).toContain('The 14-inch one');
    expect(quote.html).toMatch(/Monday 30 Nov<br\s*\/?>at the Vancouver office/);
    // Under the top text, inside the same quoted block.
    expect(quote.html.indexOf('Thanks, answers below.')).toBeLessThan(quote.html.indexOf('Answered inline'));
    expect(quote.html.match(/<blockquote/g)).toHaveLength(1);
    // The plain-text twin too, quoted with "> ".
    expect(quote.text).toContain('> Thanks, answers below.');
    expect(quote.text).toContain('> Answered inline');
    expect(quote.text).toContain('> Which laptop model do you need?');
    expect(quote.text).toContain('> The 14-inch one');
  });

  test('as ingest really stores it (body_text already ends with the pairs): each part shows them once', async () => {
    const stored = `Thanks, answers below.\n\n${inlineAnswersText(pairs)}`;
    findMany.mockResolvedValue([inbound({ bodyText: stored, content: stored, rawPayload: { inlineAnswers: pairs } })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html.match(/Answered inline/g)).toHaveLength(1);
    expect(quote.text.match(/Answered inline/g)).toHaveLength(1);
    expect(quote.text.match(/The 14-inch one/g)).toHaveLength(1);
    expect(quote.text).toContain('> Thanks, answers below.');
  });

  test('text-only row whose body_text is just the pairs: quoted once, not twice', async () => {
    const stored = inlineAnswersText(pairs);
    findMany.mockResolvedValue([inbound({ bodyHtml: null, bodyText: stored, content: stored, rawPayload: { inlineAnswers: pairs } })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html.match(/Answered inline/g)).toHaveLength(1);
    expect(quote.text.match(/Answered inline/g)).toHaveLength(1);
  });

  test('only the message that has pairs gets them', async () => {
    findMany.mockResolvedValue([
      inbound({ id: 72, bodyHtml: '<p>One more thing.</p>', bodyText: 'One more thing.', occurredAt: new Date('2026-11-21T17:05:00Z') }),
      inbound({ rawPayload: { inlineAnswers: pairs } }),
    ]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html.match(/Answered inline/g)).toHaveLength(1);
    expect(quote.html.indexOf('One more thing.')).toBeLessThan(quote.html.indexOf('Answered inline'));
  });

  test('a reply that is only inline answers (nothing on top) is still quoted', async () => {
    findMany.mockResolvedValue([inbound({ bodyHtml: null, bodyText: null, content: null, rawPayload: { inlineAnswers: pairs } })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote).not.toBeNull();
    expect(quote.html).toContain('The 14-inch one');
    expect(quote.text).toContain('> Answered inline');
  });

  test('no pairs: the quote is exactly what it was', async () => {
    findMany.mockResolvedValue([inbound()]);
    const without = await ticketService._lastInboundQuote(1);
    for (const rawPayload of [{}, { inlineAnswers: [] }, { inlineAnswers: [{ context: ' ', answer: 'x' }] }, { inlineAnswers: 'nonsense' }]) {
      findMany.mockResolvedValue([inbound({ rawPayload })]);
      const quote = await ticketService._lastInboundQuote(1);
      expect(quote).toEqual(without);
    }
    expect(without.html).not.toContain('Answered inline');
  });

  test('the pairs are escaped: what a requester typed never becomes markup', async () => {
    findMany.mockResolvedValue([inbound({
      rawPayload: { inlineAnswers: [{ context: 'Cost centre <b>code</b>?', answer: '<img src=x onerror=alert(1)> A & B <script>alert(2)</script>' }] },
    })]);
    const quote = await ticketService._lastInboundQuote(1);
    expect(quote.html).not.toContain('<script');
    expect(quote.html).not.toContain('<img src=x');
    expect(quote.html).not.toContain('onerror=alert(1)>');
    expect(quote.html).toContain('&lt;script&gt;');
    expect(quote.html).toContain('Cost centre &lt;b&gt;code&lt;/b&gt;?');
    expect(quote.html).toContain('A &amp; B');
  });
});
