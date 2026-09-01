import { jest } from '@jest/globals';

/**
 * NT-5 — self-citation loop fix for search_decision_notes.
 *
 * The tool used to filter only on `decidedAt NOT NULL`, which served the model
 * its own machine-generated noise_dismissed runs as "admin decision notes"
 * (a self-reinforcing precedent loop observed in prod). The result is now split
 * into two explicitly labeled buckets:
 *   - adminDecisions   (decidedByEmail set — a human made the call)
 *   - automatedOutcomes (decidedByEmail null — the pipeline's own history)
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  assignmentPipelineRun: { findMany: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({
  default: { getFreshServiceConfigForWorkspace: jest.fn() },
}));

jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({
  createFreshServiceClient: jest.fn(),
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

const adminRun = {
  id: 101,
  decision: 'modified',
  decisionNote: 'Package tickets always go to the shipping-room queue.',
  overrideReason: 'Routing preference',
  decidedByEmail: 'coordinator@example.com',
  decidedAt: new Date('2026-08-01T17:00:00Z'),
  assignedTechId: 7,
  assignedTech: { name: 'Dana Ops' },
  ticket: { freshserviceTicketId: BigInt(239000), subject: 'Package at reception', ticketCategory: 'Facilities', category: null },
  recommendation: { recommendations: [{ techName: 'Someone Else' }] },
};

const automatedRun = {
  id: 202,
  decision: 'noise_dismissed',
  decisionNote: null,
  overrideReason: null,
  decidedByEmail: null,
  decidedAt: new Date('2026-08-20T09:00:00Z'),
  assignedTechId: null,
  assignedTech: null,
  ticket: { freshserviceTicketId: BigInt(239931), subject: 'Package waiting in shipping room', ticketCategory: 'Noise', category: null },
  recommendation: { recommendations: [] },
};

describe('search_decision_notes bucket split (NT-5)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Los_Angeles' });
    prismaMock.assignmentPipelineRun.findMany.mockImplementation(({ where }) => {
      // Human bucket query filters decidedByEmail NOT NULL; machine bucket
      // filters decidedByEmail null.
      if (where.decidedByEmail && where.decidedByEmail.not === null) {
        return Promise.resolve([adminRun]);
      }
      if (where.decidedByEmail === null) {
        return Promise.resolve([automatedRun]);
      }
      return Promise.resolve([]);
    });
  });

  test('splits human decisions and automated outcomes into separate labeled buckets', async () => {
    const result = await executeTool('search_decision_notes', { query: 'package shipping' }, { workspaceId: 1 });

    // Both DB queries constrain on decidedAt AND decidedByEmail.
    expect(prismaMock.assignmentPipelineRun.findMany).toHaveBeenCalledTimes(2);
    const wheres = prismaMock.assignmentPipelineRun.findMany.mock.calls.map(([args]) => args.where);
    expect(wheres).toEqual(expect.arrayContaining([
      expect.objectContaining({ decidedAt: { not: null }, decidedByEmail: { not: null } }),
      expect.objectContaining({ decidedAt: { not: null }, decidedByEmail: null }),
    ]));

    // Bucket labels are explicit so the model cannot conflate them.
    expect(result.adminDecisions.label).toContain('ADMIN DECISIONS');
    expect(result.adminDecisions.label).toContain('human precedent');
    expect(result.automatedOutcomes.label).toContain('AUTOMATED OUTCOMES');
    expect(result.automatedOutcomes.label).toContain('NOT precedent');
    expect(result.guidance).toMatch(/NEVER a sufficient basis/i);

    // Human decision lands in adminDecisions with its note intact.
    expect(result.adminDecisions.totalMatches).toBe(1);
    expect(result.adminDecisions.notes[0]).toMatchObject({
      runId: 101,
      decision: 'modified',
      decidedBy: 'coordinator@example.com',
      decisionNote: 'Package tickets always go to the shipping-room queue.',
    });

    // Machine outcome lands in automatedOutcomes, flagged automated.
    expect(result.automatedOutcomes.totalMatches).toBe(1);
    expect(result.automatedOutcomes.outcomes[0]).toMatchObject({
      runId: 202,
      decision: 'noise_dismissed',
      decidedBy: null,
      automated: true,
    });
  });

  test('automated runs never appear in adminDecisions', async () => {
    const result = await executeTool('search_decision_notes', { query: 'shipping' }, { workspaceId: 1 });

    const adminRunIds = result.adminDecisions.notes.map((n) => n.runId);
    expect(adminRunIds).not.toContain(202);
    // No adminDecisions entry may lack a human decider.
    for (const note of result.adminDecisions.notes) {
      expect(note.decidedBy).toBeTruthy();
    }
  });

  test('a workspace with only automated history returns an empty adminDecisions bucket', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockImplementation(({ where }) => {
      if (where.decidedByEmail === null) {
        return Promise.resolve([automatedRun, { ...automatedRun, id: 203 }]);
      }
      return Promise.resolve([]);
    });

    const result = await executeTool('search_decision_notes', { query: 'package' }, { workspaceId: 1 });

    expect(result.adminDecisions.totalMatches).toBe(0);
    expect(result.adminDecisions.notes).toEqual([]);
    expect(result.automatedOutcomes.totalMatches).toBe(2);
    expect(result.automatedOutcomes.label).toContain('NOT precedent');
  });

  test('bounds each bucket by the limit cap (max 20)', async () => {
    await executeTool('search_decision_notes', { query: 'vpn', limit: 500 }, { workspaceId: 1 });

    for (const [args] of prismaMock.assignmentPipelineRun.findMany.mock.calls) {
      expect(args.take).toBeLessThanOrEqual(20);
    }
  });

  test('requires a query', async () => {
    const result = await executeTool('search_decision_notes', { query: '   ' }, { workspaceId: 1 });
    expect(result.error).toBe('query is required');
  });

  test('tool schema tells the model automatedOutcomes are not precedent', () => {
    const schema = TOOL_SCHEMAS.find((t) => t.name === 'search_decision_notes');
    expect(schema).toBeDefined();
    expect(schema.description).toContain('adminDecisions');
    expect(schema.description).toContain('automatedOutcomes');
    expect(schema.description).toMatch(/NOT precedent/);
  });
});
