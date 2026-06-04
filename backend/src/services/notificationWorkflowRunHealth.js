export const NOTIFICATION_WORKFLOW_RUN_HEALTH = Object.freeze({
  COMPLETED_CLEAN: 'completed_clean',
  COMPLETED_WITH_REPAIR: 'completed_with_repair',
  COMPLETED_WITH_FALLBACK: 'completed_with_fallback',
  COMPLETED_WITH_WARNING: 'completed_with_warning',
  FAILED: 'failed',
});

const HEALTH_LABELS = Object.freeze({
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_CLEAN]: 'Clean',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_REPAIR]: 'Repaired',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK]: 'Fallback',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_WARNING]: 'Warning',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.FAILED]: 'Failed',
});

const HEALTH_TONES = Object.freeze({
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_CLEAN]: 'emerald',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_REPAIR]: 'amber',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK]: 'red',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_WARNING]: 'amber',
  [NOTIFICATION_WORKFLOW_RUN_HEALTH.FAILED]: 'red',
});

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function compactMessage(value, fallback = null) {
  const text = String(value || '').trim();
  if (!text) return fallback;
  return text.length > 240 ? `${text.slice(0, 240)}...` : text;
}

function llmOutputForStep(step = {}) {
  const output = step.output || {};
  if (output.llm && typeof output.llm === 'object') return output.llm;
  return step.nodeType === 'llm_generate' ? output : null;
}

function addReason(reasons, reason = {}) {
  const type = String(reason.type || '').trim();
  if (!type) return;
  reasons.push({
    type,
    source: reason.source || null,
    tier: reason.tier || null,
    action: reason.action || null,
    nodeId: reason.nodeId || null,
    deliveryId: reason.deliveryId || null,
    provider: reason.provider || null,
    model: reason.model || null,
    ruleIds: asArray(reason.ruleIds),
    message: compactMessage(reason.message, 'Review this run before live sends.'),
  });
}

function issueIds(issues) {
  return asArray(issues)
    .map((issue) => {
      if (typeof issue === 'string') return issue;
      return issue?.id || issue?.ruleId || issue?.type || issue?.message || null;
    })
    .filter(Boolean);
}

function repairedIssueIds(llm = {}) {
  return [
    ...issueIds(llm.repairedIssues),
    ...issueIds(llm.guard?.repairedIssues),
    ...asArray(llm.repairedFields),
  ];
}

function blockedIssueIds(llm = {}) {
  return [
    ...issueIds(llm.blockedIssues),
    ...issueIds(llm.guard?.issues),
  ];
}

function auditOnlyIssueIds(llm = {}) {
  return [
    ...issueIds(llm.auditWarnings),
    ...issueIds(llm.guard?.auditOnlyIssues),
  ];
}

function providerAttemptReasons(run = {}, reasons) {
  for (const attempt of run.aiProviderAttempts || []) {
    if (attempt.status !== 'failed') continue;
    addReason(reasons, {
      type: 'provider_attempt_failed',
      tier: 'fallback',
      action: 'template_fallback',
      provider: attempt.provider || null,
      model: attempt.model || null,
      message: attempt.errorMessage || attempt.errorClass || 'Provider attempt failed.',
    });
  }
}

export function classifyNotificationWorkflowRun(run = {}) {
  const reasons = [];
  let hasFallback = false;
  let hasRepair = false;
  let hasWarning = false;

  for (const step of run.steps || []) {
    const output = step.output || {};
    const llm = llmOutputForStep(step);

    if (output.duplicateDelivery === true) {
      hasWarning = true;
      addReason(reasons, {
        type: 'duplicate_delivery',
        tier: 'warning',
        action: 'suppressed',
        nodeId: step.nodeId,
        message: output.reason || 'A duplicate workflow delivery was suppressed.',
      });
    }

    if (step.status === 'failed' && step.nodeType !== 'llm_generate') {
      hasWarning = true;
      addReason(reasons, {
        type: `${step.nodeType || 'step'}_failed`,
        tier: 'warning',
        action: 'review',
        nodeId: step.nodeId,
        message: step.error || `${step.nodeType || 'Workflow'} step failed.`,
      });
    }

    if (!llm) continue;

    const repaired = repairedIssueIds(llm);
    const blocked = blockedIssueIds(llm);
    const auditOnly = auditOnlyIssueIds(llm);
    if (repaired.length > 0) {
      hasRepair = true;
      addReason(reasons, {
        type: 'llm_output_repaired',
        tier: 'auto_repair',
        action: 'repaired',
        nodeId: step.nodeId,
        provider: llm.provider,
        model: llm.model,
        ruleIds: repaired,
        message: 'Requester-facing LLM output was repaired before rendering.',
      });
    }

    if (auditOnly.length > 0) {
      hasWarning = true;
      addReason(reasons, {
        type: 'guard_audit_only',
        tier: 'audit_only',
        action: 'warned',
        nodeId: step.nodeId,
        provider: llm.provider,
        model: llm.model,
        ruleIds: auditOnly,
        message: 'Requester-facing LLM output had audit-only style findings.',
      });
    }

    if (
      llm.failed === true
      || llm.templateFallbackUsed === true
      || llm.guardRejected === true
      || ['provider_or_schema', 'guard_rejected'].includes(llm.failureType)
    ) {
      hasFallback = true;
      addReason(reasons, {
        type: llm.guardRejected ? 'guard_rejected' : (llm.failureType || 'llm_failed'),
        source: llm.templateFallbackSource || (llm.guardRejected ? 'guard' : null),
        tier: llm.guardRejected ? 'hard_block' : 'fallback',
        action: 'template_fallback',
        nodeId: step.nodeId,
        provider: llm.provider,
        model: llm.model,
        ruleIds: asArray(llm.guardPolicyRuleIds).length ? asArray(llm.guardPolicyRuleIds) : blocked,
        message: llm.templateFallbackReason || llm.warning || llm.error || 'LLM generation did not produce a usable requester-facing email.',
      });
    } else if (llm.warning) {
      hasWarning = true;
      addReason(reasons, {
        type: 'llm_warning',
        tier: 'warning',
        action: 'review',
        nodeId: step.nodeId,
        provider: llm.provider,
        model: llm.model,
        message: llm.warning,
      });
    }
  }

  for (const delivery of run.deliveries || []) {
    if (delivery.status === 'failed') {
      addReason(reasons, {
        type: 'delivery_failed',
        tier: 'failed',
        action: 'failed',
        deliveryId: delivery.id,
        message: delivery.error || 'Workflow delivery failed.',
      });
    }
    if (delivery?.payload?.duplicateDelivery === true) {
      hasWarning = true;
      addReason(reasons, {
        type: 'duplicate_delivery',
        tier: 'warning',
        action: 'suppressed',
        deliveryId: delivery.id,
        message: 'A duplicate workflow delivery was suppressed.',
      });
    }
  }

  providerAttemptReasons(run, reasons);
  if ((run.aiProviderAttempts || []).some((attempt) => attempt.status === 'failed')) {
    hasFallback = hasFallback || reasons.some((reason) => reason.type === 'provider_attempt_failed');
  }

  const deliveryFailed = (run.deliveries || []).some((delivery) => delivery.status === 'failed');
  let state = NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_CLEAN;
  if (run.status === 'failed' || deliveryFailed) {
    state = NOTIFICATION_WORKFLOW_RUN_HEALTH.FAILED;
  } else if (hasFallback) {
    state = NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK;
  } else if (hasRepair) {
    state = NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_REPAIR;
  } else if (hasWarning || run.status === 'running') {
    state = NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_WARNING;
  }

  const fallbackReason = reasons.find((reason) => (
    reason.action === 'template_fallback'
    || reason.type === 'provider_attempt_failed'
    || reason.type === 'guard_rejected'
  )) || null;

  return {
    state,
    label: HEALTH_LABELS[state],
    tone: HEALTH_TONES[state],
    degraded: state !== NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_CLEAN,
    fallbackUsed: state === NOTIFICATION_WORKFLOW_RUN_HEALTH.COMPLETED_WITH_FALLBACK,
    fallbackSummary: fallbackReason ? {
      type: fallbackReason.type,
      source: fallbackReason.source || (fallbackReason.provider ? 'provider' : fallbackReason.type === 'guard_rejected' ? 'guard' : 'workflow'),
      reason: fallbackReason.message,
      nodeId: fallbackReason.nodeId,
      provider: fallbackReason.provider,
      model: fallbackReason.model,
      ruleIds: fallbackReason.ruleIds,
    } : null,
    reasons,
  };
}

export default classifyNotificationWorkflowRun;
