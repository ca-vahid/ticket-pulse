import { jest } from '@jest/globals';

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  ticket: {
    findFirst: jest.fn(),
    groupBy: jest.fn(),
  },
  technician: { findMany: jest.fn() },
  technicianCompetency: { findMany: jest.fn() },
  technicianLeave: { findMany: jest.fn() },
  ticketAssignmentEpisode: { findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  assignmentConfig: { findUnique: jest.fn() },
  competencyCategory: { findMany: jest.fn() },
};

const settingsRepositoryMock = {
  getFreshServiceConfigForWorkspace: jest.fn(),
};

const getGroupMock = jest.fn();
const createFreshServiceClientMock = jest.fn(() => ({ getGroup: getGroupMock }));

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: settingsRepositoryMock,
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: createFreshServiceClientMock,
}));

jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({
  default: {
    isConfigured: jest.fn(() => false),
    getUserProfile: jest.fn(),
  },
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const { executeTool, TOOL_SCHEMAS } = await import('../src/services/assignmentTools.js');

const techs = [
  { id: 1, name: 'Busy Expert', email: 'busy@example.com', location: 'Vancouver', timezone: 'America/Los_Angeles', workStartTime: '09:00', workEndTime: '17:00', freshserviceId: BigInt(101) },
  { id: 2, name: 'Available Peer', email: 'peer@example.com', location: 'Vancouver', timezone: 'America/Los_Angeles', workStartTime: '09:00', workEndTime: '17:00', freshserviceId: BigInt(102) },
];

describe('assignmentTools risk and routing helpers', () => {
  beforeEach(() => {
    jest.useFakeTimers().setSystemTime(new Date('2026-05-22T19:00:00.000Z'));
    jest.clearAllMocks();

    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Los_Angeles' });
    prismaMock.assignmentConfig.findUnique.mockResolvedValue({
      scoringWeights: { competency: 0.35, workload: 0.30, location: 0.20, recency: 0.15 },
      excludedGroupIds: [1000206163],
    });
    prismaMock.ticket.findFirst.mockResolvedValue({
      id: 900,
      freshserviceTicketId: BigInt(223551),
      subject: 'SharePoint Issue',
      descriptionText: 'Project SharePoint site access problem in Vancouver.',
      groupId: BigInt(1000206163),
      category: null,
      subCategory: null,
      ticketCategory: 'Sharepoint (Coreshack)',
      internalCategoryId: 10,
      internalSubcategoryId: 11,
      internalCategory: { id: 10, name: 'Collaboration & Files' },
      internalSubcategory: { id: 11, name: 'SharePoint / Coreshack' },
      requester: {
        name: 'Requester',
        email: 'requester@example.com',
        department: 'Vancouver',
        jobTitle: 'Engineer',
        timeZone: 'America/Los_Angeles',
      },
    });
    prismaMock.technician.findMany.mockResolvedValue(techs);
    prismaMock.technicianCompetency.findMany.mockResolvedValue([
      { technicianId: 1, proficiencyLevel: 'expert', competencyCategory: { id: 11, name: 'SharePoint / Coreshack', parentId: 10 } },
      { technicianId: 2, proficiencyLevel: 'advanced', competencyCategory: { id: 11, name: 'SharePoint / Coreshack', parentId: 10 } },
    ]);
    prismaMock.technicianLeave.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy
      .mockResolvedValueOnce([{ assignedTechId: 1, _count: { _all: 12 } }, { assignedTechId: 2, _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ assignedTechId: 1, _count: { _all: 3 } }, { assignedTechId: 2, _count: { _all: 1 } }])
      .mockResolvedValueOnce([{ assignedTechId: 1, _count: { _all: 12 } }, { assignedTechId: 2, _count: { _all: 2 } }])
      .mockResolvedValueOnce([{ assignedTechId: 1, _count: { _all: 3 } }, { assignedTechId: 2, _count: { _all: 1 } }]);
    prismaMock.ticketAssignmentEpisode.findMany.mockResolvedValue([
      {
        ticketId: 900,
        technicianId: 1,
        endedAt: new Date('2026-05-22T18:30:00.000Z'),
        endActorName: 'Busy Expert',
        technician: { id: 1, name: 'Busy Expert' },
        ticket: {
          id: 900,
          freshserviceTicketId: BigInt(223551),
          subject: 'SharePoint Issue',
          internalCategoryId: 10,
          internalSubcategoryId: 11,
          ticketCategory: 'Sharepoint (Coreshack)',
          category: null,
        },
      },
      {
        ticketId: 901,
        technicianId: 1,
        endedAt: new Date('2026-05-22T17:30:00.000Z'),
        endActorName: 'Busy Expert',
        technician: { id: 1, name: 'Busy Expert' },
        ticket: {
          id: 901,
          freshserviceTicketId: BigInt(223552),
          subject: 'SharePoint Library',
          internalCategoryId: 10,
          internalSubcategoryId: 11,
          ticketCategory: 'Sharepoint (Coreshack)',
          category: null,
        },
      },
    ]);
    prismaMock.ticketThreadEntry.findMany.mockResolvedValue([
      {
        ticketId: 900,
        title: 'Private note',
        bodyText: 'I am busy today and unavailable for this SharePoint work.',
        content: null,
        actorName: 'Busy Expert',
        occurredAt: new Date('2026-05-22T18:31:00.000Z'),
      },
    ]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 10, name: 'Collaboration & Files', parentId: null },
      { id: 11, name: 'SharePoint / Coreshack', parentId: 10 },
    ]);
    settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'example.freshservice.com', apiKey: 'key', workspaceId: 1 });
    getGroupMock.mockResolvedValue({ id: 1000206163, name: 'Coreshack', members: [102] });
  });

  afterEach(() => {
    jest.useRealTimers();
  });

  test('exposes the new global tool schemas', () => {
    const names = TOOL_SCHEMAS.map((tool) => tool.name || tool.type);

    expect(names).toContain('get_assignment_risk_signals');
    expect(names).toContain('get_routing_boundary_context');
    expect(names).toContain('get_requester_site_context');
  });

  test('get_assignment_risk_signals returns same-day and same-subcategory suppression advice', async () => {
    const result = await executeTool('get_assignment_risk_signals', {
      ticket_id: 900,
      categoryId: 10,
      subcategoryId: 11,
      candidate_tech_ids: [1, 2],
    }, { workspaceId: 1, ticketId: 900 });

    const busy = result.candidates.find((candidate) => candidate.techId === 1);

    expect(busy.sameTicketRejected).toBe(true);
    expect(busy.sameDayRejectedCount).toBe(2);
    expect(busy.sameSubcategoryRejectedCount).toBe(2);
    expect(busy.availabilitySuppression.active).toBe(true);
    expect(busy.recentRejectionReasons[0]).toContain('busy today');
    expect(result.summary.suppressedCount).toBe(1);
  });

  test('find_matching_agents down-ranks active rejection suppressions', async () => {
    const result = await executeTool('find_matching_agents', {
      categoryId: 10,
      subcategoryId: 11,
      preferred_location: 'Vancouver',
    }, { workspaceId: 1, ticketId: 900 });

    expect(result.matches[0].techName).toBe('Available Peer');
    expect(result.matches[1].techName).toBe('Busy Expert');
    expect(result.matches[1].assignmentRisk.availabilitySuppression.active).toBe(true);
    expect(result.matches[0].riskAdjustedScore).toBeGreaterThan(result.matches[1].riskAdjustedScore);
  });

  test('get_routing_boundary_context reports excluded Coreshack group and compatibility', async () => {
    const result = await executeTool('get_routing_boundary_context', {
      ticket_id: 900,
      candidate_tech_ids: [1, 2],
    }, { workspaceId: 1, ticketId: 900 });

    expect(result.freshserviceGroup).toMatchObject({
      id: 1000206163,
      name: 'Coreshack',
      excludedFromAutoAssign: true,
    });
    expect(result.routingBoundary.policy).toBe('manual_review_required');
    expect(result.candidateGroupCompatibility).toEqual([
      expect.objectContaining({ techId: 1, memberOfCurrentGroup: false }),
      expect.objectContaining({ techId: 2, memberOfCurrentGroup: true }),
    ]);
  });
});
