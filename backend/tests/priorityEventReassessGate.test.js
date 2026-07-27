import { jest } from '@jest/globals';

// processEvent must NOT launch a priority_changed reassessment run for
// tickets that are closed/resolved, noise, or already noise-dismissed —
// the loop that produced three duplicate courtesy notes on prod #233696.

const prismaMock = {
  ticketPriorityEvent: {
    findUnique: jest.fn(),
    update: jest.fn().mockResolvedValue({}),
    create: jest.fn(),
  },
  assignmentPipelineRun: { findFirst: jest.fn() },
};
const runPipelineMock = jest.fn().mockResolvedValue({ id: 999 });
const queueNotificationsMock = jest.fn().mockResolvedValue({ queued: 0, skipped: 'none' });

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({
  default: { runPipeline: runPipelineMock },
}));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({
  default: { queueNotificationsForPriorityChange: queueNotificationsMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: service } = await import('../src/services/ticketPriorityEventService.js');

function eventRow(ticketOverrides = {}) {
  return {
    id: 42,
    ticketId: 36249,
    workspaceId: 1,
    direction: 'lowered',
    toPriorityId: 1,
    reassessmentRunId: null,
    ticket: {
      id: 36249,
      workspaceId: 1,
      freshserviceTicketId: 233696n,
      subject: 'Maintenance Staff in Golden Server Room',
      status: 'Open',
      isNoise: false,
      assignedTechId: null,
      assignedTech: null,
      ...ticketOverrides,
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.ticketPriorityEvent.update.mockResolvedValue({});
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue(null);
});

test('closed ticket: reassessment run is NOT launched', async () => {
  prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(eventRow({ status: 'Closed' }));
  const res = await service.processEvent(42);
  expect(runPipelineMock).not.toHaveBeenCalled();
  expect(res.reassessment).toBe('skipped:ticket_already_closed');
});

test('resolved ticket: reassessment run is NOT launched', async () => {
  prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(eventRow({ status: 'Resolved' }));
  await service.processEvent(42);
  expect(runPipelineMock).not.toHaveBeenCalled();
});

test('noise ticket: reassessment run is NOT launched', async () => {
  prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(eventRow({ isNoise: true }));
  const res = await service.processEvent(42);
  expect(runPipelineMock).not.toHaveBeenCalled();
  expect(res.reassessment).toBe('skipped:ticket_is_noise');
});

test('open ticket whose last run was noise_dismissed: NOT relaunched', async () => {
  prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(eventRow());
  prismaMock.assignmentPipelineRun.findFirst.mockResolvedValue({ decision: 'noise_dismissed' });
  const res = await service.processEvent(42);
  expect(runPipelineMock).not.toHaveBeenCalled();
  expect(res.reassessment).toBe('skipped:last_run_noise_dismissed');
});

test('live open ticket: reassessment run IS launched', async () => {
  prismaMock.ticketPriorityEvent.findUnique.mockResolvedValue(eventRow());
  const res = await service.processEvent(42);
  expect(runPipelineMock).toHaveBeenCalledWith(36249, 1, 'priority_changed', expect.any(Function), null, { priorityEventId: 42 });
  expect(res.reassessment).toBe('launched');
});
