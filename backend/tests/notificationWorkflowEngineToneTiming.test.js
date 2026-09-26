import { jest } from '@jest/globals';

/**
 * Review B2: the tone facts (fresh sentiment, Straight-Talk List) are filled
 * AFTER timing + variant selection and only for the workflows that will run;
 * the fresh-sentiment await is capped at 2 s and skipped when no selected
 * workflow reads it before a delay.
 */

const prismaMock = {
  notificationWorkflowRun: { findFirst: jest.fn().mockResolvedValue(null) },
  ticket: { findUnique: jest.fn() },
};
const listEnabledMock = jest.fn();
const refreshWithCapMock = jest.fn();
const isListedMock = jest.fn();
const timingMock = jest.fn();
const calls = [];

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: { listEnabledForEvent: listEnabledMock, recordSuppressionDecisions: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/notificationWorkflowPolicyService.js', () => ({
  enrichEventContextWithNotificationPolicy: async (c) => c,
  selectWorkflowsForNotificationTiming: timingMock,
  normalizeNotificationWorkflowPolicy: (p) => p || {},
  getNotificationWorkflowPolicy: jest.fn(),
  updateNotificationWorkflowPolicy: jest.fn(),
  getNotificationWorkflowSchedulePreview: jest.fn(),
  isOffHoursPolicyActive: () => false,
  isOffHoursWorkflow: () => false,
  default: {},
}));
jest.unstable_mockModule('../src/services/requesterProfileService.js', () => ({
  REQUESTER_PROFILE_SELECT: {},
  enrichEventContextWithRequesterProfile: async (c) => c,
  fetchEntraProfile: jest.fn(),
  refreshRequesterEntraProfile: jest.fn(),
  requesterContextFromSource: jest.fn(),
  default: {},
}));
jest.unstable_mockModule('../src/services/toneService.js', () => ({
  default: { resolveToneForTicket: jest.fn(), isOnStraightTalkList: isListedMock },
}));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({
  default: { refreshWithCap: refreshWithCapMock },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const engine = await import('../src/services/notificationWorkflowEngine.js');
const {
  executeForEvent, enrichEventContextWithTone, workspaceHasSentimentReader, resetSentimentReaderCache,
  workflowToneNeeds, WORKFLOW_SENTIMENT_AWAIT_CAP_MS,
} = engine;

// enabledAt in the future: executeWorkflow skips before touching the graph,
// so these tests observe only the event-level enrichment.
const FUTURE = '2099-01-01T00:00:00.000Z';
const llmDefinition = {
  nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'llm', type: 'llm_generate', data: {} }],
  edges: [{ id: 'e1', source: 'trigger', target: 'llm' }],
};
const templateDefinition = {
  nodes: [{ id: 'trigger', type: 'trigger' }, { id: 't', type: 'template_render', data: {} }],
  edges: [{ id: 'e1', source: 'trigger', target: 't' }],
};
const delayedLlmDefinition = {
  nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'd', type: 'delay', data: { minutes: 30 } }, { id: 'llm', type: 'llm_generate', data: {} }],
  edges: [{ id: 'e1', source: 'trigger', target: 'd' }, { id: 'e2', source: 'd', target: 'llm' }],
};
const sentimentConditionDefinition = {
  nodes: [
    { id: 'trigger', type: 'trigger' },
    { id: 'c', type: 'condition', data: { conditions: { all: [{ field: 'ticket.sentiment', op: 'eq', value: 'frustrated' }] } } },
  ],
  edges: [{ id: 'e1', source: 'trigger', target: 'c' }],
};
const wf = (id, publishedDefinition, extra = {}) => ({
  id, workspaceId: 1, triggerType: 'ticket.created', isDefaultVariant: true, enabledAt: FUTURE, publishedDefinition, ...extra,
});
const eventContext = {
  event: { type: 'ticket.created', occurredAt: '2026-09-25T19:00:00.000Z' },
  workspace: { id: 1 },
  ticket: { id: 501, sentiment: 'neutral' },
  requester: { email: 'pat@example.com' },
};

beforeEach(() => {
  jest.clearAllMocks();
  calls.length = 0;
  resetSentimentReaderCache();
  prismaMock.notificationWorkflowRun.findFirst.mockResolvedValue(null);
  isListedMock.mockResolvedValue(false);
  refreshWithCapMock.mockImplementation(async () => { calls.push('sentiment'); return 'frustrated'; });
  timingMock.mockImplementation((workflows) => {
    calls.push('timing');
    return { selected: workflows, suppressed: [], mode: 'standard', reason: null };
  });
});

describe('executeForEvent', () => {
  test('no sentiment-reading workflow never calls the classifier', async () => {
    listEnabledMock.mockResolvedValue([wf(1, templateDefinition)]);
    await executeForEvent(eventContext);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
    expect(isListedMock).not.toHaveBeenCalled();
  });

  test('an AI workflow awaits a fresh sentiment with the 2 s cap, after timing selection', async () => {
    listEnabledMock.mockResolvedValue([wf(1, llmDefinition)]);
    await executeForEvent(eventContext);
    expect(WORKFLOW_SENTIMENT_AWAIT_CAP_MS).toBe(2000);
    expect(refreshWithCapMock).toHaveBeenCalledWith(501, 1, { capMs: 2000, fallback: 'neutral' });
    expect(calls).toEqual(['timing', 'sentiment']);
  });

  test('a quiet-hours-suppressed AI workflow does not make the event wait', async () => {
    listEnabledMock.mockResolvedValue([wf(1, llmDefinition), wf(2, templateDefinition, { isDefaultVariant: false, routingMode: 'additive' })]);
    timingMock.mockImplementation((workflows) => {
      calls.push('timing');
      return { selected: workflows.filter((w) => w.id !== 1), suppressed: workflows.filter((w) => w.id === 1), mode: 'after_hours', reason: 'x' };
    });
    await executeForEvent(eventContext);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
  });

  test('an AI node behind a delay does not await at event time', async () => {
    listEnabledMock.mockResolvedValue([wf(1, delayedLlmDefinition)]);
    await executeForEvent(eventContext);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
    // the Straight-Talk lookup (cheap) still runs for an AI workflow
    expect(isListedMock).toHaveBeenCalledWith(1, 'pat@example.com');
  });
});

describe('workflowToneNeeds / enrichment', () => {
  test('a sentiment condition awaits; a Straight-Talk-only condition only reads the list', async () => {
    expect(workflowToneNeeds(wf(1, sentimentConditionDefinition))).toEqual(expect.objectContaining({ sentimentNow: true, straightTalk: false }));
    const listOnly = {
      nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'c', type: 'condition', data: { field: 'requester.onStraightTalkList' } }],
      edges: [{ id: 'e', source: 'trigger', target: 'c' }],
    };
    isListedMock.mockResolvedValue(true);
    const next = await enrichEventContextWithTone(eventContext, [wf(1, listOnly)]);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
    expect(next.requester.onStraightTalkList).toBe(true);
  });
});

describe('workspaceHasSentimentReader (N2)', () => {
  test('true only when an enabled workflow reads sentiment; cached; errors = false', async () => {
    listEnabledMock.mockResolvedValueOnce([wf(1, templateDefinition)]);
    expect(await workspaceHasSentimentReader(1)).toBe(false);
    expect(await workspaceHasSentimentReader(1)).toBe(false);
    expect(listEnabledMock).toHaveBeenCalledTimes(1);

    listEnabledMock.mockResolvedValueOnce([wf(1, llmDefinition)]);
    expect(await workspaceHasSentimentReader(2)).toBe(true);

    listEnabledMock.mockRejectedValueOnce(new Error('db'));
    expect(await workspaceHasSentimentReader(3)).toBe(false);
  });
});
