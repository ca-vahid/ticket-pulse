/**
 * "Looks like a follow-up to an existing ticket" (11 Nov 2026): which tickets
 * a mail may be following up on, before it becomes a new ticket.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  ticket: { findMany: jest.fn() },
  hrLifecycleFamilyMember: { findMany: jest.fn() },
  hrLifecycleFamily: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { findFollowUpCandidates, followUpSubjectKey, FOLLOW_UP_WINDOW_DAYS, FOLLOW_UP_MAX_CANDIDATES } = await import('../src/services/followUpCandidateService.js');

// The ingest's normaliser, reduced to what these tests need.
const normalize = (s) => String(s || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/\s+/g, ' ').trim().toLowerCase();
const NOW = Date.parse('2026-11-11T18:00:00Z');
const daysAgo = (n) => new Date(NOW - n * 86400000);
let id = 100;
const ticket = (subject, over = {}) => ({ id: (id += 1), subject, status: 'Closed', createdAt: daysAgo(15), category: null, internalCategory: null, ...over });
const find = (subject, extra = {}) => findFollowUpCandidates(2, { subject, normalize, now: NOW, ...extra });

beforeEach(() => {
  jest.clearAllMocks();
  id = 100;
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([]);
  prismaMock.hrLifecycleFamily.findMany.mockResolvedValue([]);
});

test('followUpSubjectKey masks the day count and nothing else', () => {
  expect(followUpSubjectKey('reminder: 105 days outstanding invoice - 4053829 - northwind'))
    .toBe(followUpSubjectKey('reminder: 175 Days outstanding invoice - 4053829 - northwind'));
  expect(followUpSubjectKey('reminder: 1 day outstanding invoice - 4053829')).toBe('reminder: # days outstanding invoice - 4053829');
  expect(followUpSubjectKey('invoice 4053829')).not.toBe(followUpSubjectKey('invoice 4054122'));
});

test('a closed ticket with the same subject is a candidate; the search is this workspace, any status but deleted/spam, 120 days', async () => {
  const closed = ticket('Statement for October - Northwind');
  prismaMock.ticket.findMany.mockResolvedValue([closed]);
  const found = await find('RE: Statement for October - Northwind');
  expect(found).toMatchObject({ candidates: [{ ticketId: closed.id, why: 'same subject' }], bestGuessTicketId: closed.id, bestGuessOpen: false, rules: ['same_subject'], total: 1 });
  const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
  expect(where.workspaceId).toBe(2);
  expect(where.status).toEqual({ notIn: ['Deleted', 'Spam'] });
  expect(FOLLOW_UP_WINDOW_DAYS).toBe(120);
  const since = new Date(NOW - 120 * 86400000);
  expect(where.AND[0]).toEqual({ OR: [{ createdAt: { gte: since } }, { updatedAt: { gte: since } }] });
  expect(where.AND[1].OR).toEqual([{ subject: { contains: 'statement for october - northwind', mode: 'insensitive' } }]);
});

test('a changed day count still matches; a different invoice with the same words does not', async () => {
  const same = ticket('Reminder: 105 Days Outstanding Invoice - 4053829 - Northwind');
  const other = ticket('Reminder: 105 Days Outstanding Invoice - 4054122 - Northwind');
  prismaMock.ticket.findMany.mockResolvedValue([same, other]);
  const found = await find('RE: Reminder: 175 Days Outstanding Invoice - 4053829 - Northwind');
  expect(found.candidates).toEqual([{ ticketId: same.id, why: 'same subject; same reference number 4053829' }]);
  expect(found.rules).toEqual(['same_subject', 'shared_number']);
});

test('a shared invoice number matches whatever the words are; a short or glued number never does', async () => {
  const byNumber = ticket('Invoice 4053829 dispute (Northwind)');
  prismaMock.ticket.findMany.mockResolvedValue([byNumber, ticket('Drive 12 on RS4053829X failed')]);
  const found = await find('Payment query: 4053829');
  expect(found.candidates).toEqual([{ ticketId: byNumber.id, why: 'same reference number 4053829' }]);
  expect(found.rules).toEqual(['shared_number']);
  expect(prismaMock.ticket.findMany.mock.calls[0][0].where.AND[1].OR).toContainEqual({ subject: { contains: '4053829' } });
  // Nothing to search with: a very short subject and no long number.
  prismaMock.ticket.findMany.mockClear();
  expect(await find('RE: Hi 12')).toBeNull();
  expect(prismaMock.ticket.findMany).not.toHaveBeenCalled();
});

test('never a candidate: Security (top-level category), onboarding / offboarding, deleted and spam', async () => {
  const subject = 'Laptop for the new project accountant';
  const security = ticket(subject, { internalCategory: { name: 'Phishing', parent: { name: 'Security' } } });
  const securityTop = ticket(subject, { internalCategory: { name: 'security', parent: null } });
  const securityFs = ticket(subject, { category: 'Security' });
  const familyMember = ticket(subject);
  const familyParent = ticket(subject);
  const child = ticket('Child ticket - Laptop for the new project accountant');
  const deleted = ticket(subject, { status: 'Deleted' });
  const spam = ticket(subject, { status: 'Spam' });
  prismaMock.ticket.findMany.mockResolvedValue([security, securityTop, securityFs, familyMember, familyParent, child, deleted, spam]);
  prismaMock.hrLifecycleFamilyMember.findMany.mockResolvedValue([{ ticketId: familyMember.id }]);
  prismaMock.hrLifecycleFamily.findMany.mockResolvedValue([{ parentTicketId: familyParent.id }]);
  expect(await find(`RE: ${subject}`)).toBeNull();

  // A sub-category that only sounds like it is not Security.
  const ordinary = ticket(subject, { internalCategory: { name: 'Security cameras', parent: { name: 'Facilities' } } });
  prismaMock.ticket.findMany.mockResolvedValue([security, ordinary]);
  expect((await find(`RE: ${subject}`)).candidates).toEqual([{ ticketId: ordinary.id, why: 'same subject' }]);
});

test('candidates are newest first, six at most; the best guess prefers an open ticket, then the newest', async () => {
  const subject = 'Corrections to invoice for overhead';
  const rows = Array.from({ length: 8 }, (_, i) => ticket(subject, { createdAt: daysAgo(i + 1) }));
  rows[3].status = 'Waiting on client'; // a custom open status
  prismaMock.ticket.findMany.mockResolvedValue(rows);
  const isOpen = jest.fn(async (status) => status === 'Waiting on client');
  const found = await find(`RE: ${subject}`, { isOpen });
  expect(FOLLOW_UP_MAX_CANDIDATES).toBe(6);
  expect(found.candidates.map((c) => c.ticketId)).toEqual(rows.slice(0, 6).map((r) => r.id));
  expect(found.candidates.every((c) => Object.keys(c).join() === 'ticketId,why')).toBe(true);
  expect(found).toMatchObject({ bestGuessTicketId: rows[3].id, bestGuessOpen: true, total: 8 });

  const allClosed = await find(`RE: ${subject}`, { isOpen: async () => false });
  expect(allClosed).toMatchObject({ bestGuessTicketId: rows[0].id, bestGuessOpen: false });
});

test('no candidate, and a lookup that fails, are both "none": the mail goes on to be a ticket', async () => {
  prismaMock.ticket.findMany.mockResolvedValue([ticket('Something else entirely about Northwind statement')]);
  expect(await find('RE: Statement for October - Northwind')).toBeNull();
  prismaMock.ticket.findMany.mockRejectedValue(new Error('db down'));
  expect(await find('RE: Statement for October - Northwind')).toBeNull();
});
