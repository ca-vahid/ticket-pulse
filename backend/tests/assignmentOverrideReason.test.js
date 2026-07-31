import { jest } from '@jest/globals';

/** Correction feedback loop v1 (QA 07-30 S7) — one-click override reasons. */

const prismaMock = {
  assignmentPipelineRun: { findMany: jest.fn() },
  technician: { findMany: jest.fn() },
  assignmentCorrection: { create: jest.fn() },
  workspace: { findUnique: jest.fn() },
};
const appendFeedback = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { appendFeedback } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: assignmentCorrectionService, OVERRIDE_REASON_CODES } = await import('../src/services/assignmentCorrectionService.js');

const CORRECTABLE_RUN = {
  id: 501,
  ticketId: 42,
  workspaceId: 1,
  decision: 'auto_assigned',
  status: 'completed',
  syncStatus: 'synced',
  assignedTechId: 7,
  ticket: { freshserviceTicketId: 220123, subject: 'VPN keeps dropping' },
};

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.technician.findMany.mockResolvedValue([
    { id: 7, name: 'AI Pick' },
    { id: 9, name: 'Chosen Tech' },
  ]);
  prismaMock.assignmentCorrection.create.mockImplementation(async ({ data }) => ({ id: 900, ...data }));
  prismaMock.workspace.findUnique.mockResolvedValue({ defaultTimezone: 'America/Los_Angeles' });
  appendFeedback.mockResolvedValue(undefined);
});

describe('recordManualReassignReason', () => {
  test('correctable run → creates a correction with the reason code and canned reason', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([CORRECTABLE_RUN]);

    const result = await assignmentCorrectionService.recordManualReassignReason(42, 1, {
      toTechnicianId: 9,
      reasonCode: 'wrong_skill',
      actorEmail: 'coordinator@example.com',
    });

    expect(result).toMatchObject({ id: 900, reasonCode: 'wrong_skill' });
    expect(prismaMock.assignmentCorrection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        workspaceId: 1,
        pipelineRunId: 501,
        ticketId: 42,
        fromTechnicianId: 7,
        toTechnicianId: 9,
        selectionSource: 'manual',
        reasonCode: 'wrong_skill',
        reason: OVERRIDE_REASON_CODES.wrong_skill,
        createdByEmail: 'coordinator@example.com',
        freshserviceSyncStatus: 'not_required',
      }),
    });
    // The summary line must reach the assignment LLM feedback log.
    expect(appendFeedback).toHaveBeenCalledTimes(1);
    const [workspaceId, entry] = appendFeedback.mock.calls[0];
    expect(workspaceId).toBe(1);
    expect(entry).toContain('Ticket #220123 (VPN keeps dropping)');
    expect(entry).toContain('Original: AI Pick');
    expect(entry).toContain('Corrected: Chosen Tech');
    expect(entry).toContain('Reason code: wrong_skill');
  });

  test('free-text reason wins over the canned sentence', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([CORRECTABLE_RUN]);

    await assignmentCorrectionService.recordManualReassignReason(42, 1, {
      toTechnicianId: 9,
      reasonCode: 'other',
      reason: 'Requester specifically asked for this technician.',
      actorEmail: 'coordinator@example.com',
    });

    expect(prismaMock.assignmentCorrection.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reasonCode: 'other',
        reason: 'Requester specifically asked for this technician.',
      }),
    });
  });

  test('no correctable run → returns null and writes nothing', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([
      { id: 502, decision: 'pending_review', status: 'completed', syncStatus: null, assignedTechId: null },
      { id: 503, decision: 'auto_assigned', status: 'failed', syncStatus: 'failed', assignedTechId: 7 },
    ]);

    const result = await assignmentCorrectionService.recordManualReassignReason(42, 1, {
      toTechnicianId: 9,
      reasonCode: 'availability',
      actorEmail: 'coordinator@example.com',
    });

    expect(result).toBeNull();
    expect(prismaMock.assignmentCorrection.create).not.toHaveBeenCalled();
    expect(appendFeedback).not.toHaveBeenCalled();
  });

  test('unknown reason code or missing target tech → null without touching the DB', async () => {
    await expect(assignmentCorrectionService.recordManualReassignReason(42, 1, {
      toTechnicianId: 9,
      reasonCode: 'because',
    })).resolves.toBeNull();
    await expect(assignmentCorrectionService.recordManualReassignReason(42, 1, {
      reasonCode: 'wrong_skill',
    })).resolves.toBeNull();
    expect(prismaMock.assignmentPipelineRun.findMany).not.toHaveBeenCalled();
    expect(prismaMock.assignmentCorrection.create).not.toHaveBeenCalled();
  });

  test('reassigning to the run\'s own pick is not an override', async () => {
    prismaMock.assignmentPipelineRun.findMany.mockResolvedValue([CORRECTABLE_RUN]);

    const result = await assignmentCorrectionService.recordManualReassignReason(42, 1, {
      toTechnicianId: 7,
      reasonCode: 'load_balancing',
    });

    expect(result).toBeNull();
    expect(prismaMock.assignmentCorrection.create).not.toHaveBeenCalled();
  });
});
