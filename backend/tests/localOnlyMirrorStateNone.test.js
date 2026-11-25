import { jest } from '@jest/globals';

/**
 * QA 11-24 #4 review: a ticket in a workspace with no FreshService link is
 * created with mirrorState 'none' (no fallback copy, no "Mirror pending"
 * chip). The AI pipeline's local-only write used to flip it to 'pending'
 * again; it now keeps 'none', and FS-linked tickets still go 'pending'.
 */

const prismaMock = {
  assignmentConfig: { findUnique: jest.fn().mockResolvedValue(null) },
  assignmentPipelineRun: { update: jest.fn().mockResolvedValue({}) },
  ticket: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  workspace: { findUnique: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: { getFreshServiceConfigForWorkspace: jest.fn(), getServiceAccountNames: jest.fn() } }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn() }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({ default: { enqueueFieldSync: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: freshServiceActionService } = await import('../src/services/freshServiceActionService.js');

const nativeTicket = (mirrorState) => ({
  id: 77, workspaceId: 12, origin: 'ticketpulse', nativeNumber: 10500, status: 'Open', mirrorState,
  tpSkill: null, tpSubskill: null,
  internalCategory: { name: 'Facilities' }, internalSubcategory: { name: 'Keys and access cards' },
});

beforeEach(() => jest.clearAllMocks());

test.each([
  ['none', 'none'],
  ['mirrored', 'pending'],
  [undefined, 'pending'],
])('category write on a ticket whose mirrorState is %s → %s', async (before, after) => {
  prismaMock.ticket.findUnique.mockResolvedValue(nativeTicket(before));
  const result = await freshServiceActionService._executeLocalOnly({ id: 5, ticketId: 77, workspaceId: 12, decision: 'rejected' }, 12, false);
  expect(result.success).toBe(true);
  expect(prismaMock.ticket.update).toHaveBeenCalledWith({
    where: { id: 77 },
    data: { tpSkill: 'Facilities', tpSubskill: 'Keys and access cards', mirrorState: after },
  });
});
