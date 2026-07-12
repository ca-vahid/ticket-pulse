import { jest } from '@jest/globals';

// The type normalizer now reads the per-workspace ticket-type registry.
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: {
    ticketTypeDefinition: {
      findMany: jest.fn().mockResolvedValue([
        { id: 1, workspaceId: 1, name: 'Incident', aliases: ['incident', 'issue', 'outage'], isActive: true, aiAssignable: true, fsTypeValue: 'Incident', sortOrder: 0 },
        { id: 2, workspaceId: 1, name: 'Service Request', aliases: ['service request', 'service_request', 'request', 'sr'], isActive: true, aiAssignable: true, fsTypeValue: 'Service Request', sortOrder: 1 },
      ]),
    },
  },
}));

const {
  normalizeSubmitRecommendationPayload,
  parseLeadingJsonArray,
} = await import('../src/services/assignmentRecommendationValidation.js');
const { buildAnthropicMessageFromOpenAiResponse } = await import('../src/services/aiProviders/openAiConverters.js');

const basePayload = {
  recommendations: [
    {
      rank: 1,
      techId: 648411,
      techName: 'Adrian Lo',
      score: 0.72,
      reasoning: 'Best available qualified technician.',
    },
  ],
  overallReasoning: 'Internal routing rationale.',
  assessedPriority: 'Medium',
  priorityRationale: 'Single-user request without outage language.',
  priorityConfidence: 'medium',
  ticketClassification: 'Account & Access > Entra / Azure AD App Registrations',
  classificationRationale: 'Enterprise app consent request.',
  categoryFit: 'exact',
  subcategoryFit: 'exact',
  taxonomyReviewNeeded: false,
  confidence: 'medium',
};

describe('assignment recommendation validation', () => {
  test('accepts and normalizes a valid submit_recommendation payload', async () => {
    const normalized = await normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: [{ ...basePayload.recommendations[0], techId: '648411', score: '0.72' }],
      taxonomyReviewNeeded: 'false',
      ticketType: 'service_request',
      ticketTypeRationale: 'The requester needs access provisioned.',
      ticketTypeConfidence: 'high',
    });

    expect(normalized.recommendations[0]).toMatchObject({
      rank: 1,
      techId: 648411,
      score: 0.72,
    });
    expect(normalized.taxonomyReviewNeeded).toBe(false);
    expect(normalized.ticketType).toBe('Service Request');
    expect(normalized.ticketTypeConfidence).toBe('high');
  });

  test('recovers Anthropic parameter text accidentally embedded after a recommendations JSON string', async () => {
    const rawRecommendations = `${JSON.stringify(basePayload.recommendations)}\n<parameter name="overallReasoning">Recovered internal rationale`;
    const normalized = await normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: rawRecommendations,
      overallReasoning: undefined,
    });

    expect(normalized.__normalizedFromString).toBe(true);
    expect(normalized.recommendations).toEqual(basePayload.recommendations);
    expect(normalized.overallReasoning).toBe('Recovered internal rationale');
  });

  test('rejects malformed recommendation shapes before a run can auto-assign', async () => {
    await expect(normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: '{"rank":1,"techId":648411}',
    })).rejects.toThrow(/recommendations must be an array/);

    await expect(normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: [{ ...basePayload.recommendations[0], techId: null }],
    })).rejects.toThrow(/techId/);
  });

  test('parses only the leading JSON array and leaves following parameter text as tail', () => {
    const parsed = parseLeadingJsonArray('[{"rank":1}]<parameter name="overallReasoning">text');
    expect(parsed.array).toEqual([{ rank: 1 }]);
    expect(parsed.tail).toBe('<parameter name="overallReasoning">text');
  });

  test('normalizes malformed recommendations from the OpenAI function-call adapter path', async () => {
    const rawRecommendations = `${JSON.stringify(basePayload.recommendations)}\n<parameter name="overallReasoning">OpenAI adapter recovered rationale`;
    const response = {
      id: 'resp_test',
      output: [{
        type: 'function_call',
        id: 'fc_test',
        call_id: 'call_test',
        name: 'submit_recommendation',
        arguments: JSON.stringify({
          ...basePayload,
          recommendations: rawRecommendations,
          overallReasoning: undefined,
        }),
      }],
    };

    const message = buildAnthropicMessageFromOpenAiResponse(response);
    const toolInput = message.content.find((block) => block.name === 'submit_recommendation').input;
    const normalized = await normalizeSubmitRecommendationPayload(toolInput);

    expect(message.stop_reason).toBe('tool_use');
    expect(normalized.recommendations).toEqual(basePayload.recommendations);
    expect(normalized.overallReasoning).toBe('OpenAI adapter recovered rationale');
  });
});
