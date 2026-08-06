import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

/**
 * Custom Fields Activation Phase 2 — CSV export custom-field columns:
 * GET /api/tickets/export.csv appends one column per ACTIVE definition
 * (capped at 10 by sortOrder, header = the definition label) whenever the
 * workspace has definitions, with per-ticket values stringified as stored.
 * The route also inherits cf_* filters by riding listTickets (same where).
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  customFieldDefinition: { findMany: jest.fn(), findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', color: 'blue', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', color: 'amber', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', color: 'emerald', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', color: 'slate', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  assignmentPipelineRun: { findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  ticketProposedReply: { findMany: jest.fn().mockResolvedValue([]) },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
  $queryRaw: jest.fn().mockResolvedValue([]),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: { evaluate: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn() },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: { findByEmail: jest.fn(), createNative: jest.fn() } }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({ default: {}, sseManager: { broadcast: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn(), enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    reconcileTicket: jest.fn(), getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));
jest.unstable_mockModule('../src/services/ticketMergeService.js', () => ({
  default: { mergedInto: jest.fn().mockResolvedValue(null) },
}));
jest.unstable_mockModule('../src/services/scheduledTicketService.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/middleware/workspace.js', () => ({
  requireWorkspace: (req, _res, next) => { req.workspaceId = 1; next(); },
}));

const { default: ticketsRouter } = await import('../src/routes/tickets.routes.js');

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.session = { user: { email: 'ada@x.io', name: 'Ada Admin', role: 'admin' } };
    next();
  });
  app.use('/api/tickets', ticketsRouter);
  // eslint-disable-next-line no-unused-vars
  app.use((err, _req, res, _next) => {
    res.status(err.statusCode || 500).json({ success: false, message: err.message });
  });
  return app;
}

const TICKET_ROW = {
  id: 100,
  workspaceId: 1,
  origin: 'ticketpulse',
  nativeNumber: 1042,
  freshserviceTicketId: null,
  subject: 'Project setup, "Coyote"',
  status: 'Open',
  priority: 2,
  ticketType: 'Service Request',
  assignedTechId: null,
  createdAt: new Date('2026-08-06T10:00:00.000Z'),
  updatedAt: new Date('2026-08-06T10:00:00.000Z'),
  lastRealActivityAt: new Date('2026-08-06T10:00:00.000Z'),
  requester: { id: 4, name: 'Rita Requester', email: 'rita@x.io' },
  assignedTech: null,
  internalCategory: null,
  internalSubcategory: null,
  tagLinks: [],
  customFields: { client_name: 'ACME Inc', expedite: true, amount: 42 },
};

const defs = (n) => Array.from({ length: n }, (_, i) => ({
  id: i + 1,
  workspaceId: 1,
  key: ['client_name', 'expedite', 'amount'][i] || `extra_${i}`,
  label: ['Client Name', 'Expedite', 'Amount'][i] || `Extra ${i}`,
  type: 'text',
  options: [],
  isActive: true,
  sortOrder: i,
}));

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, internalDomains: [] });
  prismaMock.technician.findFirst.mockResolvedValue(null);
  prismaMock.ticket.count.mockResolvedValue(1);
  prismaMock.ticket.findMany.mockResolvedValue([{ ...TICKET_ROW }]);
  prismaMock.$queryRaw.mockResolvedValue([]);
  prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([]);
  prismaMock.ticketProposedReply.findMany.mockResolvedValue([]);
  prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([]);
});

describe('GET /api/tickets/export.csv custom-field columns', () => {
  test('appends one labelled column per active definition with stringified values', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(defs(3));
    const res = await request(buildApp()).get('/api/tickets/export.csv').expect(200);
    const [header, row] = res.text.trim().split('\n');
    expect(header).toBe('Ref,Subject,Status,Priority,Type,State,Requester,Requester Email,Assignee,Category,Subcategory,Tags,Origin,Created,Last Activity,Client Name,Expedite,Amount');
    expect(row).toContain('ACME Inc');
    expect(row.endsWith(',ACME Inc,true,42')).toBe(true);
  });

  test('caps at 10 columns by sortOrder', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(defs(12));
    const res = await request(buildApp()).get('/api/tickets/export.csv').expect(200);
    const header = res.text.split('\n')[0];
    expect(header.split(',')).toHaveLength(15 + 10);
    expect(header).toContain('Extra 9');
    expect(header).not.toContain('Extra 10');
  });

  test('no definitions → the classic 15-column export, untouched', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
    const res = await request(buildApp()).get('/api/tickets/export.csv').expect(200);
    expect(res.text.split('\n')[0].split(',')).toHaveLength(15);
  });

  test('missing values render as empty cells', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(defs(3));
    prismaMock.ticket.findMany.mockResolvedValue([{ ...TICKET_ROW, customFields: null }]);
    const res = await request(buildApp()).get('/api/tickets/export.csv').expect(200);
    const row = res.text.trim().split('\n')[1];
    expect(row.endsWith(',,,')).toBe(true);
  });

  test('cf_* filter params flow into the shared listTickets where', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(defs(3));
    await request(buildApp()).get('/api/tickets/export.csv?cf_client_name=acme').expect(200);
    // Text contains rides the raw id-prefilter lane; the workspace id is bound.
    expect(prismaMock.$queryRaw).toHaveBeenCalled();
    const { where } = prismaMock.ticket.findMany.mock.calls[0][0];
    expect(where.AND).toEqual(expect.arrayContaining([expect.objectContaining({ id: expect.anything() })]));
  });
});
