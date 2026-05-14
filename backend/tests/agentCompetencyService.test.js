import { jest } from '@jest/globals';

const prismaMock = {
  technician: {
    findMany: jest.fn(),
  },
  competencyCategory: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    count: jest.fn(),
  },
  technicianCompetency: {
    findMany: jest.fn(),
    findUnique: jest.fn(),
    upsert: jest.fn(),
    deleteMany: jest.fn(),
  },
  competencyChangeRequest: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
    count: jest.fn(),
  },
  $transaction: jest.fn(async (callback) => callback(prismaMock)),
};

const competencyRepositoryMock = {
  getActiveCategories: jest.fn(),
  getAllCompetenciesForWorkspace: jest.fn(),
  buildCategoryTree: jest.fn(),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/competencyRepository.js', () => ({
  default: competencyRepositoryMock,
}));

const {
  submitMyCompetencyChanges,
  decideCompetencyRequestGroup,
} = await import('../src/services/agentCompetencyService.js');

describe('agentCompetencyService bulk requests', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (callback) => callback(prismaMock));
    prismaMock.technician.findMany.mockResolvedValue([
      {
        id: 7,
        name: 'Agent One',
        email: 'agent@example.com',
        workspaceId: 2,
        workspace: { id: 2, name: 'IT', slug: 'it', defaultTimezone: 'America/Vancouver' },
      },
    ]);
    competencyRepositoryMock.getActiveCategories.mockResolvedValue([]);
    competencyRepositoryMock.getAllCompetenciesForWorkspace.mockResolvedValue([]);
    competencyRepositoryMock.buildCategoryTree.mockReturnValue([]);
    prismaMock.competencyChangeRequest.findMany.mockResolvedValue([]);
  });

  test('creates one grouped pending request per selected skill with a shared note', async () => {
    prismaMock.competencyCategory.findMany.mockResolvedValue([
      { id: 11, workspaceId: 2, isActive: true, parentId: 10, name: 'VPN' },
      { id: 12, workspaceId: 2, isActive: true, parentId: 10, name: 'WiFi' },
    ]);
    prismaMock.technicianCompetency.findMany.mockResolvedValue([]);
    prismaMock.competencyChangeRequest.findFirst.mockResolvedValue(null);

    const result = await submitMyCompetencyChanges('agent@example.com', {
      workspaceId: 2,
      note: 'I have been handling these tickets recently.',
      requests: [
        { competencyCategoryId: 11, requestedLevel: 'intermediate' },
        { competencyCategoryId: 12, requestedLevel: 'intermediate' },
      ],
    });

    expect(result.submittedCount).toBe(2);
    expect(result.requestGroupId).toEqual(expect.any(String));
    expect(prismaMock.competencyChangeRequest.create).toHaveBeenCalledTimes(2);
    const rows = prismaMock.competencyChangeRequest.create.mock.calls.map((call) => call[0].data);
    expect(rows.map((row) => row.competencyCategoryId)).toEqual([11, 12]);
    expect(rows[0].requestGroupId).toBe(result.requestGroupId);
    expect(rows[1].requestGroupId).toBe(result.requestGroupId);
    expect(rows[0].note).toBe('I have been handling these tickets recently.');
  });

  test('approves every pending request in a group', async () => {
    prismaMock.competencyChangeRequest.findMany
      .mockResolvedValueOnce([
        {
          id: 21,
          workspaceId: 2,
          technicianId: 7,
          competencyCategoryId: 11,
          requestedLevel: 'basic',
          note: 'Batch note',
        },
        {
          id: 22,
          workspaceId: 2,
          technicianId: 7,
          competencyCategoryId: 12,
          requestedLevel: 'advanced',
          note: 'Batch note',
        },
      ])
      .mockResolvedValueOnce([]);

    await decideCompetencyRequestGroup(2, 'group-1', 'approved', 'admin@example.com');

    expect(prismaMock.technicianCompetency.upsert).toHaveBeenCalledTimes(2);
    expect(prismaMock.competencyChangeRequest.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: [21, 22] } },
      data: expect.objectContaining({
        status: 'approved',
        reviewedByEmail: 'admin@example.com',
      }),
    }));
  });
});
