import { jest } from '@jest/globals';

/**
 * scripts/convert-workflow-rules.mjs (14 Oct 2026): dry run by default; on
 * --apply it publishes a new version the way the editor does. Prisma mocked.
 */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { runConversion } = await import('../scripts/convert-workflow-rules.mjs');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const NOISE = { '!=': [{ var: 'ticket.isNoise' }, true] };
const STATUS = { in: [{ var: 'ticket.status' }, ['Resolved', 'Closed']] };

/** A published default with the old raw noise rule on its first step. */
function legacyArrived() {
  const d = buildDefaultWorkflowDefinition('ticket.created');
  d.nodes.find((n) => n.id === 'skip-noise').data = { label: 'Skip noise tickets', rule: NOISE };
  return d;
}
function legacyReopen(rule = STATUS) {
  const d = buildDefaultWorkflowDefinition('ticket.reply_received');
  d.nodes.find((n) => n.id === 'is-resolved').data = { label: 'Ticket already resolved or closed?', rule };
  return d;
}
const wf = (id, workspaceId, triggerType, published, draft = published) => ({
  id, workspaceId, name: `wf ${id}`, triggerType, isEnabled: true, mockModeEnabled: false, publishedVersion: 3,
  publishedDefinition: published, draftDefinition: draft,
});

function prismaWith(workflows) {
  const tx = {
    notificationWorkflowVersion: {
      findMany: jest.fn().mockResolvedValue([{ version: 1 }, { version: 3 }, { version: 4 }]),
      create: jest.fn(({ data }) => Promise.resolve({ id: 1, publishedAt: new Date('2026-10-14T20:00:00Z'), ...data })),
    },
    notificationWorkflow: { update: jest.fn().mockResolvedValue({}) },
  };
  return {
    tx,
    notificationWorkflow: { findMany: jest.fn().mockResolvedValue(workflows) },
    $transaction: jest.fn((fn) => fn(tx)),
  };
}

const quiet = () => {};

test('dry run: converts the noise and status rules, skips unpublished edits, writes nothing', async () => {
  const withEdits = legacyArrived();
  const prisma = prismaWith([
    wf(1, 1, 'ticket.created', legacyArrived()),
    wf(2, 5, 'ticket.reply_received', legacyReopen()),
    wf(3, 2, 'ticket.created', legacyArrived(), { ...withEdits, metadata: { ...withEdits.metadata, label: 'edited' } }),
    wf(4, 3, 'ticket.created', null, legacyArrived()),
    wf(5, 1, 'ticket.created', buildDefaultWorkflowDefinition('ticket.created')),
  ]);
  const lines = [];
  const out = await runConversion({ prisma, log: (l) => lines.push(l) });
  expect(out).toMatchObject({ planned: 2, written: 0, skipped: 2 });
  expect(prisma.$transaction).not.toHaveBeenCalled();
  expect(prisma.notificationWorkflow.findMany.mock.calls[0][0].where).toEqual({ archivedAt: null, workspaceId: { in: [1, 2, 3, 4, 5] } });
  const text = lines.join('\n');
  expect(text).toContain('old rule: {"!=":[{"var":"ticket.isNoise"},true]}');
  expect(text).toContain('new:      Every ticket continues, except noise or spam.');
  expect(text).toContain('new:      Continues when the ticket status is Resolved or Closed.');
  expect(text).toContain('verdict:  CONVERT');
  expect(text).toContain('SKIPPED: the draft has unpublished edits');
  expect(text).toContain('SKIPPED: never published');
  // #5 already uses rows: not listed at all.
  expect(text).not.toContain('#5 ');
});

test('--apply publishes a new version (max + 1), draft and published together, enabled state untouched', async () => {
  const prisma = prismaWith([wf(2, 5, 'ticket.reply_received', legacyReopen())]);
  const out = await runConversion({ prisma, apply: true, log: quiet });
  expect(out).toMatchObject({ planned: 1, written: 1 });
  const version = prisma.tx.notificationWorkflowVersion.create.mock.calls[0][0].data;
  expect(version).toMatchObject({ workspaceId: 5, workflowId: 2, version: 5, publishedBy: 'convert-workflow-rules script' });
  expect(version.changeNote).toMatch(/builder rows instead of code/);
  const step = version.definition.nodes.find((n) => n.id === 'is-resolved');
  expect(step.data).toEqual({ label: 'Ticket already resolved or closed?', conditionGroup: { logic: 'all', conditions: [{ field: 'ticket.status', operator: 'in', value: ['Resolved', 'Closed'] }] } });
  const update = prisma.tx.notificationWorkflow.update.mock.calls[0][0];
  expect(update.where).toEqual({ id: 2 });
  expect(update.data.draftDefinition).toEqual(update.data.publishedDefinition);
  expect(update.data.publishedVersion).toBe(5);
  expect(update.data).not.toHaveProperty('isEnabled');
  expect(update.data).not.toHaveProperty('mockModeEnabled');
});

test('a rule that can not convert stays code and nothing is published', async () => {
  const prisma = prismaWith([wf(6, 1, 'ticket.reply_received', legacyReopen({ '===': [{ var: 'ticket.status' }, 'Closed'] }))]);
  const lines = [];
  const out = await runConversion({ prisma, apply: true, log: (l) => lines.push(l) });
  expect(out).toMatchObject({ planned: 0, written: 0 });
  expect(lines.join('\n')).toContain('verdict:  KEEP');
  expect(prisma.$transaction).not.toHaveBeenCalled();
});

test('sandboxes are refused', async () => {
  await expect(runConversion({ prisma: prismaWith([]), onlyWorkspace: 7, log: quiet })).rejects.toThrow(/never touched/);
});
