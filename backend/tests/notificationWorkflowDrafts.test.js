import { jest } from '@jest/globals';

/**
 * QA 11-05b #1 — a place to see unpublished workflow drafts.
 *
 * The list API says, per workflow, whether it carries a saved draft nobody
 * published (`hasUnpublishedChanges`, `draftState`), when and by whom it was
 * saved, computed from the row it already reads. Seeding the defaults no
 * longer rewrites rows that are already right, so `updatedAt` stays the time
 * a person last changed the workflow.
 */
let db;
const prismaProxy = new Proxy({}, { get: (_t, prop) => db[prop] });
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaProxy }));

const repository = await import('../src/services/notificationWorkflowRepository.js');
const { workflowDraftState, withDraftState, ensureDefaultWorkflows, resetDefaultWorkflowsMemo } = repository;

const def = (label = 'Send') => ({ version: 1, nodes: [{ id: 'trigger', type: 'trigger', data: { label } }], edges: [], metadata: {} });
const row = (over = {}) => ({
  id: 7,
  archivedAt: null,
  publishedVersion: 3,
  draftDefinition: def('New text'),
  publishedDefinition: def('Old text'),
  lastChangedBy: 'alex.rivera@example.com',
  updatedAt: new Date('2026-11-05T23:12:00.000Z'),
  lastSuppressedAt: null,
  ...over,
});

describe('workflowDraftState', () => {
  test('published, and the saved draft differs from the live one: unpublished changes, saved when and by whom', () => {
    expect(workflowDraftState(row())).toEqual({
      hasUnpublishedChanges: true,
      draftState: 'unpublished',
      draftSavedAt: '2026-11-05T23:12:00.000Z',
      draftSavedBy: 'alex.rivera@example.com',
    });
  });

  test('a draft equal to what is published is not flagged, even with its keys in another order', () => {
    const published = { metadata: {}, edges: [], nodes: [{ data: { label: 'Same' }, type: 'trigger', id: 'trigger' }], version: 1 };
    expect(workflowDraftState(row({ draftDefinition: def('Same'), publishedDefinition: published })).hasUnpublishedChanges).toBe(false);
  });

  test('never published, saved by a person: Never published', () => {
    const state = workflowDraftState(row({ publishedVersion: 0, publishedDefinition: null }));
    expect(state).toMatchObject({ hasUnpublishedChanges: true, draftState: 'never_published', draftSavedBy: 'alex.rivera@example.com' });
  });

  test('a seeded default nobody touched (no lastChangedBy) is not a draft anyone made', () => {
    expect(workflowDraftState(row({ publishedVersion: 0, publishedDefinition: null, lastChangedBy: null }))).toMatchObject({ hasUnpublishedChanges: false, draftState: null });
  });

  test('archived workflows never count', () => {
    expect(workflowDraftState(row({ archivedAt: new Date() })).hasUnpublishedChanges).toBe(false);
  });

  test('when updatedAt is only the routing-suppression stamp, the time is unknown (null), the person stays', () => {
    const state = workflowDraftState(row({ lastSuppressedAt: new Date('2026-11-05T23:12:00.400Z') }));
    expect(state).toMatchObject({ hasUnpublishedChanges: true, draftSavedAt: null, draftSavedBy: 'alex.rivera@example.com' });
  });
});

describe('withDraftState', () => {
  test('adds the state and the saver’s name, looked up once by e-mail (any case)', async () => {
    const findMany = jest.fn(async () => [{ name: 'Alex Rivera', email: 'Alex.Rivera@example.com', isActive: true }]);
    db = { technician: { findMany } };
    const [a, b] = await withDraftState([row(), row({ id: 8, draftDefinition: def('Same'), publishedDefinition: def('Same') })]);
    expect(a).toMatchObject({ id: 7, hasUnpublishedChanges: true, draftSavedByName: 'Alex Rivera' });
    expect(b).toMatchObject({ id: 8, hasUnpublishedChanges: false, draftSavedByName: null });
    expect(findMany).toHaveBeenCalledTimes(1);
    const args = findMany.mock.calls[0][0];
    expect(args.where.email).toEqual({ in: ['alex.rivera@example.com'], mode: 'insensitive' });
    expect(args.select).not.toHaveProperty('photoUrl');
  });

  test('a failed name lookup still gives the state (name null)', async () => {
    db = { technician: { findMany: jest.fn(async () => { throw new Error('db down'); }) } };
    const one = await withDraftState(row());
    expect(one).toMatchObject({ hasUnpublishedChanges: true, draftSavedBy: 'alex.rivera@example.com', draftSavedByName: null });
  });

  test('no drafts: no lookup at all', async () => {
    const findMany = jest.fn(async () => []);
    db = { technician: { findMany } };
    await withDraftState([row({ draftDefinition: def('Same'), publishedDefinition: def('Same') })]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

describe('default seeding leaves rows that are already right alone', () => {
  test('existing defaults with the right values are not rewritten (updatedAt keeps the person’s time)', async () => {
    const upsert = jest.fn(async ({ create }) => create);
    // Answer the lookup with "already right" rows for every key it asks for.
    const findMany = jest.fn(async ({ where }) => where.key.in.map((key) => ({
      key, routingMode: 'exclusive', routingPriority: null, isDefaultVariant: true, archivedAt: null, archivedBy: null,
    })));
    db = { notificationWorkflow: { findMany, upsert } };
    resetDefaultWorkflowsMemo();
    await ensureDefaultWorkflows(1);
    // routingPriority null never matches a real priority, so those upsert;
    // now answer with the priorities the upsert itself wrote.
    const priorityByKey = Object.fromEntries(upsert.mock.calls.map(([args]) => [args.where.workspaceId_key.key, args.update.routingPriority]));
    upsert.mockClear();
    findMany.mockImplementation(async ({ where }) => where.key.in.map((key) => ({
      key, routingMode: 'exclusive', routingPriority: priorityByKey[key], isDefaultVariant: true, archivedAt: null, archivedBy: null,
    })));
    await ensureDefaultWorkflows(1);
    expect(upsert).not.toHaveBeenCalled();
  });

  test('a missing or wrong row is still put right; a failed lookup upserts everything', async () => {
    const upsert = jest.fn(async ({ create }) => create);
    db = { notificationWorkflow: { findMany: jest.fn(async () => { throw new Error('boom'); }), upsert } };
    await ensureDefaultWorkflows(1);
    const all = upsert.mock.calls.length;
    expect(all).toBeGreaterThan(0);

    upsert.mockClear();
    db = { notificationWorkflow: { findMany: jest.fn(async () => [{ key: 'ticket_created', routingMode: 'additive', routingPriority: 1, isDefaultVariant: true, archivedAt: null, archivedBy: null }]), upsert } };
    await ensureDefaultWorkflows(1);
    expect(upsert.mock.calls.length).toBe(all);
  });
});
