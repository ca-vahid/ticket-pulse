import { jest } from '@jest/globals';

/**
 * 4.4.08 attachment display names: the background job (rules + Claude reading
 * the PDF), the mail-intake hook, Revert and Edit. The Anthropic SDK is mocked;
 * vendors and domains are invented.
 */

// ---- in-memory rows ---------------------------------------------------------
let rows = [];
let activities = [];
let attempts = [];
const settings = new Map();

const match = (row, where = {}) => Object.entries(where).every(([k, v]) => {
  if (k === 'NOT') return !match(row, v);
  if (k === 'OR') return v.some((w) => match(row, w));
  if (k === 'AND') return v.every((w) => match(row, w));
  if (v && typeof v === 'object' && !(v instanceof Date)) {
    if ('equals' in v) {
      if (v.path) return (v.path.reduce((o, p) => o?.[p], row[k]) ?? null) === v.equals;
      if (v.equals && typeof v.equals === 'object') return (row[k] ?? null) === null; // Prisma.DbNull
      return row[k] === v.equals;
    }
    if ('in' in v) return v.in.includes(row[k]);
    if ('gte' in v) return new Date(row[k]) >= v.gte;
    if ('startsWith' in v) return String(row[k]).startsWith(v.startsWith);
  }
  return (row[k] ?? null) === v;
});

const prismaMock = {
  ticketAttachment: {
    findUnique: jest.fn(async ({ where }) => rows.find((r) => r.id === where.id) || null),
    findFirst: jest.fn(async ({ where }) => rows.find((r) => match(r, where)) || null),
    findMany: jest.fn(async ({ where }) => rows.filter((r) => match(r, where))),
    updateMany: jest.fn(async ({ where, data }) => {
      const hit = rows.filter((r) => match(r, where));
      hit.forEach((r) => Object.assign(r, data));
      return { count: hit.length };
    }),
    update: jest.fn(async ({ where, data }) => {
      const r = rows.find((x) => x.id === where.id);
      Object.assign(r, data);
      return { ...r };
    }),
  },
  ticketActivity: { create: jest.fn(async ({ data }) => { activities.push(data); return data; }) },
  ticket: { findUnique: jest.fn(async () => ({ subject: 'Ticket subject' })) },
  workspace: { findUnique: jest.fn(async () => ({ internalDomains: ['ourco.example'] })) },
  aiProviderAttempt: { create: jest.fn(async ({ data }) => { attempts.push(data); return data; }) },
  appSettings: { findMany: jest.fn(async ({ where }) => [...settings.entries()].map(([key, value]) => ({ key, value })).filter((s) => match(s, where))) },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: {
    get: jest.fn(async (k) => (settings.has(k) ? settings.get(k) : null)),
    set: jest.fn(async (k, v) => { settings.set(k, String(v)); }),
  },
}));
const bufferFor = jest.fn(async () => Buffer.from('%PDF-1.7 invented'));
jest.unstable_mockModule('../src/services/attachmentService.js', () => ({ default: { bufferFor } }));
const broadcast = jest.fn();
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast } }));

// ---- the SDK ----------------------------------------------------------------
const createMock = jest.fn();
class APIError extends Error { constructor(status, message) { super(message); this.status = status; } }
class RateLimitError extends APIError { constructor(message) { super(429, message); } }
class APIConnectionError extends APIError { constructor(message) { super(undefined, message); } }
class APIConnectionTimeoutError extends APIConnectionError {}
class Anthropic { constructor() { this.messages = { create: createMock }; } }
Anthropic.APIError = APIError;
Anthropic.RateLimitError = RateLimitError;
Anthropic.APIConnectionError = APIConnectionError;
Anthropic.APIConnectionTimeoutError = APIConnectionTimeoutError;
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: Anthropic, APIError, RateLimitError, APIConnectionError, APIConnectionTimeoutError }));

// The shared @prisma/client test mock has no null sentinels; the real DbNull is an object.
const Prisma = { DbNull: Object.freeze({ toString: () => 'Prisma.DbNull' }) };
jest.unstable_mockModule('@prisma/client', () => ({ Prisma, PrismaClient: class {} }));

const svc = await import('../src/services/attachmentNamingService.js');

const aiReply = (answer, extra = {}) => ({
  stop_reason: 'end_turn',
  content: [{ type: 'text', text: JSON.stringify(answer) }],
  usage: { input_tokens: 1500, output_tokens: 40 },
  ...extra,
});

function addRow(over = {}) {
  const row = {
    id: rows.length + 1, workspaceId: 2, ticketId: 1042, fileName: 'INV-100234.pdf', contentType: 'application/pdf',
    sizeBytes: 40_000, source: 'email', uploadedBy: 'billing@acme.example', blobName: 'b', createdAt: new Date('2026-11-23T18:00:00Z'),
    displayName: null, nameSource: null, nameDetails: null, namedAt: null, namedBy: null,
    ...over,
  };
  rows.push(row);
  return row;
}

const email = (over = {}) => ({
  subject: 'Invoice attached', from: 'billing@acme.example', fromName: 'Dana Fox', bodyText: 'See attached.',
  receivedAt: new Date('2026-11-23T18:00:00Z'), ...over,
});

beforeEach(() => {
  rows = []; activities = []; attempts = [];
  settings.clear();
  settings.set('attachment_naming_ws2', 'live');
  jest.clearAllMocks();
  svc._setRetryDelayForTests(1);
});

describe('the Claude call', () => {
  test('the prompt tells Claude a payment remittance takes the invoice number being paid (24 Nov 2026)', () => {
    const prompt = svc.buildPrompt({ subject: 'Remittance advice', senderName: 'Northwind Traders', senderDomain: 'northwind.example', fileName: 'remit.pdf', rules: {} });
    expect(prompt).toMatch(/payment remittance/i);
    expect(prompt).toMatch(/invoice number being paid, not the payment document, payment run or cheque number/);
    expect(prompt).toMatch(/several invoices, use the first invoice listed/);
  });

  test('request shape: model from settings, structured output, low effort, no thinking, PDF before the text', async () => {
    settings.set('attachment_naming_model', 'claude-test-model');
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', documentDate: '2026-11-20', confidence: 'high' }));
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: email().subject, fromEmail: email().from, fromName: 'Dana Fox', receivedAt: email().receivedAt });

    expect(out).toEqual({ renamed: true, name: 'Acme Supplies_INV-100234_2026_11_20.pdf' });
    const req = createMock.mock.calls[0][0];
    expect(createMock.mock.calls[0][1]).toEqual({ timeout: 60_000, maxRetries: 0 });
    expect(req.model).toBe('claude-test-model');
    expect(req.max_tokens).toBe(1024);
    expect(req).not.toHaveProperty('thinking');
    expect(req.output_config.effort).toBe('low');
    expect(req.output_config.format.type).toBe('json_schema');
    expect(req.output_config.format.schema.required).toEqual(['vendor', 'invoiceNumber', 'documentDate', 'confidence']);
    const [doc, text] = req.messages[0].content;
    expect(doc).toEqual({ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from('%PDF-1.7 invented').toString('base64') } });
    expect(text.type).toBe('text');
    expect(text.text).toMatch(/Original file name: INV-100234\.pdf/);
    expect(text.text).toMatch(/payment or billing platform/);

    expect(rows[0]).toMatchObject({ displayName: 'Acme Supplies_INV-100234_2026_11_20.pdf', nameSource: 'auto', namedBy: 'Ticket Pulse' });
    expect(rows[0].nameDetails).toMatchObject({ vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', documentDate: '2026-11-20', dateFrom: 'document', method: 'rules+ai', confidence: 'high', model: 'claude-test-model' });
    expect(attempts[0]).toMatchObject({ operation: 'attachment_naming', provider: 'anthropic', status: 'succeeded', inputTokens: 1500, outputTokens: 40 });
    expect(activities[0]).toMatchObject({ ticketId: 1042, activityType: 'attachment_renamed', performedBy: 'Ticket Pulse' });
    expect(activities[0].details).toMatchObject({ action: 'auto', from: 'INV-100234.pdf', to: 'Acme Supplies_INV-100234_2026_11_20.pdf', originalName: 'INV-100234.pdf' });
    expect(broadcast).toHaveBeenCalledWith('ticket-change', expect.objectContaining({ action: 'attachment_renamed', ticketId: 1042, attachmentId: row.id }), 2);
  });

  test('rules give vendor AND number with high confidence → Claude is not called; date is the arrival day', async () => {
    const row = addRow({ uploadedBy: 'noreply@getbalance.com' });
    const out = await svc.nameAttachment(row.id, { subject: 'New Invoice from Acme Supplies', fromEmail: 'noreply@getbalance.com', receivedAt: new Date('2026-11-24T05:00:00Z') });
    expect(createMock).not.toHaveBeenCalled();
    expect(out.name).toBe('Acme Supplies_INV-100234_2026_11_23.pdf');
    expect(rows[0].nameDetails).toMatchObject({ method: 'rules', dateFrom: 'received', documentDate: null });
  });

  test('a refusal falls back to the rules', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'refusal', content: [], usage: {} });
    const row = addRow({ fileName: 'doc.pdf' });
    const out = await svc.nameAttachment(row.id, { subject: 'Northwind Rentals Invoice', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(out.name).toBe('Northwind Rentals_2026_11_23.pdf');
    expect(rows[0].nameDetails.method).toBe('rules');
    expect(attempts[0]).toMatchObject({ status: 'failed', errorClass: 'refusal' });
  });

  test('max_tokens is a failure too, read before any content', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"vendor":"Half' }], usage: {} });
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(out).toEqual({ renamed: false, reason: 'no_vendor_ai_failed' });
    expect(rows[0].displayName).toBeNull();
  });

  test('a refusal with no rules vendor → no rename; the billed failure is counted on the file', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'refusal', content: [], usage: {} });
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(out).toEqual({ renamed: false, reason: 'no_vendor_ai_failed' });
    expect(rows[0]).toMatchObject({ nameSource: null, displayName: null });
    expect(rows[0].nameDetails).toMatchObject({ vendor: null, outcome: 'ai_failed', tries: 1, reason: 'refusal' });
    expect(activities).toHaveLength(0);
  });

  test.each([
    ['max_tokens', () => createMock.mockResolvedValueOnce({ stop_reason: 'max_tokens', content: [], usage: {} })],
    ['invalid_output', () => createMock.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: {} })],
    ['timeout', () => createMock.mockRejectedValueOnce(new APIConnectionTimeoutError('Request timed out.'))],
  ])('billed failure %s: marked ai_failed, not retried, counted', async (reason, arrange) => {
    arrange();
    const row = addRow();
    await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(rows[0].nameDetails).toMatchObject({ outcome: 'ai_failed', tries: 1, reason });
  });

  test.each([
    ['rate_limit', () => createMock.mockRejectedValue(new RateLimitError('slow down'))],
    ['api_503', () => createMock.mockRejectedValue(new APIError(503, 'overloaded'))],
    ['connection', () => createMock.mockRejectedValue(new APIConnectionError('reset'))],
  ])('unbilled failure %s: left unmarked so the catch-up retries for free', async (_reason, arrange) => {
    arrange();
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(out.reason).toBe('no_vendor_ai_unavailable');
    expect(rows[0].nameDetails).toBeNull();
    createMock.mockReset();
  });

  test('missing file bytes are unbilled too: left unmarked', async () => {
    bufferFor.mockResolvedValueOnce(null);
    const row = addRow();
    expect((await svc.nameAttachment(row.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).reason).toBe('no_vendor_ai_unavailable');
    expect(createMock).not.toHaveBeenCalled();
    expect(rows[0].nameDetails).toBeNull();
  });

  test('a billed failure falls back to the rules when they name a vendor', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'refusal', content: [], usage: {} });
    const row = addRow({ fileName: 'doc.pdf' });
    const out = await svc.nameAttachment(row.id, { subject: 'Northwind Rentals Invoice', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(out.name).toBe('Northwind Rentals_2026_11_23.pdf');
    expect(rows[0].nameDetails).toMatchObject({ method: 'rules', aiFailed: 'refusal' });
  });

  test('the second billed failure is the last: tries 2, and Claude is never asked a third time', async () => {
    createMock.mockResolvedValue({ stop_reason: 'refusal', content: [], usage: {} });
    const row = addRow({ nameDetails: { vendor: null, outcome: 'ai_failed', tries: 1, reason: 'refusal' } });
    await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(rows[0].nameDetails).toMatchObject({ outcome: 'ai_failed', tries: 2 });
    createMock.mockClear();
    await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(createMock).not.toHaveBeenCalled();
    createMock.mockReset();
  });

  test('a rate limit is retried once', async () => {
    createMock
      .mockRejectedValueOnce(new RateLimitError('slow down'))
      .mockResolvedValueOnce(aiReply({ vendor: 'Acme Supplies', invoiceNumber: null, documentDate: null, confidence: 'medium' }));
    const row = addRow({ fileName: 'scan.pdf' });
    const out = await svc.nameAttachment(row.id, { subject: 'x', fromEmail: 'ar@vendor.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(out.name).toBe('Acme Supplies_2026_11_23.pdf');
    expect(attempts.map((a) => a.status)).toEqual(['failed', 'succeeded']);
    expect(attempts[0].errorClass).toBe('rate_limit');
  });

  test('an API status error (400) is not retried; connection errors are, then give up → rules', async () => {
    createMock.mockRejectedValueOnce(new APIError(400, 'bad request'));
    const a = addRow({ fileName: 'a.pdf' });
    expect(await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).toEqual({ renamed: false, reason: 'no_vendor_ai_failed' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(attempts[0].errorClass).toBe('api_400');

    createMock.mockReset();
    createMock.mockRejectedValue(new APIConnectionError('socket hang up'));
    const b = addRow({ fileName: 'b.pdf' });
    const out = await svc.nameAttachment(b.id, { subject: 'Northwind Rentals Invoice', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(attempts.slice(1).map((x) => x.errorClass)).toEqual(['connection', 'connection']);
    expect(out.name).toBe('Northwind Rentals_2026_11_23.pdf');
    createMock.mockReset();
  });

  test('output that is not valid JSON or fails validation is ignored (never string-matched)', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'The vendor is {"vendor":"Acme"}' }], usage: {} });
    const a = addRow({ fileName: 'a.pdf' });
    expect((await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).renamed).toBe(false);
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Acme', invoiceNumber: null, documentDate: null, confidence: 'certain' }));
    const b = addRow({ fileName: 'b.pdf' });
    expect((await svc.nameAttachment(b.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).renamed).toBe(false);
    expect(attempts.map((x) => x.errorClass)).toEqual(['invalid_output', 'invalid_output']);
  });

  test('low confidence and no rules vendor → no rename; the file is marked checked', async () => {
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Maybe Acme', invoiceNumber: '991', documentDate: '2026-11-01', confidence: 'low' }));
    const row = addRow();
    expect(await svc.nameAttachment(row.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).toEqual({ renamed: false, reason: 'no_vendor' });
    expect(rows[0]).toMatchObject({ displayName: null, nameSource: null });
    expect(rows[0].nameDetails).toMatchObject({ vendor: null, outcome: 'no_vendor', model: expect.any(String) });
  });

  test('a 5xx is retried once; a 408 is not', async () => {
    createMock.mockRejectedValueOnce(new APIError(503, 'overloaded')).mockResolvedValueOnce(aiReply({ vendor: 'Acme Supplies', invoiceNumber: null, documentDate: null, confidence: 'high' }));
    const a = addRow({ fileName: 'a.pdf' });
    expect((await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).renamed).toBe(true);
    expect(createMock).toHaveBeenCalledTimes(2);
    createMock.mockClear();
    createMock.mockRejectedValueOnce(new APIError(408, 'timeout'));
    const b = addRow({ fileName: 'b.pdf' });
    await svc.nameAttachment(b.id, { subject: 'x', fromEmail: 'ar@vendor.example' });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(attempts.map((x) => [x.status, x.attemptNumber])).toEqual([['failed', 1], ['succeeded', 2], ['failed', 1]]);
  });

  test('Claude\'s vendor is filtered: our own company or a platform is never the name', async () => {
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'OurCo Engineering', invoiceNumber: 'INV-4', documentDate: null, confidence: 'high' }));
    const a = addRow({ fileName: 'a.pdf' });
    expect((await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).renamed).toBe(false);
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'QuickBooks', invoiceNumber: 'INV-5', documentDate: null, confidence: 'high' }));
    const b = addRow({ fileName: 'b.pdf' });
    expect((await svc.nameAttachment(b.id, { subject: 'x', fromEmail: 'quickbooks@notification.intuit.com' })).renamed).toBe(false);
    expect(rows.map((r) => r.displayName)).toEqual([null, null]);
  });

  test('one mail with an invoice, terms and a W9: the subject\'s number lands only on the invoice', async () => {
    const mail = { subject: 'Invoice 28401 from Northwind Traders', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z'), documentCount: 3 };
    const inv = addRow({ id: 81, fileName: 'Invoice_28401.pdf', uploadedBy: 'ar@northwind.example' });
    const terms = addRow({ id: 82, fileName: 'Terms.pdf', uploadedBy: 'ar@northwind.example' });
    const w9 = addRow({ id: 83, fileName: 'W9.pdf', uploadedBy: 'ar@northwind.example' });
    createMock
      .mockResolvedValueOnce(aiReply({ vendor: 'Northwind Traders', invoiceNumber: null, documentDate: null, confidence: 'high' }))
      .mockResolvedValueOnce(aiReply({ vendor: 'Northwind Traders', invoiceNumber: null, documentDate: null, confidence: 'high' }));

    expect((await svc.nameAttachment(inv.id, mail)).name).toBe('Northwind Traders_28401_2026_11_23.pdf');
    expect(createMock).not.toHaveBeenCalled(); // its own name holds the number: the rules are enough
    expect((await svc.nameAttachment(terms.id, mail)).name).toBe('Northwind Traders_2026_11_23.pdf');
    expect((await svc.nameAttachment(w9.id, mail)).name).toBe('Northwind Traders_2026_11_23 (2).pdf');
    expect(createMock).toHaveBeenCalledTimes(2);
    expect(createMock.mock.calls[0][0].messages[0].content[1].text).toMatch(/mentions number 28401, but the mail had several documents/);
  });

  test('without the e-mail in hand, the document count comes from the same message\'s stored files', async () => {
    const mail = { subject: 'Invoice 28401 from Northwind Traders', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z') };
    addRow({ id: 91, fileName: 'Invoice_28401.pdf', threadEntryId: 5 });
    const terms = addRow({ id: 92, fileName: 'Terms.pdf', threadEntryId: 5 });
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Northwind Traders', invoiceNumber: null, documentDate: null, confidence: 'high' }));
    expect((await svc.nameAttachment(terms.id, mail)).name).toBe('Northwind Traders_2026_11_23.pdf');
  });

  test('PDFs over 10 MB skip Claude (rules only)', async () => {
    const row = addRow({ fileName: 'big.pdf', sizeBytes: 11 * 1024 * 1024 });
    const out = await svc.nameAttachment(row.id, { subject: 'Northwind Rentals Invoice', fromEmail: 'ar@northwind.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(createMock).not.toHaveBeenCalled();
    expect(bufferFor).not.toHaveBeenCalled();
    expect(out.name).toBe('Northwind Rentals_2026_11_23.pdf');
  });

  test('a duplicate name on the same ticket gets " (2)"', async () => {
    addRow({ id: 50, fileName: 'other.pdf', displayName: 'Acme Supplies_INV-100234_2026_11_23.pdf', nameSource: 'auto' });
    const row = addRow({ id: 51, uploadedBy: 'noreply@getbalance.com' });
    const out = await svc.nameAttachment(row.id, { subject: 'New Invoice from Acme Supplies', fromEmail: 'noreply@getbalance.com', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(out.name).toBe('Acme Supplies_INV-100234_2026_11_23 (2).pdf');
  });
});

describe('the mail-intake hook', () => {
  const acmeInvoiceMail = () => email({ subject: 'New Invoice from Acme Supplies', from: 'noreply@getbalance.com' });

  test('Accounting live → named in the background', async () => {
    const row = addRow({ uploadedBy: 'noreply@getbalance.com' });
    expect(await svc.queueEmailAttachment(row, { email: acmeInvoiceMail() })).toBe(true);
    expect(rows[0].displayName).toBe('Acme Supplies_INV-100234_2026_11_23.pdf');
  });

  test('a workspace that is off (the default) is left alone', async () => {
    settings.delete('attachment_naming_ws2');
    const row = addRow({ uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: acmeInvoiceMail() });
    expect(rows[0].displayName).toBeNull();
    expect(prismaMock.ticketAttachment.updateMany).not.toHaveBeenCalled();
  });

  test('another workspace without its own switch is left alone', async () => {
    const row = addRow({ workspaceId: 1, uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: acmeInvoiceMail() });
    expect(rows[0].displayName).toBeNull();
  });

  test('agent uploads and FreshService files are never queued', async () => {
    expect(await svc.queueEmailAttachment(addRow({ source: 'upload' }), { email: acmeInvoiceMail() })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ source: 'freshservice' }), { email: acmeInvoiceMail() })).toBe(false);
    expect(prismaMock.ticketAttachment.findUnique).not.toHaveBeenCalled();
  });

  test('inline images are skipped', async () => {
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'picture-1-ABC-image.png', contentType: 'image/png' }), { email: acmeInvoiceMail(), isInline: true })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'logo.png', contentType: 'image/png' }), { email: acmeInvoiceMail() })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'scan.pdf' }), { email: acmeInvoiceMail(), isInline: true })).toBe(false);
  });

  test('a file someone already named or reverted is never renamed', async () => {
    const row = addRow({ nameSource: 'reverted', uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: acmeInvoiceMail() });
    expect(rows[0].displayName).toBeNull();
  });

  test('at most 2 run at a time', async () => {
    let inFlight = 0;
    let peak = 0;
    createMock.mockImplementation(async () => {
      inFlight += 1; peak = Math.max(peak, inFlight);
      await new Promise((r) => { setTimeout(r, 15); });
      inFlight -= 1;
      return aiReply({ vendor: 'Acme Supplies', invoiceNumber: null, documentDate: null, confidence: 'high' });
    });
    const jobs = [1, 2, 3, 4, 5].map((n) => svc.queueEmailAttachment(addRow({ ticketId: 2000 + n, fileName: `scan-${n}.pdf` }), { email: email() }));
    await Promise.all(jobs);
    expect(createMock).toHaveBeenCalledTimes(5);
    expect(peak).toBe(2);
    createMock.mockReset();
  });

  test('the queue holds at most 500 waiting jobs; extras are dropped with a log line', async () => {
    settings.delete('attachment_naming_ws2'); // jobs finish fast
    const jobs = [];
    for (let n = 0; n < 503; n += 1) jobs.push(svc.queueEmailAttachment(addRow({ id: 10_000 + n, fileName: `scan-${n}.pdf` }), { email: email() }));
    const results = await Promise.all(jobs);
    expect(results.filter((r) => r === true)).toHaveLength(502); // 2 running + 500 waiting
    expect(results[502]).toBe(false);
  });

  test('the same file is never queued twice at once', async () => {
    settings.delete('attachment_naming_ws2');
    const row = addRow();
    const [first, second] = await Promise.all([svc.queueEmailAttachment(row, { email: email() }), svc.queueEmailAttachment(row, { email: email() })]);
    expect([first, second]).toEqual([true, false]);
  });

  test('a failing job keeps the original name and does not throw', async () => {
    bufferFor.mockRejectedValueOnce(new Error('blob gone'));
    const row = addRow();
    await expect(svc.queueEmailAttachment(row, { email: email() })).resolves.toBe(true);
    expect(rows[0].displayName).toBeNull();
  });
});

describe('catch-up after a restart', () => {
  const now = new Date('2026-11-24T18:00:00Z');

  test('queues unchecked e-mail documents from the last 48 hours in live workspaces only', async () => {
    settings.set('attachment_naming_ws5', 'off');
    const fresh = addRow({ id: 1, createdAt: new Date('2026-11-24T10:00:00Z'), uploadedBy: 'noreply@getbalance.com' });
    addRow({ id: 2, createdAt: new Date('2026-11-21T10:00:00Z') }); // too old
    addRow({ id: 3, createdAt: new Date('2026-11-24T10:00:00Z'), nameDetails: { outcome: 'no_vendor' } }); // already checked
    addRow({ id: 4, createdAt: new Date('2026-11-24T10:00:00Z'), nameSource: 'reverted' });
    addRow({ id: 5, createdAt: new Date('2026-11-24T10:00:00Z'), source: 'upload' });
    addRow({ id: 6, createdAt: new Date('2026-11-24T10:00:00Z'), fileName: 'logo.png', contentType: 'image/png' });
    addRow({ id: 7, createdAt: new Date('2026-11-24T10:00:00Z'), workspaceId: 5 }); // workspace off
    prismaMock.ticket.findUnique.mockResolvedValueOnce({ subject: 'New Invoice from Acme Supplies' });

    const out = await svc.catchUpRecentAttachments({ now });
    expect(out).toEqual({ workspaces: 1, found: 1, queued: 1 });
    await new Promise((r) => { setTimeout(r, 20); });
    expect(fresh.displayName).toBe('Acme Supplies_INV-100234_2026_11_24.pdf');
  });

  test('checked files are left out in the query itself; one billed failure is asked again, two are not', async () => {
    const when = new Date('2026-11-24T10:00:00Z');
    addRow({ id: 301, createdAt: when, nameDetails: { outcome: 'no_vendor' } });
    addRow({ id: 302, createdAt: when, nameDetails: { outcome: 'ai_failed', tries: 2 } });
    addRow({ id: 303, ticketId: 4003, createdAt: when, fileName: 'retry.pdf', nameDetails: { outcome: 'ai_failed', tries: 1, reason: 'refusal' } });
    addRow({ id: 304, ticketId: 4004, createdAt: when, fileName: 'fresh.pdf' });
    createMock.mockResolvedValue(aiReply({ vendor: 'Acme Supplies', invoiceNumber: null, documentDate: null, confidence: 'high' }));

    const out = await svc.catchUpRecentAttachments({ now });
    expect(out).toMatchObject({ found: 2, queued: 2 });
    const { where } = prismaMock.ticketAttachment.findMany.mock.calls[0][0];
    expect(where.OR[0]).toEqual({ nameDetails: { equals: Prisma.DbNull } });
    expect(where.OR[1].AND).toEqual([
      { nameDetails: { path: ['outcome'], equals: 'ai_failed' } },
      { nameDetails: { path: ['tries'], equals: 1 } },
    ]);
    await new Promise((r) => { setTimeout(r, 30); });
    expect(rows.find((r) => r.id === 303).displayName).toBe('Acme Supplies_2026_11_24.pdf');
    expect(rows.find((r) => r.id === 304).displayName).toBe('Acme Supplies_2026_11_24.pdf');
    expect(rows.find((r) => r.id === 302).displayName).toBeNull();
    createMock.mockReset();
  });

  test('bounded by the limit', async () => {
    settings.delete('attachment_naming_ws2');
    settings.set('attachment_naming_ws2', 'live');
    for (let n = 0; n < 8; n += 1) addRow({ id: 200 + n, ticketId: 3000 + n, createdAt: new Date('2026-11-24T10:00:00Z'), fileName: `x-${n}.pdf` });
    createMock.mockResolvedValue(aiReply({ vendor: null, invoiceNumber: null, documentDate: null, confidence: 'low' }));
    const out = await svc.catchUpRecentAttachments({ now, limit: 3 });
    expect(out).toMatchObject({ found: 3, queued: 3 });
    await new Promise((r) => { setTimeout(r, 30); });
    createMock.mockReset();
  });

  test('no live workspace → nothing read', async () => {
    settings.clear();
    expect(await svc.catchUpRecentAttachments({ now })).toEqual({ workspaces: 0, found: 0, queued: 0 });
    expect(prismaMock.ticketAttachment.findMany).not.toHaveBeenCalled();
  });
});

describe('Revert and Edit', () => {
  const actor = { email: 'dana.fox@ourco.example', name: 'Dana Fox' };

  test('revert puts the original back, keeps the details, writes a history row', async () => {
    const row = addRow({ displayName: 'Acme_INV-1_2026_11_23.pdf', nameSource: 'auto', nameDetails: { vendor: 'Acme', method: 'ai' } });
    const out = await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'revert', actor });
    expect(out).toMatchObject({ displayName: null, originalName: 'INV-100234.pdf', nameSource: 'reverted', nameDetails: { vendor: 'Acme' }, namedBy: 'Dana Fox' });
    expect(activities[0]).toMatchObject({ activityType: 'attachment_renamed', performedBy: 'Dana Fox' });
    expect(activities[0].details).toMatchObject({ action: 'revert', from: 'Acme_INV-1_2026_11_23.pdf', to: 'INV-100234.pdf', actorEmail: 'dana.fox@ourco.example' });
  });

  test('revert on a file with no new name changes nothing', async () => {
    const row = addRow();
    const out = await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'revert', actor });
    expect(out.nameSource).toBeNull();
    expect(activities).toHaveLength(0);
  });

  test('edit keeps the extension, writes history, and teaches the vendor list', async () => {
    const row = addRow({ uploadedBy: 'billing@acme.example' });
    const out = await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'edit', name: 'Acme Supplies_INV-100234.PDF', actor });
    expect(out).toMatchObject({ displayName: 'Acme Supplies_INV-100234.pdf', nameSource: 'manual', originalName: 'INV-100234.pdf' });
    expect(out.nameDetails).toMatchObject({ vendor: 'Acme Supplies', method: 'manual' });
    expect(activities[0].details).toMatchObject({ action: 'edit', from: 'INV-100234.pdf', to: 'Acme Supplies_INV-100234.pdf' });
    expect(JSON.parse(settings.get('attachment_vendor_aliases_ws2'))).toEqual({
      'acme.example': { vendor: 'Acme Supplies', learnedAt: expect.any(String), by: 'Dana Fox' },
    });

    // The next mail from that domain: Claude still reads it, agrees, and the people's spelling is kept.
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'ACME SUPPLIES LTD', invoiceNumber: 'INV-5', documentDate: null, confidence: 'high' }));
    const next = addRow({ fileName: 'INV-5.pdf' });
    const named = await svc.nameAttachment(next.id, { subject: 'x', fromEmail: 'ar@acme.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(createMock).toHaveBeenCalledTimes(1);
    expect(named.name).toBe('Acme Supplies_INV-5_2026_11_23.pdf');
    expect(rows[1].nameDetails.vendorFrom).toBe('vendor_list');
  });

  test('edits that are not in the Vendor_<number> shape teach nothing', async () => {
    for (const name of ['Signed_W9', 'Copy_of_invoice', 'Scanned_2026_11_23', 'OurCo_12']) {
      const row = addRow({ uploadedBy: 'billing@acme.example' });
      await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'edit', name, actor });
    }
    expect(settings.has('attachment_vendor_aliases_ws2')).toBe(false);
  });

  test('a high-confidence Claude vendor beats a learned entry that disagrees; a medium one does not', async () => {
    settings.set('attachment_vendor_aliases_ws2', JSON.stringify({ 'acme.example': { vendor: 'Signed', learnedAt: '2026-11-20T00:00:00Z', by: 'Eli Park' } }));
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Acme Supplies', invoiceNumber: 'INV-6', documentDate: null, confidence: 'high' }));
    const a = addRow({ fileName: 'INV-6.pdf' });
    expect((await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@acme.example', receivedAt: new Date('2026-11-23T18:00:00Z') })).name)
      .toBe('Acme Supplies_INV-6_2026_11_23.pdf');
    expect(rows[0].nameDetails.vendorFrom).toBe('ai');

    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Northwind Traders', invoiceNumber: 'INV-7', documentDate: null, confidence: 'medium' }));
    const b = addRow({ fileName: 'INV-7.pdf' });
    expect((await svc.nameAttachment(b.id, { subject: 'x', fromEmail: 'ar@acme.example', receivedAt: new Date('2026-11-23T18:00:00Z') })).name)
      .toBe('Signed_INV-7_2026_11_23.pdf');
  });

  test('reverting a name that came from the vendor list removes that entry', async () => {
    settings.set('attachment_vendor_aliases_ws2', JSON.stringify({
      'acme.example': { vendor: 'Acme Supplies', learnedAt: '2026-11-20T00:00:00Z', by: 'Eli Park' },
      'northwind.example': { vendor: 'Northwind Traders', learnedAt: '2026-11-20T00:00:00Z', by: 'Eli Park' },
    }));
    createMock.mockResolvedValueOnce(aiReply({ vendor: null, invoiceNumber: 'INV-8', documentDate: null, confidence: 'medium' }));
    const row = addRow({ fileName: 'INV-8.pdf' });
    await svc.nameAttachment(row.id, { subject: 'x', fromEmail: 'ar@mail.acme.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(rows[0]).toMatchObject({ displayName: 'Acme Supplies_INV-8_2026_11_23.pdf', nameDetails: { vendorFrom: 'vendor_list', senderDomain: 'mail.acme.example' } });

    await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'revert', actor });
    expect(Object.keys(JSON.parse(settings.get('attachment_vendor_aliases_ws2')))).toEqual(['northwind.example']);
  });

  test('a name that is not text is a 400', async () => {
    const row = addRow();
    for (const name of [42, null, ['Acme'], { a: 1 }]) {
      await expect(svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'edit', name, actor }))
        .rejects.toMatchObject({ statusCode: 400 });
    }
  });

  test('edit never teaches internal, free-mail or platform domains', async () => {
    for (const uploadedBy of ['eli.park@ourco.example', 'someone@gmail.com', 'noreply@getbalance.com']) {
      const row = addRow({ uploadedBy });
      await svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'edit', name: 'Acme Supplies_1', actor });
    }
    expect(settings.has('attachment_vendor_aliases_ws2')).toBe(false);
  });

  test('edit to a name another file has gets " (2)"; an empty name is refused', async () => {
    addRow({ id: 70, fileName: 'Acme_1.pdf' });
    const row = addRow({ id: 71 });
    const out = await svc.applyManualName({ ticketId: 1042, attachmentId: 71, workspaceId: 2, action: 'edit', name: 'Acme_1', actor });
    expect(out.displayName).toBe('Acme_1 (2).pdf');
    await expect(svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'edit', name: ' ', actor }))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  test('another ticket\'s attachment, or another workspace\'s, is a 404', async () => {
    const row = addRow({ ticketId: 999 });
    await expect(svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'revert', actor })).rejects.toMatchObject({ statusCode: 404 });
    const other = addRow({ workspaceId: 3 });
    await expect(svc.applyManualName({ ticketId: 1042, attachmentId: other.id, workspaceId: 2, action: 'revert', actor })).rejects.toMatchObject({ statusCode: 404 });
  });

  test('an unknown action is a 400', async () => {
    const row = addRow();
    await expect(svc.applyManualName({ ticketId: 1042, attachmentId: row.id, workspaceId: 2, action: 'delete', actor })).rejects.toMatchObject({ statusCode: 400 });
  });
});
