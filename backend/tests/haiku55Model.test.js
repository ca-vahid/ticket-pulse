import { describe, expect, test } from '@jest/globals';
import {
  AI_PROVIDER_ANTHROPIC, HAIKU_5_5_MODEL, anthropicRequestRules, getModelMetadata, modelSupportsVision,
  shouldOmitAnthropicTemperature, supportsOperation,
} from '../src/utils/aiProviders.js';
import { costUsdFor } from '../src/services/tokenUsageService.js';

// Claude Haiku 5.5 (7 Oct 2026), registered 16 Oct 2026. Request shapes were
// checked live: tools + forced tool_choice, thinking 'disabled' and images are
// accepted; `temperature` is refused (400 "deprecated for this model").
describe('Claude Haiku 5.5', () => {
  test('is offered for every operation, with tools and images', () => {
    const meta = getModelMetadata({ provider: AI_PROVIDER_ANTHROPIC, operation: 'assignment_pipeline' });
    expect(meta).toEqual(expect.arrayContaining([expect.objectContaining({ model: HAIKU_5_5_MODEL, supportsTools: true })]));
    expect(supportsOperation(HAIKU_5_5_MODEL, AI_PROVIDER_ANTHROPIC, 'notification_workflow_generation')).toBe(true);
    expect(modelSupportsVision(HAIKU_5_5_MODEL, AI_PROVIDER_ANTHROPIC)).toBe(true);
  });

  test('never sends temperature; thinking off and forced tool choice are allowed', () => {
    expect(shouldOmitAnthropicTemperature(HAIKU_5_5_MODEL)).toBe(true);
    expect(shouldOmitAnthropicTemperature('claude-haiku-4-5-20251001')).toBe(false);
    expect(anthropicRequestRules(HAIKU_5_5_MODEL)).toEqual({ thinkingOff: { type: 'disabled' }, forcedToolChoice: true });
  });

  test('is priced at $0.10 in / $0.50 out per million, not at the Haiku 4.5 rate', () => {
    expect(costUsdFor({ model: HAIKU_5_5_MODEL, inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(0.6, 5);
    expect(costUsdFor({ model: 'claude-haiku-4-5-20251001', inputTokens: 1e6, outputTokens: 1e6 })).toBeCloseTo(6, 5);
  });
});
