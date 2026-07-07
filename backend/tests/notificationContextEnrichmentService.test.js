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
    dueBy: new Date('2026-06-03T23:00:00.000Z'),
    frDueBy: new Date('2026-06-01T18:00:00.000Z'),
    firstPublicAgentReplyAt: null,
    resolutionTimeSeconds: null,
    freshserviceUpdatedAt: new Date('2026-05-31T15:58:00.000Z'),
    workspace: { id: 1, name: 'IT', defaultTimezone: 'America/Vancouver' },
    requester: { id: 40, name: 'Requester', email: 'requester@example.com', department: 'Accounting', jobTitle: 'Controller' },
    assignedTech: { id: 7, name: 'Agent', email: 'agent@example.com', location: 'Vancouver', timezone: 'America/Vancouver' },
    internalCategory: { id: 10, name: 'Network' },
    internalSubcategory: { id: 11, name: 'VPN' },
  };
}

function similarTicket(id, department, minutesAgo = 20, overrides = {}) {
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
    requester: { id, name: `Requester ${id}`, email: `r${id}@example.com`, department },
    assignedTech: { name: 'Agent', email: 'agent@example.com' },
    internalCategory: { id: 10, name: 'Network' },
    internalSubcategory: { id: 11, name: 'VPN' },
    ...overrides,
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
    // Policy decision 2026-07-07: private notes enter the bundle as GUARDED
    // evidence (quoteAllowed=false); the output guard blocks verbatim reuse.
    expect(bundle.threadSummary.entries).toHaveLength(2);
    expect(bundle.threadSummary.omittedPrivateEntries).toBe(0);
    const privateEntry = bundle.threadSummary.entries.find((e) => e.isPrivate);
    expect(privateEntry.quoteAllowed).toBe(false);
    expect(bundle.recentSimilarTickets.windows.at(-1).count).toBe(5);
    expect(bundle.outageSignals.signalLevel).toBe('possible_broader_issue');
    expect(bundle.outageSignals.confidence).toBe('high');
    expect(bundle.outageSignals.criteria.distinctIncidentRequesterThresholdMet).toBe(true);
    expect(bundle.outageSignals.passedCriteria).toContain('notRoutineCluster');
    expect(bundle.outageSignals.rationale).toMatch(/Shared incident language/i);
    expect(bundle.outageSignals.counts.distinctRequesters).toBe(5);
    expect(bundle.outageSignals.allowedPublicPhrases).toContain('we are seeing multiple similar reports');
    expect(bundle.outageSignals.blockedPublicPhrases).toContain('global outage');
    expect(bundle.ticket.dueBy).toBe('2026-06-03T23:00:00.000Z');
    expect(bundle.timingEvidence).toEqual(expect.objectContaining({
      deterministic: true,
      source: 'freshservice_sla_due_dates',
      dueBy: '2026-06-03T23:00:00.000Z',
      firstResponseDueBy: '2026-06-01T18:00:00.000Z',
    }));
    expect(bundle.contextHash).toMatch(/^[a-f0-9]{64}$/);

    const summary = summarizeNotificationLlmContext(bundle);
    expect(summary).toMatchObject({
      enabled: true,
      signalLevel: 'possible_broader_issue',
      signalConfidence: 'high',
      threadEntryCount: 2,
      omittedPrivateEntries: 0,
      timingEvidenceSource: 'freshservice_sla_due_dates',
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
    expect(prompt).toContain('Do not imply an outage');
    expect(prompt).toContain('Only make response-time or resolution-time claims');
    expect(prompt).toContain('"timingEvidence"');
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

  test('classifies related tickets as watch when requester and department diversity is insufficient', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      similarTicket(611, 'Accounting', 10, { requester: { id: 80, name: 'Requester One', email: 'one@example.com', department: 'Accounting' } }),
      similarTicket(612, 'Accounting', 12, { requester: { id: 80, name: 'Requester One', email: 'one@example.com', department: 'Accounting' } }),
      similarTicket(613, 'Accounting', 15, { requester: { id: 80, name: 'Requester One', email: 'one@example.com', department: 'Accounting' } }),
      similarTicket(614, 'Accounting', 18, { requester: { id: 80, name: 'Requester One', email: 'one@example.com', department: 'Accounting' } }),
      similarTicket(615, 'Accounting', 21, { requester: { id: 80, name: 'Requester One', email: 'one@example.com', department: 'Accounting' } }),
    ]);

    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext,
      state: eventContext.state,
    });

    expect(bundle.outageSignals.signalLevel).toBe('watch');
    expect(bundle.outageSignals.confidence).toBe('medium');
    expect(bundle.outageSignals.rationale).toMatch(/not strong enough/i);
    expect(bundle.outageSignals.criteria.distinctIncidentRequesterThresholdMet).toBe(false);
    expect(bundle.outageSignals.counts.distinctRequesters).toBe(1);
    expect(bundle.outageSignals.allowedPublicPhrases).toEqual([]);
  });

  test('classifies routine onboarding and procurement clusters without outage-like wording', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...ticketRow(),
      subject: 'New hire laptop setup',
      descriptionText: 'Requesting laptop and dock for new hire onboarding.',
      category: 'Hardware',
      subCategory: 'Onboarding',
      internalCategory: { id: 20, name: 'Hardware' },
      internalSubcategory: { id: 21, name: 'Onboarding' },
    });
    prismaMock.ticket.findMany.mockResolvedValue([
      similarTicket(621, 'Accounting', 10, {
        subject: 'New hire laptop setup for accounting',
        descriptionText: 'Laptop and dock procurement for new hire',
        category: 'Hardware',
        subCategory: 'Onboarding',
        internalCategoryId: 20,
        internalSubcategoryId: 21,
        requester: { id: 91, name: 'Requester 91', email: 'r91@example.com', department: 'Accounting' },
      }),
      similarTicket(622, 'Finance', 12, {
        subject: 'New hire workstation setup',
        descriptionText: 'Equipment request for onboarding',
        category: 'Hardware',
        subCategory: 'Onboarding',
        internalCategoryId: 20,
        internalSubcategoryId: 21,
        requester: { id: 92, name: 'Requester 92', email: 'r92@example.com', department: 'Finance' },
      }),
      similarTicket(623, 'Operations', 14, {
        subject: 'New hire laptop procurement',
        descriptionText: 'Laptop setup and purchase request',
        category: 'Hardware',
        subCategory: 'Onboarding',
        internalCategoryId: 20,
        internalSubcategoryId: 21,
        requester: { id: 93, name: 'Requester 93', email: 'r93@example.com', department: 'Operations' },
      }),
    ]);

    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext: {
        ...eventContext,
        ticket: {
          ...eventContext.ticket,
          subject: 'New hire laptop setup',
          descriptionText: 'Requesting laptop and dock for new hire onboarding.',
          category: 'Hardware',
          subCategory: 'Onboarding',
        },
      },
      state: eventContext.state,
    });

    expect(bundle.outageSignals.signalLevel).toBe('routine_cluster');
    expect(bundle.outageSignals.confidence).toBe('low');
    expect(bundle.outageSignals.rationale).toMatch(/routine operational patterns/i);
    expect(bundle.outageSignals.allowedPublicPhrases).toEqual([]);
  });

  test('classifies high-volume peripheral and docking station matches as a routine cluster', async () => {
    prismaMock.ticket.findFirst.mockResolvedValue({
      ...ticketRow(),
      subject: 'Docking Station has no power',
      descriptionText: 'My docking station does not seem to have power, though the power bar works.',
      category: null,
      subCategory: null,
      ticketCategory: 'Peripherals',
      internalCategory: { id: 66, name: 'Devices & Hardware' },
      internalSubcategory: { id: 70, name: 'Docking Stations & Display Connectivity' },
    });
    prismaMock.ticket.findMany.mockResolvedValue([
      similarTicket(641, 'Vancouver', 10, {
        subject: 'Inspect and troubleshoot office printer',
        descriptionText: 'Printer peripheral troubleshooting',
        category: null,
        subCategory: null,
        ticketCategory: 'Printers',
        internalCategoryId: 66,
        internalSubcategoryId: 71,
        internalCategory: { id: 66, name: 'Devices & Hardware' },
        internalSubcategory: { id: 71, name: 'Printers & Scanners' },
      }),
      similarTicket(642, 'Calgary', 12, {
        subject: 'Install ordered PDU at office workstation',
        descriptionText: 'Workstation hardware setup',
        category: null,
        subCategory: null,
        ticketCategory: 'Workstation Setup',
        internalCategoryId: 66,
        internalSubcategoryId: 72,
        internalCategory: { id: 66, name: 'Devices & Hardware' },
        internalSubcategory: { id: 72, name: 'Workstation Setup' },
      }),
      similarTicket(643, 'Halifax', 14, {
        subject: 'Request for webcam',
        descriptionText: 'Peripheral accessory request',
        category: null,
        subCategory: null,
        ticketCategory: 'Peripherals',
        internalCategoryId: 66,
        internalSubcategoryId: 73,
        internalCategory: { id: 66, name: 'Devices & Hardware' },
        internalSubcategory: { id: 73, name: 'Peripherals / Accessories Procurement' },
      }),
      similarTicket(644, 'Surrey', 16, {
        subject: 'Docking station display connectivity',
        descriptionText: 'Dock display cable check',
        category: null,
        subCategory: null,
        ticketCategory: 'Peripherals',
        internalCategoryId: 66,
        internalSubcategoryId: 70,
        internalCategory: { id: 66, name: 'Devices & Hardware' },
        internalSubcategory: { id: 70, name: 'Docking Stations & Display Connectivity' },
      }),
    ]);

    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext: {
        ...eventContext,
        ticket: {
          ...eventContext.ticket,
          subject: 'Docking Station has no power',
          descriptionText: 'My docking station does not seem to have power, though the power bar works.',
          category: null,
          subCategory: null,
          ticketCategory: 'Peripherals',
        },
      },
      state: eventContext.state,
    });

    expect(bundle.outageSignals.signalLevel).toBe('routine_cluster');
    expect(bundle.outageSignals.criteria.currentIncidentLanguage).toBe(false);
    expect(bundle.outageSignals.counts.openIncidentStrongTickets).toBe(0);
    expect(bundle.outageSignals.allowedPublicPhrases).toEqual([]);
    expect(bundle.outageSignals.rationale).toMatch(/routine operational patterns/i);
  });

  test('returns none for isolated weak similarity', async () => {
    prismaMock.ticket.findMany.mockResolvedValue([
      similarTicket(631, 'Accounting', 10, {
        subject: 'Shared mailbox question',
        descriptionText: 'Question about mailbox access',
        status: 'Resolved',
        category: 'Access',
        subCategory: 'Mailbox',
        internalCategoryId: null,
        internalSubcategoryId: null,
      }),
    ]);

    const bundle = await buildNotificationLlmContext({
      workspaceId: 1,
      eventContext,
      state: eventContext.state,
    });

    expect(bundle.outageSignals.signalLevel).toBe('none');
    expect(bundle.outageSignals.confidence).toBe('low');
    expect(bundle.outageSignals.allowedPublicPhrases).toEqual([]);
  });
});
