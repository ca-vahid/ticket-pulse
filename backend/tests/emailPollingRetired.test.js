import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

/**
 * MB-1f — the legacy assignment-pipeline mailbox poller is retired:
 * nothing boots it, startAll()/startForWorkspace() are no-ops (one log line),
 * pollNow() refuses, and no Graph or DB traffic happens.
 */

const prismaMock = { assignmentConfig: { findMany: jest.fn(), update: jest.fn() }, ticket: { findFirst: jest.fn(), findMany: jest.fn() } };
const graphMock = { isConfigured: jest.fn(() => true), getNewEmails: jest.fn() };
const loggerMock = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
const cronScheduleMock = jest.fn(() => ({ stop: jest.fn() }));

jest.unstable_mockModule('node-cron', () => ({ default: { schedule: cronScheduleMock } }));
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/integrations/graphMailClient.js', () => ({ default: graphMock }));
jest.unstable_mockModule('../src/services/assignmentRepository.js', () => ({ default: { getConfig: jest.fn(), hasActivePipelineRun: jest.fn() } }));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: jest.fn() } }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: loggerMock }));

const { default: emailPollingService } = await import('../src/services/emailPollingService.js');

const here = path.dirname(fileURLToPath(import.meta.url));
const read = (rel) => readFileSync(path.join(here, '..', rel), 'utf8');

describe('legacy emailPollingService is retired (MB-1f)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('startAll() / startForWorkspace() are no-ops: no config query, no scheduling, one retirement log line', async () => {
    await emailPollingService.startAll();
    await emailPollingService.startAll();
    emailPollingService.startForWorkspace({ workspaceId: 1, emailPollingEnabled: true, monitoredMailbox: 'it@example.com', emailPollingIntervalSec: 30 });

    expect(prismaMock.assignmentConfig.findMany).not.toHaveBeenCalled();
    expect(cronScheduleMock).not.toHaveBeenCalled();
    expect(graphMock.getNewEmails).not.toHaveBeenCalled();
    expect(emailPollingService.getStatus(1)).toMatchObject({ running: false, retired: true });
    expect(loggerMock.info).toHaveBeenCalledTimes(1);
    expect(loggerMock.info.mock.calls[0][0]).toMatch(/retired/i);
  });

  test('pollNow() refuses without touching Graph', async () => {
    const result = await emailPollingService.pollNow(1);
    expect(result).toMatchObject({ success: false, retired: true });
    expect(graphMock.getNewEmails).not.toHaveBeenCalled();
  });

  test('nothing boots or drives it any more (scheduledSyncService, assignment.routes)', () => {
    expect(read('src/services/scheduledSyncService.js')).not.toMatch(/import emailPollingService/);
    const routes = read('src/routes/assignment.routes.js');
    expect(routes).not.toMatch(/import emailPollingService/);
    expect(routes).not.toMatch(/emailPollingService\.(startForWorkspace|stopForWorkspace|pollNow|getStatus)/);
    // retire-don't-delete: the config columns are still persisted
    expect(routes).toMatch(/data\.monitoredMailbox = monitoredMailbox/);
    expect(routes).toMatch(/data\.emailPollingEnabled = emailPollingEnabled/);
  });
});
