import { jest } from '@jest/globals';

/**
 * QA 11-23 item 5 (second-look review SHOULD 3): the same-day repeat raise
 * leaves its history row where the ticket's REAL priority changes — the
 * priority write-back — with source 'repeat_report' and from = the ticket's
 * real prior level. No row when nothing changed (dry run, write-back off, the
 * level already there), and never a second 'ai_assessment' row for it.
 */
const prismaMock = {
  assignmentConfig: { findUnique: jest.fn() },
  assignmentPipelineRun: { findUnique: jest.fn(), update: jest.fn() },
  ticket: { findUnique: jest.fn(), update: jest.fn() },
};
const recordPriorityChange = jest.fn();
const settingsRepositoryMock = { getFreshServiceConfigForWorkspace: jest.fn() };
const client = { updateTicketPriority: jest.fn() };

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/settingsRepository.js', () => ({ default: settingsRepositoryMock }));
jest.unstable_mockModule('../src/integrations/freshservice.js', () => ({ createFreshServiceClient: jest.fn(() => client) }));
jest.unstable_mockModule('../src/services/priorityHistoryService.js', () => ({ recordPriorityChange }));
jest.unstable_mockModule('../src/services/notificationPreferenceService.js', () => ({ default: { queueNotificationsForAssignment: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { default: service, repeatReportFor } = await import('../src/services/freshServiceActionService.js');

const REPEAT = { raised: true, aiPriority: 'Medium', raisedTo: 'High', relatedTicketId: 2000, relatedRef: 'TP-1042', historyNote: 'Same problem reported again today (TP-1042)' };
const runWith = ({ priority = 2, assessed = 'High', repeatReport = REPEAT } = {}) => ({
  id: 3101, ticketId: 2001, workspaceId: 1,
  recommendation: { assessedPriority: assessed, ...(repeatReport ? { repeatReport } : {}) },
  ticket: {
    id: 2001, freshserviceTicketId: 222999, priority, assessedPriority: assessed,
    assessedPriorityId: { Low: 1, Medium: 2, High: 3, Urgent: 4 }[assessed], priorityRationale: 'One person blocked.',
  },
});

beforeEach(() => {
  jest.clearAllMocks();
  prismaMock.assignmentConfig.findUnique.mockResolvedValue({ priorityWritebackEnabled: true });
  prismaMock.assignmentPipelineRun.update.mockResolvedValue({});
  prismaMock.ticket.update.mockResolvedValue({});
  settingsRepositoryMock.getFreshServiceConfigForWorkspace.mockResolvedValue({ domain: 'example.freshservice.com', apiKey: 'k' });
  client.updateTicketPriority.mockResolvedValue({});
  recordPriorityChange.mockResolvedValue({ id: 1 });
});

test('the raise written to the ticket is ONE repeat_report row, from the real prior level', async () => {
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(runWith({ priority: 2 }));
  await service.executePriorityWriteback(3101, 1, false);
  expect(recordPriorityChange).toHaveBeenCalledTimes(1);
  expect(recordPriorityChange).toHaveBeenCalledWith(expect.objectContaining({
    ticketId: 2001, from: 2, to: 3, source: 'repeat_report', note: 'Same problem reported again today (TP-1042)',
    details: expect.objectContaining({ pipelineRunId: 3101, relatedTicketId: 2000, relatedRef: 'TP-1042' }),
  }));
});

test('a level held at an earlier raise (keptAt) is named as the repeat too', async () => {
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(runWith({
    priority: 2, repeatReport: { raised: false, notRaisedReason: 'already_raised', keptAt: 'High', relatedRef: 'TP-1042' },
  }));
  await service.executePriorityWriteback(3101, 1, false);
  expect(recordPriorityChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'repeat_report', note: 'Same problem reported again today (TP-1042)' }));
});

test('no raise, or the AI\'s own level: an ai_assessment row as before', async () => {
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(runWith({ assessed: 'High', repeatReport: null }));
  await service.executePriorityWriteback(3101, 1, false);
  expect(recordPriorityChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai_assessment', note: 'One person blocked.' }));
  recordPriorityChange.mockClear();
  // An after-hours "kept at High" run writes the AI's own High: not a repeat raise.
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(runWith({
    assessed: 'High', repeatReport: { raised: false, notRaisedReason: 'after_hours', keptAt: null },
  }));
  await service.executePriorityWriteback(3101, 1, false);
  expect(recordPriorityChange).toHaveBeenCalledWith(expect.objectContaining({ source: 'ai_assessment' }));
});

test('dry run or write-back off: the priority never changes, so no row at all', async () => {
  prismaMock.assignmentPipelineRun.findUnique.mockResolvedValue(runWith());
  await service.executePriorityWriteback(3101, 1, true);
  prismaMock.assignmentConfig.findUnique.mockResolvedValue({ priorityWritebackEnabled: false });
  await service.executePriorityWriteback(3101, 1, false);
  expect(recordPriorityChange).not.toHaveBeenCalled();
  expect(client.updateTicketPriority).not.toHaveBeenCalled();
});

test('repeatReportFor matches only the level being written', () => {
  expect(repeatReportFor({ repeatReport: REPEAT }, 'High')).toMatchObject({ relatedRef: 'TP-1042' });
  expect(repeatReportFor({ repeatReport: REPEAT }, 'Urgent')).toBeNull();
  expect(repeatReportFor({}, 'High')).toBeNull();
  expect(repeatReportFor(null, 'High')).toBeNull();
});
