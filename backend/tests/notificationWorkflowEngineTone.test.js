import { jest } from '@jest/globals';

/**
 * Tone of voice in the workflow engine (QA 09-25 #5): the node's Voice reaches
 * the model, Straight-Talk List / frustrated requesters append the workspace
 * text and force the professional guard, the run audit records why, and the
 * event context gets a fresh sentiment + requester.onStraightTalkList.
 */

const prismaMock = {
  notificationWorkflowRun: { create: jest.fn(), update: jest.fn() },
  notificationWorkflowStepRun: { create: jest.fn(), update: jest.fn() },
  notificationDelivery: { create: jest.fn(), findUnique: jest.fn() },
  aiProviderAttempt: { updateMany: jest.fn() },
  ticket: { findFirst: jest.fn(), findMany: jest.fn() },
  ticketThreadEntry: { findMany: jest.fn() },
  notificationEmailBlock: { findFirst: jest.fn(), findMany: jest.fn() },
  notificationEmailSignature: { findUnique: jest.fn() },
};
const providerSendJsonMock = jest.fn();
const resolveToneMock = jest.fn();
const isListedMock = jest.fn();
const refreshWithCapMock = jest.fn();
const pipelineMock = jest.fn();
let toolMode = false;

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/services/notificationDeliveryService.js', () => ({ processDelivery: jest.fn().mockResolvedValue({ success: true }) }));
jest.unstable_mockModule('../src/services/notificationWorkflowRepository.js', () => ({
  default: { listEnabledForEvent: jest.fn(), recordSuppressionDecisions: jest.fn().mockResolvedValue({}) },
}));
jest.unstable_mockModule('../src/services/aiProviders/providerGateway.js', () => ({
  default: { sendJson: providerSendJsonMock, runToolTurn: jest.fn() },
}));
jest.unstable_mockModule('../src/services/toneService.js', () => ({
  default: { resolveToneForTicket: resolveToneMock, isOnStraightTalkList: isListedMock },
}));
jest.unstable_mockModule('../src/services/ticketSentimentService.js', () => ({
  default: { refreshWithCap: refreshWithCapMock },
}));
jest.unstable_mockModule('../src/services/notificationContextEnrichmentService.js', () => ({
  buildNotificationLlmContext: jest.fn(async () => (toolMode ? { enabled: true, policy: { mode: 'tools_enabled' } } : { enabled: false })),
  enrichEventContextWithAgentNotes: jest.fn(async (c) => c),
  notificationLlmContextPrompt: jest.fn(() => ''),
  summarizeNotificationLlmContext: jest.fn(() => ({})),
}));
jest.unstable_mockModule('../src/services/notificationWorkflowLlmPipelineService.js', () => ({
  runNotificationWorkflowLlmPipeline: pipelineMock,
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { executeDefinition, enrichEventContextWithTone, VOICE_INSTRUCTIONS, PROFESSIONAL_REQUESTER_INSTRUCTION } = await import('../src/services/notificationWorkflowEngine.js');
const { buildDefaultWorkflowDefinition } = await import('../src/services/notificationWorkflowDefinition.js');

const workflow = { id: 7, workspaceId: 1, triggerType: 'ticket.created', publishedVersion: 1, versions: [{ id: 70, version: 1 }] };
const eventContext = {
  event: { type: 'ticket.created', source: 'test', occurredAt: '2026-09-25T19:00:00.000Z', dedupeStamp: 's1' },
  workspace: { id: 1, name: 'IT', timezone: 'America/Vancouver' },
  ticket: { id: 501, subject: 'VPN access problem', status: 'Open', sentiment: 'neutral', isNoise: false },
  requester: { name: 'Pat Doe', email: 'pat@example.com' },
  assignedAgent: null,
  previousAgent: null,
};

function definitionWithLlm(toneMode, extraData = {}) {
  const definition = buildDefaultWorkflowDefinition('ticket.created');
  definition.nodes.push({
    id: 'llm',
    type: 'llm_generate',
    position: { x: 700, y: 120 },
    data: { prompt: 'Write an ack for {{ ticket.subject }}', ...(toneMode ? { requesterGuardrails: { toneMode } } : {}), ...extraData },
  });
  const templateNode = definition.nodes.find((node) => node.type === 'template_render');
  templateNode.data.contentSource = 'llm_with_template_fallback';
  definition.edges = definition.edges.map((edge) => (
    edge.id === 'recipients-to-template' ? { ...edge, id: 'recipients-to-llm', target: 'llm' } : edge
  ));
  definition.edges.push({ id: 'llm-to-template', source: 'llm', target: 'template' });
  return definition;
}

async function runLlm(toneMode, context = eventContext, extraData = {}) {
  const result = await executeDefinition({
    workflow,
    definition: definitionWithLlm(toneMode, extraData),
    eventContext: context,
    dryRun: true,
    executeLlm: true,
    triggerSource: 'test',
  });
  return result.steps.find((s) => s.nodeType === 'llm_generate');
}

beforeEach(() => {
  jest.clearAllMocks();
  toolMode = false;
  prismaMock.notificationWorkflowRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 900, ...data }));
  prismaMock.notificationWorkflowRun.update.mockResolvedValue({});
  prismaMock.notificationWorkflowStepRun.create.mockImplementation(({ data }) => Promise.resolve({ id: 1, ...data }));
  prismaMock.notificationWorkflowStepRun.update.mockResolvedValue({});
  prismaMock.aiProviderAttempt.updateMany.mockResolvedValue({ count: 0 });
  prismaMock.notificationEmailBlock.findMany.mockResolvedValue([]);
  providerSendJsonMock.mockResolvedValue({
    provider: 'openai', model: 'gpt-test',
    parsed: { subject: 'We got it 🎉', html: '<p>Awesome sauce, we are on it 🎉</p>', text: 'Awesome sauce, we are on it 🎉' },
    usage: { outputTokens: 10 },
  });
  resolveToneMock.mockResolvedValue({ voice: 'friendly', override: null, onStraightTalkList: false });
});

describe('voice instruction', () => {
  test.each(['friendly', 'playful', 'professional'])('%s tone mode tells the model its voice', async (mode) => {
    const step = await runLlm(mode);
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt).toContain(VOICE_INSTRUCTIONS[mode]);
    expect(step.output.llm.promptPolicy).toEqual(expect.objectContaining({ voice: mode, toneOverride: null }));
  });

  test('no tone mode on the node = friendly', async () => {
    await runLlm(null);
    expect(providerSendJsonMock.mock.calls[0][0].systemPrompt).toContain(VOICE_INSTRUCTIONS.friendly);
  });
});

describe('custom system prompt (review S1)', () => {
  const CUSTOM = 'You are the Acme help desk. Be terse and sign off as Acme IT.';

  test('no override = the author prompt alone, no voice line', async () => {
    const step = await runLlm('friendly', eventContext, { systemPrompt: CUSTOM });
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt).toBe(CUSTOM);
    const { promptPolicy } = step.output.llm;
    expect(promptPolicy.basePromptDigest).toBe(promptPolicy.systemPromptDigest);
    expect(promptPolicy.customSystemPromptUsed).toBe(true);
  });

  test('a Straight-Talk override appends a requester note without "overrides" wording', async () => {
    resolveToneMock.mockResolvedValue({ voice: 'friendly', override: { reason: 'straight_talk_list', text: 'No jokes for Pat, please.' }, onStraightTalkList: true });
    const step = await runLlm('friendly', eventContext, { systemPrompt: CUSTOM });
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt.startsWith(CUSTOM)).toBe(true);
    expect(systemPrompt).toContain(PROFESSIONAL_REQUESTER_INSTRUCTION);
    expect(systemPrompt).toContain('For this requester: No jokes for Pat, please.');
    expect(systemPrompt).not.toContain('Voice for this e-mail');
    expect(systemPrompt).not.toMatch(/overrides/i);
    const { promptPolicy } = step.output.llm;
    expect(promptPolicy.basePromptDigest).not.toBe(promptPolicy.systemPromptDigest);
  });

  test('a professional workspace floor adds only the professional requester line', async () => {
    resolveToneMock.mockResolvedValue({ voice: 'professional', override: null, onStraightTalkList: false });
    await runLlm('friendly', eventContext, { systemPrompt: CUSTOM });
    expect(providerSendJsonMock.mock.calls[0][0].systemPrompt).toBe(`${CUSTOM}\n\n${PROFESSIONAL_REQUESTER_INSTRUCTION}`);
  });

  test('default-prompt nodes keep the voice line without "overrides" wording', async () => {
    await runLlm('friendly');
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt).toContain(VOICE_INSTRUCTIONS.friendly);
    expect(systemPrompt).not.toMatch(/overrides other style guidance/);
  });

  test('tool mode passes toneOverride only when an override applies', async () => {
    toolMode = true;
    pipelineMock.mockResolvedValue({ email: { subject: 's', html: '<p>h</p>', text: 't' }, llm: { provider: 'openai', model: 'x', usage: {} } });
    await runLlm('friendly', eventContext, { systemPrompt: CUSTOM });
    expect(pipelineMock.mock.calls[0][0].toneOverride).toBe(false);
    resolveToneMock.mockResolvedValue({ voice: 'friendly', override: { reason: 'frustrated', text: 'Be plain.' }, onStraightTalkList: false });
    await runLlm('friendly', eventContext, { systemPrompt: CUSTOM });
    expect(pipelineMock.mock.calls[1][0].toneOverride).toBe(true);
  });
});

describe('professional override', () => {
  test('a person on the Straight-Talk List gets the tone text and the professional guard', async () => {
    resolveToneMock.mockResolvedValue({ voice: 'friendly', override: { reason: 'straight_talk_list', text: 'No jokes for Pat, please.' }, onStraightTalkList: true });
    const step = await runLlm('playful');
    expect(resolveToneMock).toHaveBeenCalledWith({ workspaceId: 1, requesterEmail: 'pat@example.com', sentiment: 'neutral' });
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt).toContain('No jokes for Pat, please.');
    expect(systemPrompt).toContain(VOICE_INSTRUCTIONS.professional);
    expect(systemPrompt).not.toContain(VOICE_INSTRUCTIONS.playful);
    const { promptPolicy, guardPolicy } = step.output.llm;
    expect(promptPolicy.toneOverride).toEqual({ reason: 'straight_talk_list' });
    expect(promptPolicy.nodeToneMode).toBe('playful');
    expect(guardPolicy.toneMode).toBe('professional');
    expect(guardPolicy.allowEmoji).toBe(false);
    expect(step.output.llm.email.text).not.toContain('🎉');
  });

  test('a frustrated requester gets the override (reason recorded)', async () => {
    resolveToneMock.mockResolvedValue({ voice: 'friendly', override: { reason: 'frustrated', text: 'Be plain.' }, onStraightTalkList: false });
    const step = await runLlm('friendly', { ...eventContext, ticket: { ...eventContext.ticket, sentiment: 'frustrated' } });
    expect(resolveToneMock.mock.calls[0][0].sentiment).toBe('frustrated');
    expect(providerSendJsonMock.mock.calls[0][0].systemPrompt).toContain('Be plain.');
    expect(step.output.llm.promptPolicy.toneOverride).toEqual({ reason: 'frustrated' });
  });

  test('no override (toggle off / not listed) = no tone text', async () => {
    const step = await runLlm('friendly');
    expect(providerSendJsonMock.mock.calls[0][0].systemPrompt).not.toContain('For this requester');
    expect(step.output.llm.guardPolicy.toneMode).toBe('friendly');
  });

  test('a professional workspace default forces the professional voice without tone text', async () => {
    resolveToneMock.mockResolvedValue({ voice: 'professional', override: null, onStraightTalkList: false });
    const step = await runLlm('friendly');
    const { systemPrompt } = providerSendJsonMock.mock.calls[0][0];
    expect(systemPrompt).toContain(VOICE_INSTRUCTIONS.professional);
    expect(systemPrompt).not.toContain('For this requester');
    expect(step.output.llm.promptPolicy.toneOverride).toEqual({ reason: 'workspace_default' });
  });

  test('tool mode gets the same override text and the professional guard options', async () => {
    toolMode = true;
    resolveToneMock.mockResolvedValue({ voice: 'friendly', override: { reason: 'straight_talk_list', text: 'No jokes for Pat, please.' }, onStraightTalkList: true });
    pipelineMock.mockResolvedValue({ email: { subject: 's', html: '<p>h</p>', text: 't' }, llm: { provider: 'openai', model: 'x', usage: {} } });
    const step = await runLlm('friendly');
    const args = pipelineMock.mock.calls[0][0];
    expect(args.systemPrompt).toContain('No jokes for Pat, please.');
    expect(args.guardOptions.toneMode).toBe('professional');
    expect(args.guardOptions.allowPlayfulTone).toBe(false);
    expect(step.output.llm.promptPolicy.toneOverride).toEqual({ reason: 'straight_talk_list' });
  });
});

describe('event context enrichment', () => {
  const llmWorkflow = { id: 1, publishedDefinition: definitionWithLlm('friendly') };
  const templateWorkflow = { id: 2, publishedDefinition: { nodes: [{ id: 't', type: 'template_render' }], edges: [] } };

  test('created + AI workflow awaits a fresh sentiment and flags the list', async () => {
    refreshWithCapMock.mockResolvedValue('frustrated');
    isListedMock.mockResolvedValue(true);
    const next = await enrichEventContextWithTone(eventContext, [llmWorkflow]);
    expect(refreshWithCapMock).toHaveBeenCalledWith(501, 1, { capMs: 2000, fallback: 'neutral' });
    expect(next.ticket.sentiment).toBe('frustrated');
    expect(next.requester.onStraightTalkList).toBe(true);
  });

  test('template-only workflows do not pay for a classification', async () => {
    isListedMock.mockResolvedValue(false);
    const next = await enrichEventContextWithTone(eventContext, [templateWorkflow]);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
    expect(next.ticket.sentiment).toBe('neutral');
    expect(isListedMock).not.toHaveBeenCalled();
    expect(next).toBe(eventContext);
  });

  test('other events keep the stored sentiment; no workflows = untouched', async () => {
    isListedMock.mockResolvedValue(false);
    await enrichEventContextWithTone({ ...eventContext, event: { type: 'ticket.assigned' } }, [llmWorkflow]);
    expect(refreshWithCapMock).not.toHaveBeenCalled();
    expect(await enrichEventContextWithTone(eventContext, [])).toBe(eventContext);
  });
});
