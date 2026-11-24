/**
 * Invoice-number matching for mail (24 Nov 2026), Live: a match is a HARD link
 * in the follow-up finder and among Mail triage's candidates, so a held mail can
 * be attached at "sure". The existing guards still win. The matcher is stood in
 * for (tests/invoiceMatchService.test.js covers it). Every name is invented.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  ticket: { findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationDelivery: { findMany: jest.fn() },
  hrLifecycleFamilyMember: { findMany: jest.fn() },
  hrLifecycleFamily: { findMany: jest.fn() },
  $queryRawUnsafe: jest.fn(),
};
const invoiceMock = { getMode: jest.fn(async () => 'off'), findInvoiceMatches: jest.fn(async () => []) };
function rehydrateEmail(row) {
  const p = row.emailPayload || {};
  return {
    id: p.id || `g-${row.id}`, subject: row.subject || '', from: row.fromEmail || '', fromName: row.fromName || '', to: row.toEmails || [], cc: row.ccEmails || [],
    bodyPreview: row.snippet || '', bodyText: p.bodyText ?? null, internetMessageId: row.internetMessageId || null, inReplyTo: null, references: null, bodyHtml: null,
  };
}

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { get: jest.fn(async () => null), set: jest.fn() } }));
jest.unstable_mockModule('../src/services/statusService.js', () => ({ default: { resolveBaseStatus: jest.fn(async (_ws, name) => (['Closed', 'Resolved'].includes(name) ? name : 'Open')) } }));
jest.unstable_mockModule('../src/services/mailboxHoldService.js', () => ({ default: {}, rehydrateEmail }));
jest.unstable_mockModule('../src/services/invoiceMatchService.js', () => ({ default: invoiceMock, ...invoiceMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: jest.fn(() => false) } }));
jest.unstable_mockModule('../src/services/ticketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));

const { findFollowUpCandidates } = await import('../src/services/followUpCandidateService.js');
const { MailTriageService, guardDecision } = await import('../src/services/mailTriageService.js');

const WS = 2;
const MATCH = { ticketId: 880, displayRef: 'TP-2040', vendor: 'Acme Supplies', invoiceNumber: 'INV-20417', attachmentId: 300, matchedBy: 'vendor' };
const normalize = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.notificationDelivery.findMany.mockResolvedValue([]);
  prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([]);
  prismaMock.hrLifecycleFamily.findMany.mockResolvedValue([]);
  invoiceMock.getMode.mockResolvedValue('off');
  invoiceMock.findInvoiceMatches.mockResolvedValue([]);
});

describe('the follow-up finder', () => {
  const T880 = { id: 880, subject: 'Invoice INV-20417 from Acme Supplies', status: 'Open', category: null, internalCategory: null };
  /** The matched ticket, read by id for the exclusions; `rows` answers the subject / number search. */
  const tickets = (byId, rows = []) => prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where?.id?.in ? byId.filter((t) => where.id.in.includes(t.id)) : rows));

  test('an invoice match alone is a candidate (rule same_invoice), the best guess, open', async () => {
    tickets([T880]);
    const found = await findFollowUpCandidates(WS, { subject: 'FW: Documents', normalize, invoiceMatches: [MATCH] });
    expect(found).toEqual({
      candidates: [{ ticketId: 880, why: 'same invoice number INV-20417 from Acme Supplies on an open ticket' }],
      bestGuessTicketId: 880, bestGuessOpen: true, rules: ['same_invoice'], total: 1, invoiceTicketIds: [880],
    });
  });

  test('with subject candidates: the invoice ticket first; a ticket found both ways is one row with both reasons', async () => {
    const closed = (id, subject) => ({ id, subject, status: 'Closed', createdAt: new Date(), category: null, internalCategory: null });
    tickets([T880], [closed(891, 'Statement for October'), closed(880, 'Statement for October')]);
    const found = await findFollowUpCandidates(WS, { subject: 'RE: Statement for October', normalize, invoiceMatches: [MATCH] });
    expect(found.candidates).toEqual([
      { ticketId: 880, why: 'same invoice number INV-20417 from Acme Supplies on an open ticket; same subject' },
      { ticketId: 891, why: 'same subject' },
    ]);
    expect(found).toMatchObject({ bestGuessTicketId: 880, rules: ['same_invoice', 'same_subject'] });
  });

  test('no invoice matches: exactly as before', async () => {
    expect(await findFollowUpCandidates(WS, { subject: 'FW: Documents', normalize })).toBeNull();
  });

  test('invoice matches pass the same exclusions: Security, onboarding / offboarding, deleted / spam, another workspace', async () => {
    const find = () => findFollowUpCandidates(WS, { subject: 'FW: Documents', normalize, invoiceMatches: [MATCH] });
    tickets([{ ...T880, internalCategory: { name: 'Phishing', parent: { name: 'Security' } } }]);
    expect(await find()).toBeNull();
    tickets([{ ...T880, category: 'Security' }]);
    expect(await find()).toBeNull();
    tickets([{ ...T880, subject: 'Child ticket - Laptop for the new accountant' }]);
    expect(await find()).toBeNull();
    tickets([T880]);
    prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([{ ticketId: 880 }]);
    expect(await find()).toBeNull();
    prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([]);
    tickets([{ ...T880, status: 'Spam' }]);
    expect(await find()).toBeNull();
    tickets([]); // not in this workspace: the read is scoped to it
    expect(await find()).toBeNull();
    expect(prismaMock.ticket.findMany.mock.calls.at(-1)[0].where).toEqual({ workspaceId: WS, id: { in: [880] } });
    tickets([T880]);
    expect((await find()).candidates).toEqual([{ ticketId: 880, why: expect.stringContaining('same invoice number INV-20417') }]);
  });
});

describe('Mail triage', () => {
  const OPEN = {
    id: 880, workspaceId: WS, origin: 'ticketpulse', nativeNumber: 2040, freshserviceTicketId: null, subject: 'Invoice INV-20417 from Acme Supplies', descriptionText: '',
    status: 'Open', createdAt: new Date(), requester: { name: 'Acme Supplies Billing', email: 'billing@acme-supplies.example' }, ccEmails: [], internalCategory: null,
  };
  const held = {
    id: 5, workspaceId: WS, reason: 'possible_follow_up', subject: 'FW: Documents from Acme Supplies', fromEmail: 'sam.ortiz@example.com', fromName: 'Sam Ortiz',
    toEmails: ['ap-tickets@example.com'], ccEmails: [], snippet: 'For you.', emailPayload: { bodyText: 'For you.' },
    candidates: [{ ticketId: 880, why: 'same invoice number INV-20417 from Acme Supplies on an open ticket' }], bestGuessTicketId: 880,
    decision: { invoiceMatch: { mode: 'live', attachmentNames: ['INV-20417.pdf'] } },
  };
  const service = () => {
    const s = new MailTriageService();
    s._ownAddresses = async () => ({ mailboxes: new Set(['ap-tickets@example.com']), agents: new Set(['sam.ortiz@example.com']) });
    s._fts = async () => [];
    s._lifecycleIds = async () => new Set();
    prismaMock.ticket.findMany.mockImplementation(async ({ where }) => (where?.id?.in?.includes(880) ? [OPEN] : []));
    return s;
  };

  test('Live: the match is a hard, strong candidate, found from the names the ingest recorded', async () => {
    invoiceMock.getMode.mockResolvedValue('live');
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    const { candidates } = await service().findCandidates(held, { semantic: false });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({ hard: true, strong: true });
    expect(candidates[0].ticket.id).toBe(880);
    expect(candidates[0].sources).toEqual(expect.arrayContaining(['held', 'best_guess', 'invoice']));
    expect(candidates[0].why).toContain('the same invoice number INV-20417 from Acme Supplies on an open ticket');
    expect(invoiceMock.findInvoiceMatches).toHaveBeenCalledWith(expect.objectContaining({ workspaceId: WS, subject: held.subject, fromEmail: held.fromEmail, attachmentNames: ['INV-20417.pdf'] }));
  });

  test('Shadow or off: the matcher is not asked; the held candidate alone is not hard', async () => {
    invoiceMock.getMode.mockResolvedValue('shadow');
    invoiceMock.findInvoiceMatches.mockResolvedValue([MATCH]);
    const { candidates } = await service().findCandidates(held, { semantic: false });
    expect(invoiceMock.findInvoiceMatches).not.toHaveBeenCalled();
    expect(candidates[0]).toMatchObject({ hard: false, strong: true });
  });

  test('a failing matcher is no invoice candidate, never an error', async () => {
    invoiceMock.getMode.mockResolvedValue('live');
    invoiceMock.findInvoiceMatches.mockRejectedValue(new Error('db down'));
    const { candidates } = await service().findCandidates(held, { semantic: false });
    expect(candidates[0]).toMatchObject({ hard: false });
  });

  const answer = (over = {}) => ({
    action: 'attach', ticketId: 880, reopen: false, requesterEmail: null, relatedTicketIds: [], confidence: 'sure',
    reason: 'Same invoice INV-20417 from Acme Supplies.', evidence: ['same invoice number INV-20417'], candidateNotes: [], ...over,
  });
  const ctx = { holdReason: 'possible_follow_up', sender: 'sam.ortiz@example.com', mailboxes: new Set(['ap-tickets@example.com']) };

  test('with the hard link, "sure" stands and the attach is applied by itself (triage On)', () => {
    const decided = guardDecision(answer(), [{ id: 880, hard: true, strong: true, open: true, closed: false }], ctx);
    expect(decided).toMatchObject({ action: 'attach', ticketId: 880, confidence: 'sure', autoApply: true, guards: [] });
  });

  test('without it (Shadow), the same answer is only "likely" and waits for a person', () => {
    const decided = guardDecision(answer(), [{ id: 880, hard: false, strong: true, open: true, closed: false }], ctx);
    expect(decided).toMatchObject({ confidence: 'likely', autoApply: false });
  });

  test('the existing guards still win: protected senders, approvals on a reopen, machine mail never reopens', () => {
    const hard = [{ id: 880, hard: true, strong: true, open: true, closed: false }];
    expect(guardDecision(answer(), hard, { ...ctx, protectedSender: true })).toMatchObject({ autoApply: false });
    expect(guardDecision(answer(), hard, { ...ctx, unattended: true })).toMatchObject({ autoApply: false });
    const finished = [{ id: 880, hard: true, strong: true, open: false, closed: true, pendingApproval: true }];
    expect(guardDecision(answer({ reopen: true }), finished, ctx)).toMatchObject({ reopen: true, autoApply: false });
    expect(guardDecision(answer({ reopen: true }), finished, { ...ctx, machine: true })).toMatchObject({ reopen: false });
  });
});
