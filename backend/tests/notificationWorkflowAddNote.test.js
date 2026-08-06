import { jest } from '@jest/globals';

/**
 * Custom Fields Activation Phase 1 — the `add_note` workflow action.
 *
 * Covers: node registration + graph-validation shapes, text-mode Liquid +
 * server-side sanitization, the FROZEN field_card rawPayload contract, the
 * system-note write path (no mirror job, no ticket.note_added emission — the
 * re-entrancy guarantee), placement note/pinned/both, pinned upsert re-run
 * semantics, the per-run execution cap, the setCustomFields Liquid rider, and
 * the installable templates.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn(), findMany: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflow: { findUnique: jest.fn(), findFirst: jest.fn() },
  notificationWorkflowVersion: { findUnique: jest.fn() },
  notificationLlmToolPolicy: { findUnique: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
  publicTicketStatusSettings: { upsert: jest.fn() },
  publicTicketStatusLink: { findUnique: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn(), findUnique: jest.fn(), update: jest.fn() },
  customFieldDefinition: { findMany: jest.fn() },
  competencyCategory: { findMany: jest.fn(), findFirst: jest.fn() },
  ticketActivity: { create: jest.fn() },
  mirrorJob: { findFirst: jest.fn(), create: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn(), create: jest.fn() },
  ticketPinnedCard: { upsert: jest.fn() },
  notificationDelivery: { upsert: jest.fn(), findUnique: jest.fn(), update: jest.fn(), create: jest.fn() },
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({
  processDelivery: jest.fn().mockResolvedValue({ success: true, status: 'sent' }),
}));
jest.unstable_mockModule('../src/services/ticketActivityRepository.js', () => ({
  default: { create: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/mirrorService.js', () => ({
  default: { enqueueFieldSync: jest.fn().mockResolvedValue({}), enqueueThreadEntry: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/routes/sse.routes.js', () => ({
  default: {},
  sseManager: { broadcast: jest.fn() },
}));
// Re-entrancy proof: the ONLY path that turns a note write into workflow
// triggers is ticketLifecycleNotificationService.emitTicketEvent (fired from
// ticketService._addThreadEntry). add_note must never touch it.
const emitTicketEventMock = jest.fn();
jest.unstable_mockModule('../src/services/ticketLifecycleNotificationService.js', () => ({
  default: {
    emitTicketEvent: emitTicketEventMock,
    emitTicketLifecycleNotifications: jest.fn(),
  },
}));
// setCustomFields rider: assert the values customFieldService receives are
// ALREADY Liquid-rendered. prettifyKeyLabel is re-exported for the executor.
const setValuesMock = jest.fn();
jest.unstable_mockModule('../src/services/customFieldService.js', () => ({
  default: { setValues: setValuesMock },
  prettifyKeyLabel: (key) => String(key).split('_').filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' '),
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const {
  NOTIFICATION_NODE_REGISTRY,
  WORKFLOW_TEMPLATES,
  validateWorkflowDefinition,
} = await import('../src/services/notificationWorkflowDefinition.js');
const { executeDefinition } = await import('../src/services/notificationWorkflowEngine.js');
const { sanitizeWorkflowNoteHtml } = await import('../src/services/notificationWorkflowActionNodes.js');

const eventContext = (over = {}) => ({
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-08-06T10:00:00.000Z', dedupeStamp: `t-${Math.random()}` },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: {
    id: 100,
    workspaceId: 1,
    freshserviceTicketId: null,
    subject: 'VPN access problem',
    status: 'Open',
    isNoise: false,
    customFields: { source_system: 'PowerApp', budget: 1500 },
  },
  requester: { name: 'Rita', email: 'rita@example.com' },
  assignedAgent: null,
  previousAgent: null,
  ...over,
});

function noteDefinition(noteData, extraNoteNodes = []) {
  const noteNodes = [{ id: 'note', type: 'add_note', data: noteData }, ...extraNoteNodes];
  const chain = ['trigger', ...noteNodes.map((n) => n.id), 'end'];
  return {
    version: 2,
    metadata: {},
    nodes: [
      { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
      ...noteNodes,
      { id: 'end', type: 'stop', data: {} },
    ],
    edges: chain.slice(0, -1).map((source, i) => ({ id: `e${i}`, source, target: chain[i + 1] })),
  };
}

const WORKFLOW = { id: 77, name: 'Intake router', workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [] };

beforeEach(() => {
  jest.clearAllMocks();
  let stepId = 100;
  let entryId = 500;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: stepId += 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.notificationLlmToolPolicy.findUnique.mockResolvedValue(null);
  prismaMock.publicTicketStatusSettings.upsert.mockResolvedValue({ enabled: false });
  prismaMock.publicTicketStatusLink.findUnique.mockResolvedValue(null);
  prismaMock.ticket.findUnique.mockResolvedValue({
    id: 100,
    workspaceId: 1,
    origin: 'ticketpulse',
    status: 'Open',
    priority: 3,
    createdAt: new Date('2026-08-01T10:00:00.000Z'),
    customFields: { source_system: 'PowerApp', budget: 1500 },
  });
  prismaMock.ticket.findMany.mockResolvedValue([]);
  prismaMock.ticket.update.mockResolvedValue({});
  prismaMock.ticketThreadEntry.findMany.mockResolvedValue([]);
  prismaMock.ticketThreadEntry.create.mockImplementation(({ data }) => Promise.resolve({ id: entryId += 1, ...data }));
  prismaMock.ticketPinnedCard.upsert.mockImplementation(({ create }) => Promise.resolve({ id: 41, ...create }));
  prismaMock.customFieldDefinition.findMany.mockResolvedValue([
    { id: 1, workspaceId: 1, key: 'source_system', label: 'Source System', type: 'text', options: [], isActive: true },
    { id: 2, workspaceId: 1, key: 'budget', label: 'Budget', type: 'number', options: [], isActive: true },
    { id: 3, workspaceId: 1, key: 'po_number', label: 'PO Number', type: 'text', options: [], isActive: true },
  ]);
  prismaMock.competencyCategory.findMany.mockResolvedValue([]);
  prismaMock.competencyCategory.findFirst.mockResolvedValue(null);
  setValuesMock.mockResolvedValue({ customFields: {}, changes: {} });
});

// ---------------------------------------------------------------- validation

describe('add_note node registration + graph validation', () => {
  test('add_note is a registered non-terminal node type', () => {
    expect(NOTIFICATION_NODE_REGISTRY.add_note).toEqual(expect.objectContaining({
      terminal: false,
      inputHandles: ['default'],
      outputHandles: ['default'],
    }));
  });

  test('add_note qualifies as the required action node on its own', () => {
    const definition = noteDefinition({ mode: 'text', bodyTemplate: '<p>Hi</p>' });
    const result = validateWorkflowDefinition(definition, { triggerType: 'ticket.created' });
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
  });

  test('mode is required', () => {
    expect(validateWorkflowDefinition(noteDefinition({}), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/mode to "text" or "field_card"/i);
  });

  test('text mode needs a bodyTemplate', () => {
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'text' }), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/needs a body template/i);
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'text', bodyTemplate: '   ' }), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/needs a body template/i);
  });

  test('field_card mode needs 1-12 field keys', () => {
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'field_card' }), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/at least one custom-field key/i);
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'field_card', fields: [] }), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/at least one custom-field key/i);
    const tooMany = Array.from({ length: 13 }, (_, i) => `field_${i}`);
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'field_card', fields: tooMany }), { triggerType: 'ticket.created' })
      .errors.join(' ')).toMatch(/max 12/i);
    expect(validateWorkflowDefinition(noteDefinition({ mode: 'field_card', fields: ['budget'] }), { triggerType: 'ticket.created' })
      .errors).toEqual([]);
  });

  test('accent and placement vocabularies are enforced', () => {
    expect(validateWorkflowDefinition(
      noteDefinition({ mode: 'field_card', fields: ['budget'], accent: 'crimson' }),
      { triggerType: 'ticket.created' },
    ).errors.join(' ')).toMatch(/unsupported accent/i);
    expect(validateWorkflowDefinition(
      noteDefinition({ mode: 'field_card', fields: ['budget'], placement: 'sidebar' }),
      { triggerType: 'ticket.created' },
    ).errors.join(' ')).toMatch(/placement must be note, pinned, or both/i);
    expect(validateWorkflowDefinition(
      noteDefinition({ mode: 'field_card', fields: ['budget'], accent: 'violet', placement: 'both' }),
      { triggerType: 'ticket.created' },
    ).errors).toEqual([]);
  });
});

// ----------------------------------------------------------------- text mode

describe('add_note text mode (Liquid + sanitization + system-note write)', () => {
  const HTML_TEMPLATE = [
    '<p>Hello {{ requester.name }} about {{ ticket.subject }}</p>',
    '<script>alert("xss")</script>',
    '<a href="https://sharepoint.example/doc" onclick="steal()">the doc</a>',
    '<table><tr><th>Field</th><td>Value</td></tr></table>',
    '<button>never</button><form><input value="x"/></form>',
  ].join('');

  test('renders Liquid, strips script/onclick/button/input/form, keeps table + link', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'text', bodyTemplate: HTML_TEMPLATE }),
      eventContext: eventContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.bodyHtml).toContain('Hello Rita about VPN access problem');
    expect(data.bodyHtml).toContain('<a href="https://sharepoint.example/doc"');
    expect(data.bodyHtml).toContain('<table><tr><th>Field</th><td>Value</td></tr></table>');
    expect(data.bodyHtml).not.toContain('<script');
    expect(data.bodyHtml).not.toContain('alert(');
    expect(data.bodyHtml).not.toContain('onclick');
    expect(data.bodyHtml).not.toContain('<button');
    expect(data.bodyHtml).not.toContain('<input');
    expect(data.bodyHtml).not.toContain('<form');
    expect(data.bodyText).toContain('Hello Rita');
  });

  test('writes via the protected system-note pattern (never mirrored, never re-triggering)', async () => {
    await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'text', bodyTemplate: '<p>Audit line</p>' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });

    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data).toEqual(expect.objectContaining({
      authorType: 'system',
      isPrivate: true,
      eventType: 'note',
      mirrorState: null,
      source: 'ticketpulse_user',
      incoming: false,
    }));
    // No FS mirror job for the note…
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
    // …and no ticket.note_added emission: a note_added-triggered workflow
    // CANNOT fire from an add_note write (re-entrancy safe by construction).
    expect(emitTicketEventMock).not.toHaveBeenCalled();
  });

  test('a body that sanitizes to nothing is a named skip, not an empty note', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'text', bodyTemplate: '<script>only()</script>' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    const step = result.steps.find((s) => s.nodeId === 'note');
    expect(step.output.skipped).toBe(true);
    expect(step.output.reason).toMatch(/empty after sanitization/i);
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
  });

  test('sanitizeWorkflowNoteHtml allowlist directly (unit)', () => {
    const clean = sanitizeWorkflowNoteHtml(
      '<div class="c" style="color:red" onmouseover="x()"><span>ok</span><pre><code>1</code></pre><hr/><br/></div><iframe src="x"></iframe>',
    );
    expect(clean).toContain('<div class="c" style="color:red">');
    expect(clean).toContain('<pre><code>1</code></pre>');
    expect(clean).not.toContain('onmouseover');
    expect(clean).not.toContain('iframe');
  });
});

// ----------------------------------------------------------- field_card mode

describe('add_note field_card mode (frozen client contract)', () => {
  const CARD_DATA = {
    mode: 'field_card',
    title: 'API intake',
    intro: 'From {{ ticket.customFields.source_system }}',
    accent: 'violet',
    fields: ['source_system', 'budget', 'po_number'],
    placement: 'both',
  };

  // The frontend FieldCardNote / PinnedIntakeCard are built against this EXACT
  // payload shape — if this snapshot changes, the contract broke.
  const EXPECTED_PAYLOAD = {
    kind: 'field_card',
    v: 1,
    title: 'API intake',
    intro: 'From PowerApp',
    accent: 'violet',
    fields: [
      { key: 'source_system', label: 'Source System', type: 'text', value: 'PowerApp' },
      { key: 'budget', label: 'Budget', type: 'number', value: 1500 },
    ],
    workflowId: 77,
    runId: 900,
    workflowName: 'Intake router',
  };

  test('thread entry rawPayload matches the contract exactly (empty keys skipped)', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition(CARD_DATA),
      eventContext: eventContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload).toEqual(EXPECTED_PAYLOAD); // exact shape — no extra keys
    expect(data.authorType).toBe('system');
    expect(data.isPrivate).toBe(true);
    expect(data.eventType).toBe('note');
    expect(data.mirrorState).toBeNull();
    // Plain-text fallback: title/intro then "Label: value" lines.
    expect(data.bodyText).toBe('API intake\nFrom PowerApp\nSource System: PowerApp\nBudget: 1500');
    // HTML fallback is a sanitizer-safe table.
    expect(data.bodyHtml).toContain('<table>');
    expect(data.bodyHtml).toContain('<th>Source System</th><td>PowerApp</td>');
    expect(sanitizeWorkflowNoteHtml(data.bodyHtml)).toBe(data.bodyHtml); // survives its own sanitizer verbatim

    const step = result.steps.find((s) => s.nodeId === 'note');
    expect(step.output.skippedEmpty).toEqual(['po_number']); // no value on the ticket
    expect(emitTicketEventMock).not.toHaveBeenCalled();
    expect(prismaMock.mirrorJob.create).not.toHaveBeenCalled();
  });

  test('includeEmpty keeps valueless keys with value: null', async () => {
    await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ ...CARD_DATA, includeEmpty: true, placement: 'note' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload.fields).toEqual([
      { key: 'source_system', label: 'Source System', type: 'text', value: 'PowerApp' },
      { key: 'budget', label: 'Budget', type: 'number', value: 1500 },
      { key: 'po_number', label: 'PO Number', type: 'text', value: null },
    ]);
  });

  test('a card whose every field is empty skips instead of writing a hollow note', async () => {
    prismaMock.ticket.findUnique.mockResolvedValue({ id: 100, workspaceId: 1, customFields: {} });
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'field_card', fields: ['budget'], placement: 'note' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    const step = result.steps.find((s) => s.nodeId === 'note');
    expect(step.output.skipped).toBe(true);
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(prismaMock.ticketPinnedCard.upsert).not.toHaveBeenCalled();
  });

  test('title/intro are truncated to 300 rendered chars', async () => {
    await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ ...CARD_DATA, title: 'T'.repeat(400), placement: 'note' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    const { data } = prismaMock.ticketThreadEntry.create.mock.calls[0][0];
    expect(data.rawPayload.title).toHaveLength(300);
  });
});

// ------------------------------------------------------------------ placement

describe('add_note placement variants', () => {
  const cardData = (placement) => ({ mode: 'field_card', fields: ['budget'], placement });

  test('placement: note → thread entry only', async () => {
    await executeDefinition({
      workflow: WORKFLOW, definition: noteDefinition(cardData('note')), eventContext: eventContext(), executionMode: 'live',
    });
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketPinnedCard.upsert).not.toHaveBeenCalled();
  });

  test('placement: pinned → pinned card only', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW, definition: noteDefinition(cardData('pinned')), eventContext: eventContext(), executionMode: 'live',
    });
    expect(prismaMock.ticketThreadEntry.create).not.toHaveBeenCalled();
    expect(prismaMock.ticketPinnedCard.upsert).toHaveBeenCalledTimes(1);
    const step = result.steps.find((s) => s.nodeId === 'note');
    expect(step.output.pinnedCardId).toBe(41);
    expect(step.output.noteEntryId).toBeUndefined();
  });

  test('placement: both → thread entry AND pinned card with the same payload', async () => {
    await executeDefinition({
      workflow: WORKFLOW, definition: noteDefinition(cardData('both')), eventContext: eventContext(), executionMode: 'live',
    });
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
    expect(prismaMock.ticketPinnedCard.upsert).toHaveBeenCalledTimes(1);
    const entryPayload = prismaMock.ticketThreadEntry.create.mock.calls[0][0].data.rawPayload;
    const upsertArgs = prismaMock.ticketPinnedCard.upsert.mock.calls[0][0];
    expect(upsertArgs.create.payload).toEqual(entryPayload);
  });

  test('pinned upsert keys on (ticket, kind, workflow); re-runs refresh payload and clear dismissal', async () => {
    await executeDefinition({
      workflow: WORKFLOW, definition: noteDefinition(cardData('pinned')), eventContext: eventContext(), executionMode: 'live',
    });
    const args = prismaMock.ticketPinnedCard.upsert.mock.calls[0][0];
    expect(args.where).toEqual({
      ticketId_kind_workflowId: { ticketId: 100, kind: 'field_card', workflowId: 77 },
    });
    expect(args.create).toEqual(expect.objectContaining({
      ticketId: 100, kind: 'field_card', workflowId: 77,
    }));
    // The re-run half of the upsert: fresh payload, dismissal cleared.
    expect(args.update).toEqual({
      payload: args.create.payload,
      dismissedAt: null,
      dismissedBy: null,
    });
  });

  test('text-mode notes cannot pin (structured cards only)', async () => {
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'text', bodyTemplate: '<p>Hi</p>', placement: 'both' }),
      eventContext: eventContext(),
      executionMode: 'live',
    });
    expect(prismaMock.ticketPinnedCard.upsert).not.toHaveBeenCalled();
    const step = result.steps.find((s) => s.nodeId === 'note');
    expect(step.output.pinnedSkipped).toMatch(/field-card/i);
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(1);
  });
});

// -------------------------------------------------------------------- run cap

describe('add_note per-run execution cap', () => {
  test('the 4th add_note in one run is skipped with a run warning', async () => {
    const extra = [2, 3, 4].map((n) => ({
      id: `note${n}`, type: 'add_note', data: { mode: 'text', bodyTemplate: `<p>Note ${n}</p>` },
    }));
    const result = await executeDefinition({
      workflow: WORKFLOW,
      definition: noteDefinition({ mode: 'text', bodyTemplate: '<p>Note 1</p>' }, extra),
      eventContext: eventContext(),
      executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    // Three wrote; the fourth was capped.
    expect(prismaMock.ticketThreadEntry.create).toHaveBeenCalledTimes(3);
    const fourth = result.steps.find((s) => s.nodeId === 'note4');
    expect(fourth.output.skipped).toBe(true);
    expect(fourth.output.reason).toMatch(/cap/i);
    expect(result.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'add_note_cap', nodeId: 'note4' }),
    ]));
  });
});

// ------------------------------------------------- setCustomFields Liquid rider

describe('update_ticket.setCustomFields Liquid rider', () => {
  test('string values render through the run scope; non-strings pass through', async () => {
    const definition = {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        {
          id: 'stamp',
          type: 'update_ticket',
          data: {
            setCustomFields: {
              intake_summary: '{{ ticket.subject }} ({{ requester.name }})',
              budget: 1500,
              flagged: true,
            },
          },
        },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'stamp' },
        { id: 'e2', source: 'stamp', target: 'end' },
      ],
    };

    const result = await executeDefinition({
      workflow: WORKFLOW, definition, eventContext: eventContext(), executionMode: 'live',
    });

    expect(result.status).toBe('completed');
    expect(setValuesMock).toHaveBeenCalledWith(
      100, 1,
      {
        intake_summary: 'VPN access problem (Rita)',
        budget: 1500,
        flagged: true,
      },
      { name: 'Notification workflow' },
    );
  });

  test('previews show the post-Liquid values without writing', async () => {
    const definition = {
      version: 2,
      metadata: {},
      nodes: [
        { id: 'trigger', type: 'trigger', data: { triggerType: 'ticket.created' } },
        { id: 'stamp', type: 'update_ticket', data: { setCustomFields: { intake_summary: '{{ ticket.subject }}' } } },
        { id: 'end', type: 'stop', data: {} },
      ],
      edges: [
        { id: 'e1', source: 'trigger', target: 'stamp' },
        { id: 'e2', source: 'stamp', target: 'end' },
      ],
    };
    const result = await executeDefinition({
      workflow: WORKFLOW, definition, eventContext: eventContext(), executionMode: 'preview',
    });
    const step = result.steps.find((s) => s.nodeId === 'stamp');
    expect(step.output.wouldSet.customFields).toEqual({ intake_summary: 'VPN access problem' });
    expect(setValuesMock).not.toHaveBeenCalled();
  });
});

// ------------------------------------------------------------------ templates

describe('installable templates (Phase 1 updates)', () => {
  test('api_intake_router now carries an add_note field-card step', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'api_intake_router');
    const definition = template.build();
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);
    const note = definition.nodes.find((n) => n.type === 'add_note');
    expect(note).toBeDefined();
    expect(note.data.mode).toBe('field_card');
    expect(note.data.fields.length).toBeGreaterThanOrEqual(1);
  });

  test('the new intake_field_card template validates: created + is-set condition → pinned card', () => {
    const template = WORKFLOW_TEMPLATES.find((t) => t.key === 'intake_field_card');
    expect(template).toBeDefined();
    expect(template.triggerType).toBe('ticket.created');
    const definition = template.build();
    expect(validateWorkflowDefinition(definition, { triggerType: 'ticket.created' }).errors).toEqual([]);
    const condition = definition.nodes.find((n) => n.type === 'condition');
    expect(condition.data.conditionGroup.conditions[0]).toEqual({
      field: 'custom:source_system', operator: 'is_not_empty',
    });
    const note = definition.nodes.find((n) => n.type === 'add_note');
    expect(note.data.mode).toBe('field_card');
    expect(note.data.placement).toBe('both');
  });

  test('every template still builds a definition that validates for its trigger type', () => {
    for (const template of WORKFLOW_TEMPLATES) {
      const result = validateWorkflowDefinition(template.build(), { triggerType: template.triggerType });
      expect({ key: template.key, errors: result.errors }).toEqual({ key: template.key, errors: [] });
    }
  });
});
