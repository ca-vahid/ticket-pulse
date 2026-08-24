import { jest } from '@jest/globals';

/**
 * Mega 08-23 Phase TF — admin-editable new-ticket form per workspace.
 *  - normalizeFields: fixed vocabulary (unknown/dupe keys rejected),
 *    requester+subject forced visible+required, hidden drops required,
 *    defaults filled in, priority defaultValue validated
 *  - resolve/getResolvedForm: fallbacks, defaultSource whitelist, group
 *    surfacing (FS preselect wins; else Workspace.defaultInternalGroupId)
 *  - getMeta.form shape
 *  - createTicket: defaultSource ONLY when the request omits source and only
 *    on the Agent channel; enforceRequired binds required built-ins + custom
 *    fields (and only when the flag is passed)
 */

const prismaMock = {
  workspace: { findUnique: jest.fn() },
  technician: { findFirst: jest.fn(), findMany: jest.fn() },
  queueCardConfig: { findUnique: jest.fn(), upsert: jest.fn() },
  ticketFormConfig: { findUnique: jest.fn(), upsert: jest.fn(), delete: jest.fn() },
  customFieldDefinition: { findMany: jest.fn().mockResolvedValue([]), create: jest.fn(), findFirst: jest.fn() },
  ticket: { create: jest.fn(), findFirst: jest.fn(), findUnique: jest.fn(), update: jest.fn(), count: jest.fn(), findMany: jest.fn(), groupBy: jest.fn() },
  competencyCategory: { findFirst: jest.fn(), findMany: jest.fn() },
  group: { findFirst: jest.fn(), findMany: jest.fn() },
  requester: { findUnique: jest.fn() },
  ticketAssignmentEpisode: { create: jest.fn(), updateMany: jest.fn() },
  approvalCategory: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTag: { findMany: jest.fn().mockResolvedValue([]) },
  categoryGroupLink: { findMany: jest.fn().mockResolvedValue([]) },
  ticketTypeDefinition: { findMany: jest.fn().mockResolvedValue([]) },
  ticketStatusDefinition: {
    findMany: jest.fn().mockResolvedValue([
      { id: 1, workspaceId: 1, name: 'Open', baseStatus: 'Open', sortOrder: 0, isSystem: true, isActive: true },
      { id: 2, workspaceId: 1, name: 'Pending', baseStatus: 'Pending', sortOrder: 1, isSystem: true, isActive: true },
      { id: 3, workspaceId: 1, name: 'Resolved', baseStatus: 'Resolved', sortOrder: 2, isSystem: true, isActive: true },
      { id: 4, workspaceId: 1, name: 'Closed', baseStatus: 'Closed', sortOrder: 3, isSystem: true, isActive: true },
    ]),
  },
  slaPolicy: { findFirst: jest.fn() },
  $queryRaw: jest.fn(),
};
const noiseRuleServiceMock = { evaluate: jest.fn() };
const requesterRepositoryMock = { findByEmail: jest.fn(), createNative: jest.fn() };
const runPipelineMock = jest.fn();

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.unstable_mockModule('../src/services/noiseRuleService.js', () => ({ default: noiseRuleServiceMock }));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({ default: { create: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketThreadRepository.js', () => ({ default: { listForTicket: jest.fn() } }));
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: { emitTicketEvent: jest.fn(), emitTicketLifecycleNotifications: jest.fn().mockResolvedValue({ status: 'completed' }) },
}));
jest.unstable_mockModule('../src/services/requesterRepository.js', () => ({ default: requesterRepositoryMock }));
jest.unstable_mockModule('../src/services/sendgridNotificationService.js', () => ({ default: { sendEmail: jest.fn() } }));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
jest.unstable_mockModule('../src/services/assignmentPipelineService.js', () => ({ default: { runPipeline: runPipelineMock } }));
jest.unstable_mockModule('../src/services/azureAdService.js', () => ({ default: { getUserProfile: jest.fn().mockResolvedValue(null) } }));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: {
    enqueueTicketCreate: jest.fn().mockResolvedValue({ id: 1 }),
    enqueueFieldSync: jest.fn(), enqueueThreadEntry: jest.fn(),
    getClient: jest.fn(), getInteractiveClient: jest.fn(),
  },
}));

const { default: ticketService } = await import('../src/services/ticketService.js');
const { default: ticketFormConfigService, BUILT_IN_FIELD_KEYS, normalizeFields } = await import('../src/services/ticketFormConfigService.js');
const { ValidationError } = await import('../src/utils/errors.js');

const actor = { email: 'coord@example.com', name: 'Cora Coordinator', role: 'viewer', technicianId: null, kind: 'member' };

function armCreateDefaults() {
  prismaMock.workspace.findUnique.mockResolvedValue({
    id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true, defaultInternalGroupId: null,
  });
  requesterRepositoryMock.findByEmail.mockResolvedValue({
    id: 40, name: 'Rita Requester', email: 'rita@example.com', department: 'Finance', freshserviceId: null,
  });
  noiseRuleServiceMock.evaluate.mockResolvedValue({ isNoise: false, ruleId: null });
  prismaMock.$queryRaw.mockResolvedValue([{ nextval: 1042 }]);
  prismaMock.ticket.create.mockImplementation(({ data }) => Promise.resolve({
    id: 501,
    ...data,
    requester: { id: 40, name: 'Rita Requester', email: 'rita@example.com' },
    assignedTech: null,
    internalCategory: null,
    internalSubcategory: null,
  }));
  prismaMock.ticketAssignmentEpisode.create.mockResolvedValue({ id: 1 });
  prismaMock.ticketFormConfig.findUnique.mockResolvedValue(null);
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([]);
  runPipelineMock.mockResolvedValue({ id: 900 });
}

beforeEach(() => {
  jest.clearAllMocks();
  armCreateDefaults();
});

const createdSource = () => prismaMock.ticket.create.mock.calls[0][0].data.source;

// ------------------------------------------------- vocabulary validation (TF2)

describe('normalizeFields — fixed built-in vocabulary', () => {
  test('null → the complete default vocabulary, requester+subject required', () => {
    const fields = normalizeFields(null);
    expect(fields.map((f) => f.key)).toEqual(BUILT_IN_FIELD_KEYS);
    expect(fields.every((f) => f.visible)).toBe(true);
    expect(fields.filter((f) => f.required).map((f) => f.key)).toEqual(['requester', 'subject']);
  });

  test('unknown keys are rejected', () => {
    expect(() => normalizeFields([{ key: 'department' }])).toThrow(/Unknown form field "department"/);
  });

  test('duplicate keys are rejected', () => {
    expect(() => normalizeFields([{ key: 'tags' }, { key: 'tags' }])).toThrow(/Duplicate form field/);
  });

  test('requester and subject cannot be hidden or made optional', () => {
    const fields = normalizeFields([
      { key: 'requester', visible: false, required: false },
      { key: 'subject', visible: false, required: false },
    ]);
    const requester = fields.find((f) => f.key === 'requester');
    const subject = fields.find((f) => f.key === 'subject');
    expect(requester).toEqual(expect.objectContaining({ visible: true, required: true }));
    expect(subject).toEqual(expect.objectContaining({ visible: true, required: true }));
  });

  test('hiding a field silently drops its required flag (the composer could never satisfy it)', () => {
    const fields = normalizeFields([{ key: 'description', visible: false, required: true }]);
    expect(fields.find((f) => f.key === 'description')).toEqual(expect.objectContaining({ visible: false, required: false }));
  });

  test('priority/type/source are never requirable; priority defaults validate 1–4', () => {
    const fields = normalizeFields([{ key: 'priority', required: true, defaultValue: '3' }]);
    expect(fields.find((f) => f.key === 'priority')).toEqual(expect.objectContaining({ required: false, defaultValue: '3' }));
    expect(() => normalizeFields([{ key: 'priority', defaultValue: '9' }])).toThrow(/defaultValue/);
    // Non-defaultable keys drop stray defaults instead of storing junk.
    expect(normalizeFields([{ key: 'description', defaultValue: 'boo' }]).find((f) => f.key === 'description').defaultValue).toBeNull();
  });

  test('a partial payload is completed — every built-in key is always present', () => {
    const fields = normalizeFields([{ key: 'group', visible: false }]);
    expect(fields).toHaveLength(BUILT_IN_FIELD_KEYS.length);
    expect(fields.find((f) => f.key === 'group').visible).toBe(false);
    expect(fields.find((f) => f.key === 'cc').visible).toBe(true);
  });
});

// ------------------------------------------------------- resolve + meta (TF2)

describe('resolve / getMeta.form', () => {
  test('no config row → composer-compatible fallbacks (source 103, assignMode none)', async () => {
    prismaMock.workspace.findUnique.mockResolvedValue({
      id: 1, name: 'IT', isActive: true, nativeTicketingEnabled: true, defaultInternalGroupId: null,
    });
    prismaMock.group.findMany.mockResolvedValue([]);
    prismaMock.technician.findMany.mockResolvedValue([]);
    prismaMock.competencyCategory.findMany.mockResolvedValue([]);
    prismaMock.ticket.groupBy.mockResolvedValue([]);
    prismaMock.ticket.count.mockResolvedValue(0);
    prismaMock.queueCardConfig.findUnique.mockResolvedValue(null);

    const meta = await ticketService.getMeta(1);
    expect(meta.form.fields.map((f) => f.key)).toEqual(BUILT_IN_FIELD_KEYS);
    expect(meta.form.fields[0]).toEqual(expect.objectContaining({ key: 'requester', label: 'Requester', locked: true, visible: true, required: true }));
    expect(meta.form.defaultSource).toBe(103);
    expect(meta.form.defaultGroup).toBeNull();
    expect(meta.form.defaults).toEqual({ notifyRequester: true, aiClassify: true, assignMode: 'none' });
  });

  test('Workspace.defaultInternalGroupId is SURFACED as the composer default group', () => {
    const form = ticketFormConfigService.resolve(null, { defaultInternalGroupId: 5 });
    expect(form.defaultGroup).toEqual({ kind: 'internal', id: '5' });
  });

  test('a configured FS default group wins over the internal default', () => {
    const form = ticketFormConfigService.resolve({ defaultGroupId: 9000n }, { defaultInternalGroupId: 5 });
    expect(form.defaultGroup).toEqual({ kind: 'fs', id: '9000' });
  });

  test('an out-of-whitelist stored defaultSource resolves to Agent (103)', () => {
    expect(ticketFormConfigService.resolve({ defaultSource: 999 }, null).defaultSource).toBe(103);
  });

  test('stored garbage fields never break resolution', () => {
    const form = ticketFormConfigService.resolve({ fields: [{ key: 'hacked' }] }, null);
    expect(form.fields.map((f) => f.key)).toEqual(BUILT_IN_FIELD_KEYS);
  });
});

// ------------------------------------------------------------ update() (TF2)

describe('ticketFormConfigService.update', () => {
  beforeEach(() => {
    prismaMock.ticketFormConfig.upsert.mockImplementation(({ update, create }) => Promise.resolve({ id: 1, workspaceId: 1, ...create, ...update }));
    prismaMock.ticketFormConfig.delete.mockResolvedValue({});
    prismaMock.workspace.findUnique.mockResolvedValue({ id: 1, defaultInternalGroupId: null });
  });

  test('defaultSource must be an agent-selectable channel', async () => {
    await expect(ticketFormConfigService.update(1, { defaultSource: 555 })).rejects.toThrow(ValidationError);
    await ticketFormConfigService.update(1, { defaultSource: 3 });
    expect(prismaMock.ticketFormConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ defaultSource: 3 }),
    }));
  });

  test('defaultGroupId must match an active FS group in the workspace', async () => {
    prismaMock.group.findFirst.mockResolvedValue(null);
    await expect(ticketFormConfigService.update(1, { defaultGroupId: '9000' })).rejects.toThrow(/does not match an active FreshService group/);
    prismaMock.group.findFirst.mockResolvedValue({ id: 3 });
    await ticketFormConfigService.update(1, { defaultGroupId: '9000' });
    expect(prismaMock.ticketFormConfig.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ defaultGroupId: 9000n }),
    }));
  });

  test('defaults.assignMode is whitelisted (ai | none)', async () => {
    await expect(ticketFormConfigService.update(1, { defaults: { assignMode: 'me' } })).rejects.toThrow(/assignMode/);
  });

  test('reset:true deletes the row and returns the resolved defaults', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue(null);
    const form = await ticketFormConfigService.update(1, { reset: true });
    expect(prismaMock.ticketFormConfig.delete).toHaveBeenCalledWith({ where: { workspaceId: 1 } });
    expect(form.defaultSource).toBe(103);
  });

  test('an empty body is rejected', async () => {
    await expect(ticketFormConfigService.update(1, {})).rejects.toThrow(/Nothing to update/);
  });
});

// -------------------------------------------- createTicket integration (TF2)

describe('createTicket — defaultSource only when the request omits source', () => {
  test('omitted source on the Agent channel takes the configured default', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue({ defaultSource: 3 }); // Phone
    await ticketService.createTicket(1, { subject: 'Printer jam again', requesterEmail: 'rita@example.com' }, actor);
    expect(createdSource()).toBe(3);
  });

  test('an explicit source always wins over the default', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue({ defaultSource: 3 });
    await ticketService.createTicket(1, { subject: 'Walk-up request', requesterEmail: 'rita@example.com', source: 9 }, actor);
    expect(createdSource()).toBe(9);
  });

  test('no config row keeps today\'s behavior (Agent, 103)', async () => {
    await ticketService.createTicket(1, { subject: 'Plain ticket', requesterEmail: 'rita@example.com' }, actor);
    expect(createdSource()).toBe(103);
  });

  test('automated intakes keep their true channel — email ingest is never relabeled', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue({ defaultSource: 3 });
    await ticketService.createTicket(1, { subject: 'Mail-born ticket', requesterEmail: 'rita@example.com' }, actor, { sourceChannel: 1 });
    expect(createdSource()).toBe(1);
  });
});

describe('createTicket — required enforcement (enforceRequired callers only)', () => {
  const REQUIRED_CF = [{
    id: 9, workspaceId: 1, key: 'cost_centre', label: 'Cost centre', type: 'text',
    options: [], isActive: true, isRequiredOnCreate: true, sortOrder: 0, defaultValue: null,
  }];

  test('a required custom field blocks the create with its label in the message', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(REQUIRED_CF);
    await expect(ticketService.createTicket(1, {
      subject: 'Missing the money field',
      requesterEmail: 'rita@example.com',
    }, actor, { enforceRequired: true })).rejects.toThrow(/Cost centre/);
    expect(prismaMock.ticket.create).not.toHaveBeenCalled();
  });

  test('supplying the required custom field passes', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(REQUIRED_CF);
    await ticketService.createTicket(1, {
      subject: 'Money field present',
      requesterEmail: 'rita@example.com',
      customFields: { cost_centre: 'CC-42' },
    }, actor, { enforceRequired: true });
    expect(prismaMock.ticket.create).toHaveBeenCalled();
  });

  test('automated callers (no flag) are exempt from required custom fields', async () => {
    prismaMock.customFieldDefinition.findMany.mockResolvedValue(REQUIRED_CF);
    await ticketService.createTicket(1, {
      subject: 'Scheduled spawn',
      requesterEmail: 'rita@example.com',
    }, actor);
    expect(prismaMock.ticket.create).toHaveBeenCalled();
  });

  test('a required built-in (description) blocks the composer/API create', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue({
      fields: [{ key: 'description', visible: true, required: true, sortOrder: 2 }],
    });
    await expect(ticketService.createTicket(1, {
      subject: 'No description supplied',
      requesterEmail: 'rita@example.com',
    }, actor, { enforceRequired: true })).rejects.toThrow(/Description/);
  });

  test('required category is skipped while the AI will classify (runAiTriage default true)', async () => {
    prismaMock.ticketFormConfig.findUnique.mockResolvedValue({
      fields: [{ key: 'category', visible: true, required: true, sortOrder: 5 }],
    });
    await ticketService.createTicket(1, {
      subject: 'AI will pick the category',
      requesterEmail: 'rita@example.com',
    }, actor, { enforceRequired: true });
    expect(prismaMock.ticket.create).toHaveBeenCalled();

    prismaMock.ticket.create.mockClear();
    await expect(ticketService.createTicket(1, {
      subject: 'Manual create needs a category',
      requesterEmail: 'rita@example.com',
      runAiTriage: false,
      aiClassifyOnly: false,
    }, actor, { enforceRequired: true })).rejects.toThrow(/Category/);
  });
});
