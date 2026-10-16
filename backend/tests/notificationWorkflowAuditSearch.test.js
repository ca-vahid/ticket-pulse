import { jest } from '@jest/globals';

const prismaMock = {
  notificationWorkflowRun: {
    findMany: jest.fn(),
  },
  $queryRaw: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const {
  AUDIT_LIST_RUN_SELECT,
  listAuditRuns,
  runSearchFilter,
} = await import('../src/services/notificationWorkflowRepository.js');

function clauses(search) {
  return runSearchFilter(search)?.OR || [];
}

describe('Workflow Audit search (QA 10-15)', () => {
  test('a bare number matches the TP native number, the FreshService number and the audit id', () => {
    const or = clauses('10029');
    expect(or).toEqual(expect.arrayContaining([
      { ticket: { is: { nativeNumber: 10029 } } },
      { ticket: { is: { freshserviceTicketId: BigInt(10029) } } },
      { id: 10029 },
    ]));
  });

  test.each(['TP-10029', 'tp10029', 'TP 10029', 'tp-10029'])('"%s" matches the Ticket Pulse native number', (search) => {
    const or = clauses(search);
    expect(or).toEqual(expect.arrayContaining([{ ticket: { is: { nativeNumber: 10029 } } }]));
    expect(or).not.toEqual(expect.arrayContaining([{ id: 10029 }]));
  });

  test('"#247279" matches the FreshService ticket number', () => {
    const or = clauses('#247279');
    expect(or).toEqual(expect.arrayContaining([
      { ticket: { is: { freshserviceTicketId: BigInt(247279) } } },
    ]));
    expect(or).not.toEqual(expect.arrayContaining([{ ticket: { is: { nativeNumber: 247279 } } }]));
  });

  test.each(['TP-NWF-77', 'nwf-77', 'NWF77'])('"%s" matches the audit run id', (search) => {
    const or = clauses(search);
    expect(or).toEqual(expect.arrayContaining([{ id: 77 }]));
    expect(or).not.toEqual(expect.arrayContaining([{ ticket: { is: { nativeNumber: 77 } } }]));
  });

  test('"TP-ID-501" matches the internal ticket id', () => {
    expect(clauses('TP-ID-501')).toEqual(expect.arrayContaining([{ ticketId: 501 }]));
  });

  test('text matches subject, workflow name and key, and the event type', () => {
    const or = clauses('VPN');
    expect(or).toEqual(expect.arrayContaining([
      { ticket: { is: { subject: { contains: 'VPN', mode: 'insensitive' } } } },
      { workflow: { is: { name: { contains: 'VPN', mode: 'insensitive' } } } },
      { workflow: { is: { key: { contains: 'VPN', mode: 'insensitive' } } } },
      { eventType: { contains: 'VPN', mode: 'insensitive' } },
    ]));
  });

  test('event names find their event type', () => {
    expect(clauses('Requester replied')).toEqual(expect.arrayContaining([
      { eventType: { in: ['ticket.reply_received'] } },
    ]));
    expect(clauses('business hours')).toEqual(expect.arrayContaining([
      { eventType: { in: expect.arrayContaining(['ticket.created']) } },
    ]));
  });

  test('numbers too large for an int column never reach an int filter', () => {
    const or = clauses('99999999999');
    expect(or).not.toEqual(expect.arrayContaining([{ id: 99999999999 }]));
    expect(or).toEqual(expect.arrayContaining([
      { ticket: { is: { freshserviceTicketId: BigInt('99999999999') } } },
    ]));
  });

  test('empty search adds no filter', () => {
    expect(runSearchFilter('   ')).toBeNull();
  });
});

describe('Workflow Audit list query', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationWorkflowRun.findMany.mockResolvedValue([
      { id: 1, workflowId: 12, workflow: { id: 12, key: 'ticket_created_copy' } },
      { id: 2, workflowId: 7, workflow: { id: 7, key: 'ticket_assigned' } },
    ]);
    prismaMock.$queryRaw.mockResolvedValue([
      { id: 12, scheduleMode: 'after_hours' },
      { id: 7, scheduleMode: null },
    ]);
  });

  test('selects only what the list renders and keeps the workspace scope', async () => {
    await listAuditRuns(3, { search: 'TP-10029', from: '2026-10-08T00:00:00.000Z', eventType: 'ticket.created', triggerSource: 'preview' });

    const args = prismaMock.notificationWorkflowRun.findMany.mock.calls[0][0];
    expect(args.include).toBeUndefined();
    expect(args.select).toBe(AUDIT_LIST_RUN_SELECT);
    expect(args.where).toEqual(expect.objectContaining({
      workspaceId: 3,
      executionMode: { in: ['live', 'mock'] },
      eventType: 'ticket.created',
      triggerSource: 'preview',
      AND: [expect.objectContaining({
        OR: expect.arrayContaining([{ ticket: { is: { nativeNumber: 10029 } } }]),
      })],
    }));
    expect(args.take).toBe(50);

    // Heavy columns stay out of the list.
    expect(args.select.eventContext).toBeUndefined();
    expect(args.select.routingResult).toBeUndefined();
    expect(args.select.resumeState).toBeUndefined();
    expect(args.select.steps.select.input).toBeUndefined();
    expect(args.select.deliveries.select.htmlBody).toBeUndefined();
    expect(args.select.deliveries.select.textBody).toBeUndefined();
    expect(args.select.aiProviderAttempts.select.rawMetadata).toBeUndefined();
    // What health and the filters read is still there.
    expect(args.select.steps.select.output).toBe(true);
    expect(args.select.ticket.select).toEqual(expect.objectContaining({ nativeNumber: true, origin: true }));
  });

  test('attaches each workflow schedule mode without loading definitions', async () => {
    const runs = await listAuditRuns(3);

    expect(prismaMock.$queryRaw).toHaveBeenCalledTimes(1);
    expect(runs.map((run) => run.workflow.scheduleMode)).toEqual(['after_hours', null]);
  });

  test('a failed schedule-mode lookup leaves the list working', async () => {
    prismaMock.$queryRaw.mockRejectedValueOnce(new Error('boom'));
    const runs = await listAuditRuns(3);
    expect(runs).toHaveLength(2);
    expect(runs[0].workflow.scheduleMode).toBeNull();
  });
});
