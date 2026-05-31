import { jest } from '@jest/globals';

const prismaMock = {
  notificationLlmToolPolicy: {
    findUnique: jest.fn(),
  },
  ticket: {
    findFirst: jest.fn(),
    findMany: jest.fn(),
  },
  ticketThreadEntry: {
    findMany: jest.fn(),
  },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

const {
  buildNotificationLlmContext,
  notificationLlmContextPrompt,
  summarizeNotificationLlmContext,
} = await import('../src/services/notificationContextEnrichmentService.js');

const eventContext = {
  event: {
    type: 'ticket.created',
    source: 'test',
    occurredAt: '2026-05-31T16:00:00.000Z',
  },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 501,
    freshserviceTicketId: 225001,
    subject: 'VPN outage for accounting',
    descriptionText: 'VPN is down. password=supersecret123',
    status: 'Open',
    priorityLabel: 'High',
    category: 'Access',
    subCategory: 'VPN',
    ticketCategory: 'IT',
    createdAt: '2026-05-31T15:55:00.000Z',
    ccEmails: ['manager@example.com'],
    replyCcEmails: ['lead@example.com'],
  },
  requester: {
    id: 40,
    name: 'Requester',
    email: 'requester@example.com',
    department: 'Accounting',
    jobTitle: 'Controller',
  },
  assignedAgent: { id: 7, name: 'Agent', email: 'agent@example.com' },
  availability: {
    isBusinessHours: false,
    isAfterHours: true,
    reason: 'After hours',
  },
  state: {
    recipients: {
      to: ['requester@example.com'],
      cc: ['manager@example.com'],
      bcc: [],
    },
  },
};

function ticketRow() {
  return {
    id: 501,
    workspaceId: 1,
    freshserviceTicketId: BigInt(225001),
    subject: 'VPN outage for accounting',
    descriptionText: 'VPN is down. password=supersecret123',
    status: 'Open',
    priority: 3,
    assessedPriority: 'High',
    toEmails: ['helpdesk@example.com'],
    ccEmails: ['manager@example.com'],
    replyCcEmails: ['lead@example.com'],
    fwdEmails: [],
    category: 'Access',
    subCategory: 'VPN',
    ticketCategory: 'IT',
    tpSkill: 'Network',
    tpSubskill: 'VPN',
    isNoise: false,
    createdAt: new Date('2026-05-31T15:55:00.000Z'),
    assignedAt: null,
    resolvedAt: null,
    closedAt: null,
    freshserviceUpdatedAt: new Date('2026-05-31T15:58:00.000Z'),
    workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
    requester: { id: 40, name: 'Requester', email: 'requester@example.com', department: 'Accounting', jobTitle: 'Controller' },
    assignedTech: { id: 7, name: 'Agent', email: 'agent@example.com', location: 'Vancouver', timezone: 'America/Vancouver' },
    internalCategory: { id: 10, name: 'Network' },
    internalSubcategory: { id: 11, name: 'VPN' },
  };
}

function similarTicket(id, department, minutesAgo = 20) {
  return {
    id,
    workspaceId: 1,
    freshserviceTicketId: BigInt(225000 + id),
    subject: `VPN outage report ${id}`,
    descriptionText: 'VPN outage and connection issue',
    status: 'Open',
    priority: 3,
    category: 'Access',
    subCategory: 'VPN',
    ticketCategory: 'IT',
    internalCategoryId: 10,
    internalSubcategoryId: 11,
    createdAt: new Date(Date.parse('2026-05-31T16:00:00.000Z') - minutesAgo * 60 * 1000),
    resolvedAt: null,
    closedAt: null,
    requester: { name: `Requester ${id}`, email: `r${id}@example.com`, department },
    assignedTech: { name: 'Agent', email: 'agent@example.com' },
    internalCategory: { id: 10, name: 'Network' },
    internalSubcategory: { id: 11, name: 'VPN' },
  };
}

describe('notification context enrichment service', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
    prismaMock.ticket.findFirst.mockResolvedValue(ticketRow());
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      {
        id: 1,
        source: 'freshservice_activity',
        eventType: 'reply',
        title: 'Requester reply',
        actorName: 'Requester',
        actorEmail: 'requester@example.com',
        incoming: true,
        isPrivate: false,
        visibility: 'public',
        bodyText: 'I still cannot connect. token=abc123456789',
        occurredAt: new Date('2026-05-31T15:58:00.000Z'),
      },
      {
        id: 2,
        source: 'freshservice_activity',
        eventType: 'note',
        title: 'Private note',
        actorName: 'Agent',
        actorEmail: 'agent@example.com',
        incoming: false,
        isPrivate: true,
        visibility: 'private',
        bodyText: 'Internal note should stay out.',
        occurredAt: new Date('2026-05-31T15:59:00.000Z'),
      },
    ]);
    prismaMock.ticket.findMany.mockResolvedValue([
      similarTicket(601, 'Accounting', 10),
      similarTicket(602, 'Finance', 12),
      similarTicket(603, 'Accounting', 15),
      similarTicket(604, 'Finance', 18),
      similarTicket(605, 'Operations', 21),
    ]);
  });

  test('builds a redacted context bundle with thread, recipient, and similar-ticket evidence', async () => {
    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      workflow: { id: 7, key: 'ticket_created', name: 'Ticket arrived', triggerType: 'ticket.created', publishedVersion: 1 },
      eventContext,
      state: eventContext.state,
    });

    expect(bundle.enabled).toBe(true);
    expect(bundle.ticket.subject).toBe('VPN outage for accounting');
    expect(bundle.ticket.descriptionText).toContain('[REDACTED]');
    expect(bundle.recipients.originalCc).toEqual(['manager@example.com']);
    expect(bundle.threadSummary.entries).toHaveLength(1);
    expect(bundle.threadSummary.omittedPrivateEntries).toBe(1);
    expect(bundle.recentSimilarTickets.windows.at(-1).count).toBe(5);
    expect(bundle.outageSignals.signalLevel).toBe('possible_broader_issue');
    expect(bundle.outageSignals.allowedPublicPhrases).toContain('we are seeing multiple similar reports');
    expect(bundle.outageSignals.blockedPublicPhrases).toContain('global outage');
    expect(bundle.contextHash).toMatch(/^[a-f0-9]{64}$/);

    const summary = summarizeNotificationLlmContext(bundle);
    expect(summary).toMatchObject({
      enabled: true,
      signalLevel: 'possible_broader_issue',
      threadEntryCount: 1,
      omittedPrivateEntries: 1,
    });
  });

  test('generates a model prompt with claim boundaries and evidence JSON', async () => {
    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext,
      state: eventContext.state,
    });

    const prompt = notificationLlmContextPrompt(bundle);

    expect(prompt).toContain('Ticket Pulse Evidence Bundle');
    expect(prompt).toContain('Only use outage-like wording');
    expect(prompt).toContain('"signalLevel": "possible_broader_issue"');
    expect(prompt).toContain('[REDACTED]');
  });

  test('returns a disabled summary when workspace policy is off', async () => {
    prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue({
      workspaceId: 1,
      mode: 'off',
      enabledTools: [],
      toolSettings: {},
      maxTurns: 4,
      maxToolCalls: 6,
      totalTimeoutMs: 20000,
      perToolTimeoutMs: 3000,
      includePrivateNotes: false,
      redactionEnabled: true,
      policyVersion: 1,
    });

    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext,
      state: eventContext.state,
    });

    expect(bundle.enabled).toBe(false);
    expect(bundle.summary).toEqual(expect.objectContaining({
      enabled: false,
      mode: 'off',
    }));
    expect(prismaMock.ticket.findFirst).not.toHaveBeenCalled();
  });
});
