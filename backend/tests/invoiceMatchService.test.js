/**
 * Invoice-number matching for mail (24 Nov 2026): the matcher, the Shadow
 * record and the Shadow report. Every vendor, address and number is invented.
 */
import { jest } from '@jest/globals';

const settings = new Map();
const prismaMock = {
  $queryRawUnsafe: jest.fn(),
  $executeRawUnsafe: jest.fn(),
  workspace: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), update: jest.fn(), create: jest.fn() },
  ticketAttachment: { findMany: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  mailboxHeldMessage: { findFirst: jest.fn(), update: jest.fn() },
};
const statusMock = {
  resolveBaseStatus: jest.fn(async (_ws, name) => (/closed|done/i.test(name) ? 'Closed' : /resolved/i.test(name) ? 'Resolved' : 'Open')),
  statusNamesForBase: jest.fn(async () => ['Done - paid']),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { get: jest.fn(async (k) => (settings.has(k) ? settings.get(k) : null)), set: jest.fn(async (k, v) => { settings.set(k, String(v)); }) },
}));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: statusMock }));
// Graph's attachment list: a chain whose get() the test controls.
const graphGet = jest.fn();
const graphChain = { select: () => graphChain, top: () => graphChain, get: graphGet };
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { _getClient: () => ({ api: () => graphChain }) } }));

const svc = await import('../src/services/invoiceMatchService.js');
const {
  findInvoiceMatches, invoicePairs, normaliseInvoiceNumber, normaliseVendor, vendorsMatch, writtenAsAccount,
  recordAfterIntake, shadowReport, getMode, setMode, normalizeMode, settingsKey, _clearModeCache, WINDOW_DAYS, COMMON_NUMBER_TICKETS,
  invoiceCore, agreement, buildRecord, queueRecordAfterIntake, _queueStateForTests, QUEUE_MAX_WAITING, attachmentNamesFor,
} = svc;

const WS = 2;
const NOW = Date.parse('2026-11-24T18:00:00Z');
const VENDOR_FROM = 'billing@acme-supplies.example';
const connection = { id: 6, workspaceId: WS, address: 'ap-tickets@example.com' };

/** A document row as the lookup returns it (ticket + attachment). */
const doc = (over = {}, details = {}) => ({
  attachmentId: 300, ticketId: 880, status: 'Open', origin: 'ticketpulse', nativeNumber: 2040, freshserviceTicketId: null, createdAt: new Date(NOW - 5 * 86400000),
  ...over,
  nameDetails: { vendor: 'ACME SUPPLIES', invoiceNumber: 'INV-20417', senderDomain: 'acme-supplies.example', method: 'rules', confidence: 'high', ...details },
});
const match = (input = {}) => findInvoiceMatches({ workspaceId: WS, subject: 'Invoice INV-20417 from Acme Supplies Ltd', fromEmail: VENDOR_FROM, now: NOW, ...input });

beforeEach(() => {
  jest.clearAllMocks();
  settings.clear();
  _clearModeCache();
  prismaMock.workspace.findUnique.mockResolvedValue({ internalDomains: ['example.com'] });
  prismaMock.$queryRawUnsafe.mockResolvedValue([]);
  prismaMock.$executeRawUnsafe.mockResolvedValue(1);
});

// ------------------------------------------------------------------ the rules
describe('normalisation', () => {
  test('invoice numbers: uppercase, letters and digits only; short, years, dates, project and account numbers are not numbers', () => {
    expect(normaliseInvoiceNumber('inv-20417')).toBe('INV20417');
    expect(normaliseInvoiceNumber('2-756-67291')).toBe('275667291');
    expect(normaliseInvoiceNumber('A12')).toBeNull(); // short
    expect(normaliseInvoiceNumber('123')).toBeNull();
    expect(normaliseInvoiceNumber('2026')).toBeNull(); // a year
    expect(normaliseInvoiceNumber('20261110')).toBeNull(); // a date
    expect(normaliseInvoiceNumber('2000010.02.11')).toBeNull(); // a project number
    expect(normaliseInvoiceNumber('2000010', 'Invoice 2000010 for project 2000010.02')).toBeNull();
    expect(normaliseInvoiceNumber('40021', 'Acme Supplies statement - Account #40021')).toBeNull();
    expect(writtenAsAccount('Acct No: 40021', '40021')).toBe(true);
    expect(writtenAsAccount('Invoice 40021', '40021')).toBe(false);
  });

  test('vendors: punctuation and Inc/Ltd/LLC/Corp/Co/ULC go; equal, or the shorter (5+ characters) is the longer one’s first words', () => {
    expect(normaliseVendor('Acme Supplies, Ltd.')).toBe('acmesupplies');
    expect(normaliseVendor('Northwind Traders Co. ULC')).toBe('northwindtraders');
    expect(vendorsMatch('Acme Supplies Ltd', 'ACME SUPPLIES')).toBe(true);
    expect(vendorsMatch('Northwind Traders Canada', 'Northwind Traders Inc')).toBe(true);
    expect(vendorsMatch('Acme', 'Acme Supplies')).toBe(false); // the shorter is 4 characters
    expect(vendorsMatch('Acme Supplies', 'Northwind Traders')).toBe(false);
    expect(vendorsMatch(null, 'Acme Supplies')).toBe(false);
  });

  test('leading zeros go on both sides; the core is the number without its letter prefix', () => {
    expect(normaliseInvoiceNumber('INV-0020417')).toBe('INV20417');
    expect(normaliseInvoiceNumber('0042117')).toBe('42117');
    expect(normaliseInvoiceNumber('000123')).toBeNull(); // 123: too short once the zeros go
    expect(invoiceCore('INV20417')).toBe('20417');
    expect(invoiceCore('20417')).toBe('20417');
  });

  test('vendors match by whole words only: a name is never a part of a longer word', () => {
    expect(vendorsMatch('Canon', 'Canonical')).toBe(false);
    expect(vendorsMatch('Canon Canada', 'Canon')).toBe(true);
    expect(vendorsMatch('Northwind', 'Northwind Traders')).toBe(true);
    expect(vendorsMatch('Traders', 'Northwind Traders')).toBe(false); // not the first words
  });

  test('pairs come from the subject and each attachment name, by the rules only', () => {
    const pairs = invoicePairs({
      subject: 'Documents from Acme Supplies', fromEmail: VENDOR_FROM,
      attachmentNames: ['Invoice_20417_from_Acme_Supplies.pdf', 'logo.png', 'INV-30552.pdf'],
      internalDomains: ['example.com'],
    });
    expect(pairs.map((p) => p.key)).toEqual(['20417', 'INV30552']);
    expect(pairs[0]).toMatchObject({ vendor: 'Acme Supplies', from: 'file', senderDomain: 'acme-supplies.example' });
  });

  test('the mode setting: off by default, off | shadow | live, plain or JSON', async () => {
    expect(settingsKey(4)).toBe('invoice_match_ws4');
    expect(await getMode(WS)).toBe('off');
    expect(normalizeMode('Shadow')).toBe('shadow');
    expect(normalizeMode('{"mode":"live"}')).toBe('live');
    expect(normalizeMode('on')).toBe('off');
    await setMode(WS, 'shadow');
    expect(settings.get('invoice_match_ws2')).toBe('shadow');
    expect(await getMode(WS)).toBe('shadow');
    await expect(setMode(WS, 'on')).rejects.toThrow('Pick Off, Shadow or Live');
  });
});

// ------------------------------------------------------------------ the matcher
describe('the matcher', () => {
  test('the same invoice from the same vendor on an open ticket matches', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc()]);
    expect(await match()).toEqual([{ ticketId: 880, displayRef: 'TP-2040', vendor: 'ACME SUPPLIES', invoiceNumber: 'INV-20417', attachmentId: 300, matchedBy: 'vendor' }]);
    const [sql, ws, since, notOpen, keys, exAtt, exTickets] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sql).toMatch(/JOIN ticket_attachments a ON a\.ticket_id = t\.id/);
    expect(sql).toMatch(/a\.name_details IS NOT NULL/);
    expect(sql).toMatch(/LIMIT 200/);
    expect(ws).toBe(WS);
    expect(since).toEqual(new Date(NOW - WINDOW_DAYS * 86400000));
    // Custom closed names too, in SQL, before the LIMIT.
    expect(notOpen).toEqual(['Resolved', 'Closed', 'Deleted', 'Spam', 'Done - paid']);
    expect(statusMock.statusNamesForBase).toHaveBeenCalledWith(WS, ['Resolved', 'Closed']);
    expect(sql).toMatch(/ORDER BY t\.created_at DESC/);
    expect(keys).toEqual(['20417']); // the number part; the prefix is decided in code
    expect(exAtt).toEqual([]);
    expect(exTickets).toEqual([]);
  });

  test('the same number from a different vendor does not match', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { vendor: 'Northwind Traders', senderDomain: 'northwind.example' })]);
    expect(await match()).toEqual([]);
  });

  test('no vendor in the mail: the same sender domain on the document matches; a billing platform or free-mail domain never does', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc()]);
    const viaDomain = await match({ subject: 'Documents attached', fromName: 'Dana Fox', attachmentNames: ['INV-20417.pdf'] });
    expect(viaDomain).toEqual([expect.objectContaining({ ticketId: 880, matchedBy: 'sender_domain' })]);

    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { vendor: null, senderDomain: 'quickbooks.com' })]);
    expect(await match({ subject: 'Documents attached', fromEmail: 'notify@quickbooks.com', attachmentNames: ['INV-20417.pdf'] })).toEqual([]);
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { vendor: null, senderDomain: 'gmail.com' })]);
    expect(await match({ subject: 'Documents attached', fromEmail: 'dana.fox@gmail.com', attachmentNames: ['INV-20417.pdf'] })).toEqual([]);
  });

  test('both sides name a vendor and the names differ: no match, even from the same sender domain', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { vendor: 'Northwind Traders', senderDomain: 'acme-supplies.example' })]);
    expect(await match()).toEqual([]);
  });

  test('"INV-20417" and "20417" are one document only for exactly the same vendor name', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '20417', vendor: 'Acme Supplies' })]);
    expect(await match()).toEqual([expect.objectContaining({ ticketId: 880, matchedBy: 'vendor_exact' })]);
    // Only word-alike, or only the same sender domain: no.
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '20417', vendor: 'Acme Supplies Canada' })]);
    expect(await match()).toEqual([]);
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '20417', vendor: null })]);
    expect(await match()).toEqual([]);
    // Leading zeros only: the same number.
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: 'INV-0020417' })]);
    expect(await match()).toEqual([expect.objectContaining({ ticketId: 880, matchedBy: 'vendor' })]);
  });

  test('a project number is not an invoice number: nothing is looked up', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '2000010' })]);
    expect(await match({ subject: 'Invoice 2000010.02.11 from Acme Supplies' })).toEqual([]);
    expect(await match({ subject: 'Acme Supplies', attachmentNames: ['Acme Supplies Invoice 2000010.02.11.pdf'] })).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('an account number is not an invoice number: nothing is looked up', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '40021' })]);
    expect(await match({ subject: 'Acme Supplies statement - Account #40021' })).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('a number on documents of many open tickets is an account number: no match', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue(Array.from({ length: COMMON_NUMBER_TICKETS }, (_, i) => doc({ ticketId: 900 + i, attachmentId: 400 + i, nativeNumber: 3000 + i })));
    expect(await match()).toEqual([]);
  });

  test('a short number never matches', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({}, { invoiceNumber: '123' })]);
    expect(await match({ subject: 'Invoice 123 from Acme Supplies' })).toEqual([]);
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
  });

  test('a closed ticket does not match (closed by name in the query, by its base status here)', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({ status: 'Done - paid' })]);
    expect(await match()).toEqual([]);
    expect(statusMock.resolveBaseStatus).toHaveBeenCalledWith(WS, 'Done - paid');
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][3]).toEqual(expect.arrayContaining(['Closed', 'Resolved', 'Done - paid']));
  });

  test('one match per ticket, newest first, a FreshService ticket by its number; a failed lookup is no match', async () => {
    prismaMock.$queryRawUnsafe.mockResolvedValue([
      doc({ ticketId: 881, attachmentId: 301, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 251107n }),
      doc({ ticketId: 881, attachmentId: 302, origin: 'freshservice', nativeNumber: null, freshserviceTicketId: 251107n }),
      doc(),
    ]);
    expect((await match()).map((m) => [m.ticketId, m.displayRef, m.attachmentId])).toEqual([[881, '#251107', 301], [880, 'TP-2040', 300]]);
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    expect(await match()).toEqual([]);
  });
});

// ------------------------------------------------------------------ Shadow
describe('Shadow: the record beside the mail, nothing else', () => {
  const email = (over = {}) => ({
    id: 'g-1', subject: 'Invoice INV-20417 from Acme Supplies Ltd', from: VENDOR_FROM, fromName: 'Acme Supplies Billing',
    internetMessageId: '<m-1@acme-supplies.example>', hasAttachments: true, bodyText: 'Please find attached.', ...over,
  });
  const written = () => {
    const [sql, json, id] = prismaMock.$executeRawUnsafe.mock.calls[0];
    return { sql, record: JSON.parse(json), id };
  };
  const noOtherWrites = () => {
    for (const fn of [prismaMock.ticket.update, prismaMock.ticket.create, prismaMock.ticketThreadEntry.update, prismaMock.ticketThreadEntry.create,
      prismaMock.ticketAttachment.update, prismaMock.ticketAttachment.updateMany, prismaMock.mailboxHeldMessage.update]) expect(fn).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    settings.set('invoice_match_ws2', 'shadow');
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ id: 501, ticketId: 950 }]);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 950, origin: 'ticketpulse', nativeNumber: 3100, freshserviceTicketId: null });
    prismaMock.ticketAttachment.findMany.mockResolvedValue([{ id: 77, fileName: 'Invoice_INV-20417_from_Acme_Supplies.pdf' }]);
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc()]);
  });

  test('a new ticket: the would-have and the actual on the mail’s thread entry; its own ticket and files never match', async () => {
    const record = await recordAfterIntake(connection, email(), 'created', { now: NOW });
    expect(record).toMatchObject({ mode: 'shadow', wouldHave: 'attach_to TP-2040', actual: 'new_ticket', actualTicketId: 950, agrees: false });
    expect(record.matches).toEqual([expect.objectContaining({ ticketId: 880, displayRef: 'TP-2040', invoiceNumber: 'INV-20417', attachmentId: 300 })]);
    const { sql, record: stored, id } = written();
    expect(sql).toMatch(/UPDATE ticket_thread_entries/);
    expect(sql).toMatch(/jsonb_build_object\('invoiceMatch'/);
    expect(id).toBe(501);
    expect(stored).toMatchObject({ mode: 'shadow', wouldHave: 'attach_to TP-2040', actual: 'new_ticket' });
    const lookup = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(lookup[5]).toEqual([77]); // this mail's files
    expect(lookup[6]).toEqual([950]); // the ticket it made
    expect(prismaMock.ticketThreadEntry.findMany.mock.calls[0][0].where).toEqual({ workspaceId: WS, emailMessageId: '<m-1@acme-supplies.example>' });
    noOtherWrites();
  });

  test('a reply to the matching ticket agrees', async () => {
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ id: 502, ticketId: 880 }]);
    prismaMock.ticket.findFirst.mockResolvedValue({ id: 880, origin: 'ticketpulse', nativeNumber: 2040, freshserviceTicketId: null });
    prismaMock.$queryRawUnsafe.mockResolvedValue([doc({ attachmentId: 299 })]);
    const record = await recordAfterIntake(connection, email(), 'reply', { now: NOW });
    expect(record).toMatchObject({ actual: 'reply_to TP-2040', wouldHave: 'attach_to TP-2040', agrees: true });
    expect(prismaMock.$queryRawUnsafe.mock.calls[0][6]).toEqual([]); // a reply's ticket may be the match
    noOtherWrites();
  });

  test('no number, no match: "nothing", and a new ticket agrees', async () => {
    prismaMock.ticketAttachment.findMany.mockResolvedValue([]);
    const record = await recordAfterIntake(connection, email({ subject: 'Printer jammed again' }), 'created', { now: NOW });
    expect(record).toMatchObject({ matches: [], wouldHave: 'nothing', actual: 'new_ticket', agrees: true, pairs: [] });
    expect(prismaMock.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(written().id).toBe(501);
  });

  test('held mail: the record goes on the held row’s decision JSON', async () => {
    prismaMock.mailboxHeldMessage.findFirst.mockResolvedValue({ id: 31 });
    const record = await recordAfterIntake(connection, email({ subject: 'FW: Documents' }), 'held', { attachmentNames: ['INV-20417.pdf'], now: NOW });
    expect(record).toMatchObject({ actual: 'held', wouldHave: 'attach_to TP-2040', agrees: null, attachmentNames: ['INV-20417.pdf'] });
    const { sql, id } = written();
    expect(sql).toMatch(/UPDATE mailbox_held_messages/);
    expect(sql).toMatch(/SET decision = /);
    expect(id).toBe(31);
    expect(prismaMock.mailboxHeldMessage.findFirst.mock.calls[0][0].where).toEqual({ connectionId: 6, internetMessageId: '<m-1@acme-supplies.example>' });
    noOtherWrites();
  });

  test('a failed lookup keeps the pairs and says so: "lookup_failed", never "nothing", and no verdict', async () => {
    prismaMock.$queryRawUnsafe.mockRejectedValue(new Error('db down'));
    const record = await recordAfterIntake(connection, email(), 'created', { now: NOW });
    expect(record).toMatchObject({ matches: [], wouldHave: 'lookup_failed', error: 'db down', agrees: null, liveWouldAct: false });
    expect(record.pairs).toEqual([expect.objectContaining({ invoiceNumber: 'INV-20417' })]);
    expect(JSON.parse(prismaMock.$executeRawUnsafe.mock.calls[0][1])).toMatchObject({ wouldHave: 'lookup_failed', error: 'db down' });
  });

  test('intakeKind and liveWouldAct: true only on a path Live checks AND with a match', async () => {
    const eligible = await recordAfterIntake(connection, email(), 'created', { now: NOW, intakeKind: 'fresh', liveEligible: true });
    expect(eligible).toMatchObject({ intakeKind: 'fresh', liveWouldAct: true, wouldHave: 'attach_to TP-2040' });
    const notChecked = await recordAfterIntake(connection, email(), 'created', { now: NOW, intakeKind: 'forward', liveEligible: false });
    expect(notChecked).toMatchObject({ intakeKind: 'forward', liveWouldAct: false, wouldHave: 'attach_to TP-2040' });
    prismaMock.$queryRawUnsafe.mockResolvedValue([]);
    const noMatch = await recordAfterIntake(connection, email(), 'created', { now: NOW, intakeKind: 'fresh', liveEligible: true });
    expect(noMatch).toMatchObject({ liveWouldAct: false, wouldHave: 'nothing' });
  });

  test('a reply agrees when its ticket is ANY of the matches, not only the newest', () => {
    const matches = [{ ticketId: 881, displayRef: '#251107' }, { ticketId: 880, displayRef: 'TP-2040' }];
    expect(agreement({ actual: 'reply_to TP-2040', actualTicketId: 880, matches, wouldHave: 'attach_to #251107' })).toBe(true);
    expect(agreement({ actual: 'reply_to TP-9', actualTicketId: 9, matches, wouldHave: 'attach_to #251107' })).toBe(false);
    expect(buildRecord({ mode: 'shadow', matches, actual: 'reply_to TP-2040', actualTicketId: 880 })).toMatchObject({ wouldHave: 'attach_to #251107', agrees: true });
  });

  test('a threaded reply with no invoice match neither agrees nor disagrees', () => {
    expect(agreement({ actual: 'reply_to TP-9', actualTicketId: 9, matches: [] })).toBeNull();
    expect(agreement({ actual: 'new_ticket', matches: [] })).toBe(true);
  });

  test('off (the default) does nothing at all; skipped mail is never recorded', async () => {
    settings.set('invoice_match_ws2', 'off');
    expect(await recordAfterIntake(connection, email(), 'created', { now: NOW })).toBeNull();
    _clearModeCache();
    settings.set('invoice_match_ws2', 'shadow');
    expect(await recordAfterIntake(connection, email(), 'skipped', { now: NOW })).toBeNull();
    expect(prismaMock.ticketThreadEntry.findMany).not.toHaveBeenCalled();
    expect(prismaMock.$executeRawUnsafe).not.toHaveBeenCalled();
  });

  test('never throws: a failed read or write is no record', async () => {
    prismaMock.ticketThreadEntry.findMany.mockRejectedValue(new Error('db down'));
    await expect(recordAfterIntake(connection, email(), 'created', { now: NOW })).resolves.toBeNull();
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([{ id: 501, ticketId: 950 }]);
    prismaMock.$executeRawUnsafe.mockRejectedValue(new Error('write failed'));
    await expect(recordAfterIntake(connection, email(), 'created', { now: NOW })).resolves.toBeNull();
    await expect(recordAfterIntake(null, null, 'created')).resolves.toBeNull();
  });
});

// ------------------------------------------------------------------ the queue
describe('the after-intake queue', () => {
  test('at most 2 run at a time, at most 200 wait; a full queue drops the job, never throws', async () => {
    settings.set('invoice_match_ws2', 'shadow');
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    prismaMock.ticketThreadEntry.findMany.mockImplementation(async () => { await gate; return []; });
    const mail = { subject: 'Printer jammed', from: 'rita@example.com', internetMessageId: '<q@example.com>' };
    const jobs = Array.from({ length: QUEUE_MAX_WAITING + 5 }, () => queueRecordAfterIntake(connection, mail, 'created'));
    await new Promise((r) => setImmediate(r));
    expect(_queueStateForTests()).toEqual({ running: 2, waiting: QUEUE_MAX_WAITING });
    // The last three found the queue full: settled at once with null.
    await expect(Promise.race([jobs[jobs.length - 1], new Promise((r) => setTimeout(() => r('pending'), 20))])).resolves.toBeNull();
    expect(await queueRecordAfterIntake(connection, mail, 'skipped')).toBeNull();
    release();
    await Promise.all(jobs);
    expect(_queueStateForTests()).toEqual({ running: 0, waiting: 0 });
    expect(prismaMock.ticketThreadEntry.findMany).toHaveBeenCalledTimes(QUEUE_MAX_WAITING + 2);
  });
});

describe('file names for the Live check', () => {
  test('the names in the mail payload are used as they are; no Graph read', async () => {
    expect(await attachmentNamesFor(connection, { attachmentNames: ['INV-20417.pdf'], hasAttachments: true, id: 'g' }, { timeoutMs: 2000 })).toEqual(['INV-20417.pdf']);
    expect(await attachmentNamesFor(connection, { attachments: [{ name: 'INV-20417.pdf', contentType: 'application/pdf' }, { name: 'logo.png' }], hasAttachments: true, id: 'g' })).toEqual(['INV-20417.pdf']);
    expect(await attachmentNamesFor(connection, { hasAttachments: false })).toEqual([]);
    expect(graphGet).not.toHaveBeenCalled();
  });

  test('otherwise one Graph metadata read, given up after the cap (2 s in Live): no names, no error', async () => {
    graphGet.mockResolvedValueOnce({ value: [{ name: 'INV-20417.pdf', contentType: 'application/pdf' }, { name: 'image001.png', contentType: 'image/png' }] });
    expect(await attachmentNamesFor(connection, { hasAttachments: true, id: 'g-1' }, { timeoutMs: 2000 })).toEqual(['INV-20417.pdf']);
    graphGet.mockReturnValueOnce(new Promise(() => {}));
    const started = Date.now();
    expect(await attachmentNamesFor(connection, { hasAttachments: true, id: 'g-2' }, { timeoutMs: 30 })).toEqual([]);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});

// ------------------------------------------------------------------ the report
describe('the Shadow report', () => {
  test('filed and held mail, newest first, with what actually happened and a tally', async () => {
    settings.set('invoice_match_ws2', 'shadow');
    const m = [{ ticketId: 880, displayRef: 'TP-2040', vendor: 'ACME SUPPLIES', invoiceNumber: 'INV-20417', attachmentId: 300 }];
    prismaMock.$queryRawUnsafe
      .mockResolvedValueOnce([
        { id: 501, ticketId: 950, at: new Date('2026-11-24T17:00:00Z'), fromEmail: VENDOR_FROM, subject: 'Invoice INV-20417 from Acme Supplies', status: 'Open', origin: 'ticketpulse', nativeNumber: 3100, freshserviceTicketId: null,
          invoiceMatch: { mode: 'shadow', matches: m, wouldHave: 'attach_to TP-2040', actual: 'new_ticket', agrees: false, pairs: [{ invoiceNumber: 'INV-20417' }] } },
        { id: 502, ticketId: 951, at: new Date('2026-11-24T15:00:00Z'), fromEmail: 'rita@example.com', subject: 'Printer jammed', status: 'Open', origin: 'ticketpulse', nativeNumber: 3101, freshserviceTicketId: null,
          invoiceMatch: { mode: 'shadow', matches: [], wouldHave: 'nothing', actual: 'new_ticket', agrees: true, pairs: [] } },
        { id: 503, ticketId: 952, at: new Date('2026-11-24T14:00:00Z'), fromEmail: VENDOR_FROM, subject: 'Invoice INV-30552 from Acme Supplies', status: 'Open', origin: 'ticketpulse', nativeNumber: 3102, freshserviceTicketId: null,
          invoiceMatch: { mode: 'shadow', matches: [], wouldHave: 'lookup_failed', actual: 'new_ticket', agrees: null, error: 'db down', pairs: [{ invoiceNumber: 'INV-30552' }] } },
      ])
      .mockResolvedValueOnce([
        { id: 31, at: new Date('2026-11-24T16:00:00Z'), fromEmail: 'sam.ortiz@example.com', subject: 'FW: Documents', reason: 'possible_follow_up', status: 'attached', resolvedTicketId: 880, resolvedBy: 'lead@example.com',
          invoiceMatch: { mode: 'shadow', matches: m, wouldHave: 'attach_to TP-2040', actual: 'held', agrees: null, liveWouldAct: true, pairs: [{ invoiceNumber: 'INV-20417' }] } },
      ]);
    prismaMock.ticket.findMany.mockResolvedValue([{ id: 880, origin: 'ticketpulse', nativeNumber: 2040, freshserviceTicketId: null }]);
    const report = await shadowReport(WS, { days: 7 });
    expect(report.days).toBe(7);
    expect(report.mode).toBe('shadow');
    expect(report.rows.map((r) => r.kind)).toEqual(['filed', 'held', 'filed', 'filed']);
    expect(report.rows[0]).toMatchObject({ ticket: { id: 950, displayRef: 'TP-3100' }, wouldHave: 'attach_to TP-2040', actual: 'new_ticket' });
    expect(report.rows[1]).toMatchObject({ heldId: 31, finally: 'attached to TP-2040', resolvedBy: 'lead@example.com' });
    expect(report.summary).toEqual({ total: 4, withNumber: 3, withMatch: 2, liveWouldAct: 1, failed: 1, agree: 1, disagree: 1, matchButNewTicket: 1, matchButOtherTicket: 0, held: 1, heldWithMatch: 1 });
    expect(report.rows[3]).toMatchObject({ wouldHave: 'lookup_failed', error: 'db down' });
    const [sqlEntries, ws, since] = prismaMock.$queryRawUnsafe.mock.calls[0];
    expect(sqlEntries).toMatch(/raw_payload->'invoiceMatch' IS NOT NULL/);
    expect(ws).toBe(WS);
    expect(Date.now() - since.getTime()).toBeGreaterThanOrEqual(7 * 86400000 - 1000);
    expect(prismaMock.$queryRawUnsafe.mock.calls[1][0]).toMatch(/decision->'invoiceMatch' IS NOT NULL/);
  });

  test('days is kept between 1 and 30', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([]);
    expect((await shadowReport(WS, { days: 400 })).days).toBe(30);
    expect((await shadowReport(WS, { days: 0 })).days).toBe(7);
  });
});
