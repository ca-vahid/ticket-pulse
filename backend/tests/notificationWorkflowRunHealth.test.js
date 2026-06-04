import {
  NOTIFICATION_WORKFLOW_RUN_HEALTH,
  classifyNotificationWorkflowRun,
} from '../src/services/notificationWorkflowRunHealth.js';

function run(overrides = {}) {
  return {
    id: 1,
    status: 'completed',
    steps: [
      {
        id: 10,
        nodeId: 'trigger-1',
        nodeType: 'trigger',
        status: 'completed',
        output: {},
      },
    ],
    deliveries: [],
    aiProviderAttempts: [],
    ...overrides,
  };
}

describe('notification workflow run health', () => {
  test('classifies a clean completed run', () => {
    const health = classifyNotificationWorkflowRun(run());

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_CLEAN);
    expect(health.degraded).toBe(false);
    expect(health.fallbackSummary).toBeNull();
  });

  test('classifies repaired requester-facing output', () => {
    const health = classifyNotificationWorkflowRun(run({
      steps: [
        {
          nodeId: 'llm-1',
          nodeType: 'llm_generate',
          status: 'completed',
          output: {
            provider: 'openai',
            model: 'gpt-5.5',
            guard: {
              accepted: true,
              repairedIssues: [{ id: 'unsupported_timing_claims', message: 'Removed timing claim.' }],
            },
          },
        },
      ],
    }));

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_REPAIR);
    expect(health.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'llm_output_repaired',
        tier: 'auto_repair',
        action: 'repaired',
        ruleIds: ['unsupported_timing_claims'],
      }),
    ]));
  });

  test('classifies audit-only requester-facing findings as warning', () => {
    const health = classifyNotificationWorkflowRun(run({
      steps: [
        {
          nodeId: 'llm-1',
          nodeType: 'llm_generate',
          status: 'completed',
          output: {
            provider: 'openai',
            model: 'gpt-5.5',
            guard: {
              accepted: true,
              auditOnlyIssues: [{ id: 'emoji', policyTier: 'audit_only', actionTaken: 'warned' }],
            },
          },
        },
      ],
    }));

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_WARNING);
    expect(health.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'guard_audit_only',
        tier: 'audit_only',
        action: 'warned',
        ruleIds: ['emoji'],
      }),
    ]));
  });

  test('classifies template fallback after provider schema failure', () => {
    const health = classifyNotificationWorkflowRun(run({
      steps: [
        {
          nodeId: 'llm-1',
          nodeType: 'llm_generate',
          status: 'completed',
          output: {
            failed: true,
            failureType: 'provider_or_schema',
            templateFallbackUsed: true,
            error: "400 Unknown parameter: input[2].parsed_arguments",
            provider: 'openai',
            model: 'gpt-5.5',
          },
        },
      ],
      aiProviderAttempts: [
        {
          provider: 'openai',
          model: 'gpt-5.5',
          status: 'failed',
          errorClass: 'bad_request',
          errorMessage: "400 Unknown parameter: input[2].parsed_arguments",
        },
      ],
    }));

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK);
    expect(health.fallbackUsed).toBe(true);
    expect(health.fallbackSummary).toEqual(expect.objectContaining({
      type: 'provider_or_schema',
      reason: "400 Unknown parameter: input[2].parsed_arguments",
      provider: 'openai',
      model: 'gpt-5.5',
    }));
  });

  test('classifies guard rejection as fallback with hard-block reason', () => {
    const health = classifyNotificationWorkflowRun(run({
      steps: [
        {
          nodeId: 'llm-1',
          nodeType: 'llm_generate',
          status: 'completed',
          output: {
            failed: true,
            failureType: 'guard_rejected',
            guardRejected: true,
            templateFallbackUsed: true,
            warning: 'LLM output was rejected by the requester-facing guard; template fallback was used.',
            guard: {
              accepted: false,
              issues: ['internal_references'],
            },
          },
        },
      ],
    }));

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK);
    expect(health.fallbackSummary).toEqual(expect.objectContaining({
      type: 'guard_rejected',
      source: 'guard',
      ruleIds: ['internal_references'],
    }));
  });

  test('classifies non-terminal tool failure as warning', () => {
    const health = classifyNotificationWorkflowRun(run({
      steps: [
        {
          nodeId: 'llm-generate:submit_notification_email:1',
          nodeType: 'llm_tool',
          status: 'failed',
          error: 'LLM cited unknown evidence id(s): abc',
          output: {},
        },
      ],
    }));

    expect(health.state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_WARNING);
    expect(health.reasons).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'llm_tool_failed',
        tier: 'warning',
      }),
    ]));
  });

  test('classifies failed workflow or failed delivery as failed', () => {
    expect(classifyNotificationWorkflowRun(run({ status: 'failed' })).state)
      .toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.FAILED);

    expect(classifyNotificationWorkflowRun(run({
      deliveries: [{ id: 50, status: 'failed', error: 'SendGrid failed' }],
    })).state).toBe(NOTIFICATION_WORKFLOW_RUN_HEALTH.FAILED);
  });
});
