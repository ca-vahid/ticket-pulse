import { jest } from '@jest/globals';

/** QA 09-16 #4: overview() turns the page's filters into one Prisma where + orderBy. */
const prismaMock = {
  ticketApproval: { findMany: jest.fn().mockResolvedValue([]), groupBy: jest.fn().mockResolvedValue([]) },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() }, sendEmail: jest.fn() }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: { isConfigured: () => false } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({ default: { emitTicketEvent: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { isConfigured: jest.fn(() => false), getUserPhoto: jest.fn() } }));

const { default: ticketApprovalService } = await import('../src/services/ticketApprovalService.js');

beforeEach(() => jest.clearAllMocks());

describe('ticketApprovalService.overview filters (QA 09-16 #4)', () => {
  test('approver matches e-mail or name, requestedBy contains, dates bracket createdAt (to = end of day), text searches subject/notes/ref', async () => {
    await ticketApprovalService.overview(1, { approver: 'reza', requestedBy: 'mblackstock', from: '2026-09-01', to: '2026-09-16', q: '#228440', sort: 'oldest' });
    const args = prismaMock.ticketApproval.findMany.mock.calls[0][0];
    expect(args.where.OR).toEqual([
      { approverEmail: { contains: 'reza', mode: 'insensitive' } },
      { approverName: { contains: 'reza', mode: 'insensitive' } },
    ]);
    expect(args.where.requestedBy).toEqual({ contains: 'mblackstock', mode: 'insensitive' });
    expect(args.where.createdAt.gte).toEqual(new Date('2026-09-01'));
    expect(args.where.createdAt.lte.toISOString()).toBe(new Date(new Date('2026-09-16').getTime() + 24 * 60 * 60 * 1000 - 1).toISOString());
    const text = args.where.AND[0].OR;
    expect(text).toEqual(expect.arrayContaining([
      { ticket: { is: { subject: { contains: '#228440', mode: 'insensitive' } } } },
      { ticket: { is: { nativeNumber: 228440 } } },
      { ticket: { is: { freshserviceTicketId: 228440n } } },
    ]));
    expect(args.orderBy).toEqual({ id: 'asc' });
  });

  test('no filters → the old shape (status/category only, newest first); status sort is status then newest', async () => {
    await ticketApprovalService.overview(1, { status: 'approved', categoryId: '3' });
    let args = prismaMock.ticketApproval.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ workspaceId: 1, status: 'approved', approvalCategoryId: 3 });
    expect(args.orderBy).toEqual({ id: 'desc' });
    await ticketApprovalService.overview(1, { sort: 'status' });
    args = prismaMock.ticketApproval.findMany.mock.calls[1][0];
    expect(args.orderBy).toEqual([{ status: 'asc' }, { id: 'desc' }]);
  });

  test('several statuses arrive comma-joined and become an IN (Approvals status menu, 20 Sep 2026)', async () => {
    await ticketApprovalService.overview(1, { status: 'approved, rejected' });
    const args = prismaMock.ticketApproval.findMany.mock.calls[0][0];
    expect(args.where.status).toEqual({ in: ['approved', 'rejected'] });
  });
});

describe('overview rows carry people’s NAMES (18 Sep 2026)', () => {
  // The Approvals page showed "Snasiri" under "Requested by": overview() skipped
  // the name pass the inbox lists run, so the page prettified the mailbox.
  const row = (over = {}) => ({
    id: 77, workspaceId: 1, ticketId: 9, status: 'approved', approverEmail: 'vhaeri@bgcengineering.ca', approverName: 'Vahid Haeri',
    requestedBy: 'snasiri@bgcengineering.ca', createdAt: new Date('2026-09-18T22:59:00Z'), decidedAt: null,
    approvalCategory: { name: 'Entra PIM Permission Request' },
    ticket: { id: 9, subject: 'Permission for signature app', origin: 'ticketpulse', nativeNumber: 1569, freshserviceTicketId: null, requester: { name: 'Soheil Nasiri', email: 'snasiri@bgcengineering.ca' } },
    ...over,
  });

  beforeEach(() => {
    prismaMock.technician = { findFirst: jest.fn(async ({ where }) => (where.email.equals === 'snasiri@bgcengineering.ca' ? { name: 'Soheil Nasiri' } : null)) };
    prismaMock.requester = { findFirst: jest.fn().mockResolvedValue(null) };
  });

  test('requestedByName is the person, not the mailbox', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValueOnce([row()]);
    const { items } = await ticketApprovalService.overview(1, {});
    expect(items[0].requestedByName).toBe('Soheil Nasiri');
    expect(items[0].requestedBy).toBe('snasiri@bgcengineering.ca');
  });

  test('one lookup per distinct person, however many rows', async () => {
    prismaMock.ticketApproval.findMany.mockResolvedValueOnce([row({ id: 1 }), row({ id: 2 }), row({ id: 3 })]);
    await ticketApprovalService.overview(1, {});
    expect(prismaMock.technician.findFirst).toHaveBeenCalledTimes(1);
  });

  test('a missing approver name is filled the same way', async () => {
    prismaMock.technician.findFirst.mockImplementation(async ({ where }) => ({ 'snasiri@bgcengineering.ca': { name: 'Soheil Nasiri' }, 'vhaeri@bgcengineering.ca': { name: 'Vahid Haeri' } }[where.email.equals] || null));
    prismaMock.ticketApproval.findMany.mockResolvedValueOnce([row({ approverName: null })]);
    const { items } = await ticketApprovalService.overview(1, {});
    expect(items[0].approverName).toBe('Vahid Haeri');
  });
});
