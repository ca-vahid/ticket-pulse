import {
  normalizeSubmitRecommendationPayload,
  parseLeadingJsonArray,
} from '../src/services/assignmentRecommendationValidation.js';
import { buildAnthropicMessageFromOpenAiResponse } from '../src/services/aiProviders/openAiConverters.js';

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
  test('accepts and normalizes a valid submit_recommendation payload', () => {
    const normalized = normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: [{ ...basePayload.recommendations[0], techId: '648411', score: '0.72' }],
      taxonomyReviewNeeded: 'false',
    });

    expect(normalized.recommendations[0]).toMatchObject({
      rank: 1,
      techId: 648411,
      score: 0.72,
    });
    expect(normalized.taxonomyReviewNeeded).toBe(false);
  });

  test('recovers Anthropic parameter text accidentally embedded after a recommendations JSON string', () => {
    const rawRecommendations = `${JSON.stringify(basePayload.recommendations)}\n<parameter name="overallReasoning">Recovered internal rationale`;
    const normalized = normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: rawRecommendations,
      overallReasoning: undefined,
    });

    expect(normalized.__normalizedFromString).toBe(true);
    expect(normalized.recommendations).toEqual(basePayload.recommendations);
    expect(normalized.overallReasoning).toBe('Recovered internal rationale');
  });

  test('rejects malformed recommendation shapes before a run can auto-assign', () => {
    expect(() => normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: '{"rank":1,"techId":648411}',
    })).toThrow(/recommendations must be an array/);

    expect(() => normalizeSubmitRecommendationPayload({
      ...basePayload,
      recommendations: [{ ...basePayload.recommendations[0], techId: null }],
    })).toThrow(/techId/);
  });

  test('parses only the leading JSON array and leaves following parameter text as tail', () => {
    const parsed = parseLeadingJsonArray('[{"rank":1}]<parameter name="overallReasoning">text');
    expect(parsed.array).toEqual([{ rank: 1 }]);
    expect(parsed.tail).toBe('<parameter name="overallReasoning">text');
  });

  test('normalizes malformed recommendations from the OpenAI function-call adapter path', () => {
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
    const normalized = normalizeSubmitRecommendationPayload(toolInput);

    expect(message.stop_reason).toBe('tool_use');
    expect(normalized.recommendations).toEqual(basePayload.recommendations);
    expect(normalized.overallReasoning).toBe('OpenAI adapter recovered rationale');
  });
});
