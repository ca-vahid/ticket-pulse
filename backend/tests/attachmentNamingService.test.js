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
  return row[k] === v;
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
class Anthropic { constructor() { this.messages = { create: createMock }; } }
Anthropic.APIError = APIError;
Anthropic.RateLimitError = RateLimitError;
Anthropic.APIConnectionError = APIConnectionError;
jest.unstable_mockModule('@anthropic-ai/sdk', () => ({ default: Anthropic, APIError, RateLimitError, APIConnectionError }));

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
  test('request shape: model from settings, structured output, low effort, no thinking, PDF before the text', async () => {
    settings.set('attachment_naming_model', 'claude-test-model');
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Acme Supplies', invoiceNumber: 'INV-100234', documentDate: '2026-11-20', confidence: 'high' }));
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: email().subject, fromEmail: email().from, fromName: 'Dana Fox', receivedAt: email().receivedAt });

    expect(out).toEqual({ renamed: true, name: 'Acme Supplies_INV-100234_2026_11_20.pdf' });
    const req = createMock.mock.calls[0][0];
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
    expect(out).toEqual({ renamed: false, reason: 'no_vendor' });
    expect(rows[0].displayName).toBeNull();
  });

  test('a refusal with no rules vendor → no rename, original name stays', async () => {
    createMock.mockResolvedValueOnce({ stop_reason: 'refusal', content: [], usage: {} });
    const row = addRow();
    const out = await svc.nameAttachment(row.id, { subject: 'Invoice attached', fromEmail: 'ar@vendor.example' });
    expect(out).toEqual({ renamed: false, reason: 'no_vendor' });
    expect(rows[0].nameSource).toBeNull();
    expect(activities).toHaveLength(0);
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
    expect(await svc.nameAttachment(a.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).toEqual({ renamed: false, reason: 'no_vendor' });
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

  test('low confidence and no rules vendor → no rename', async () => {
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'Maybe Acme', invoiceNumber: '991', documentDate: '2026-11-01', confidence: 'low' }));
    const row = addRow();
    expect(await svc.nameAttachment(row.id, { subject: 'x', fromEmail: 'ar@vendor.example' })).toEqual({ renamed: false, reason: 'no_vendor' });
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
  const instacartLike = () => email({ subject: 'New Invoice from Acme Supplies', from: 'noreply@getbalance.com' });

  test('Accounting live → named in the background', async () => {
    const row = addRow({ uploadedBy: 'noreply@getbalance.com' });
    expect(await svc.queueEmailAttachment(row, { email: instacartLike() })).toBe(true);
    expect(rows[0].displayName).toBe('Acme Supplies_INV-100234_2026_11_23.pdf');
  });

  test('a workspace that is off (the default) is left alone', async () => {
    settings.delete('attachment_naming_ws2');
    const row = addRow({ uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: instacartLike() });
    expect(rows[0].displayName).toBeNull();
    expect(prismaMock.ticketAttachment.updateMany).not.toHaveBeenCalled();
  });

  test('another workspace without its own switch is left alone', async () => {
    const row = addRow({ workspaceId: 1, uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: instacartLike() });
    expect(rows[0].displayName).toBeNull();
  });

  test('agent uploads and FreshService files are never queued', async () => {
    expect(await svc.queueEmailAttachment(addRow({ source: 'upload' }), { email: instacartLike() })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ source: 'freshservice' }), { email: instacartLike() })).toBe(false);
    expect(prismaMock.ticketAttachment.findUnique).not.toHaveBeenCalled();
  });

  test('inline images are skipped', async () => {
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'picture-1-ABC-image.png', contentType: 'image/png' }), { email: instacartLike(), isInline: true })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'logo.png', contentType: 'image/png' }), { email: instacartLike() })).toBe(false);
    expect(await svc.queueEmailAttachment(addRow({ fileName: 'scan.pdf' }), { email: instacartLike(), isInline: true })).toBe(false);
  });

  test('a file someone already named or reverted is never renamed', async () => {
    const row = addRow({ nameSource: 'reverted', uploadedBy: 'noreply@getbalance.com' });
    await svc.queueEmailAttachment(row, { email: instacartLike() });
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

  test('a failing job keeps the original name and does not throw', async () => {
    bufferFor.mockRejectedValueOnce(new Error('blob gone'));
    const row = addRow();
    await expect(svc.queueEmailAttachment(row, { email: email() })).resolves.toBe(true);
    expect(rows[0].displayName).toBeNull();
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
    expect(JSON.parse(settings.get('attachment_vendor_aliases_ws2'))).toEqual({ 'acme.example': 'Acme Supplies' });

    // The next mail from that domain uses the taught name with no Claude call needed for the vendor.
    createMock.mockResolvedValueOnce(aiReply({ vendor: 'ACME SUPPLIES LTD', invoiceNumber: 'INV-5', documentDate: null, confidence: 'high' }));
    const next = addRow({ fileName: 'INV-5.pdf' });
    const named = await svc.nameAttachment(next.id, { subject: 'x', fromEmail: 'ar@acme.example', receivedAt: new Date('2026-11-23T18:00:00Z') });
    expect(named.name).toBe('Acme Supplies_INV-5_2026_11_23.pdf');
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
