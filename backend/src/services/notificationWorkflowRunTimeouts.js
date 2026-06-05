export const NOTIFICATION_WORKFLOW_RUN_TIMEOUT_MS = 2 * 60 * 1000;
export const NOTIFICATION_WORKFLOW_LLM_TIMEOUT_MS = 90 * 1000;
export const NOTIFICATION_WORKFLOW_PROVIDER_ATTEMPT_TIMEOUT_MS = 45 * 1000;
export const STALE_NOTIFICATION_WORKFLOW_RUN_TIMEOUT_MS = 15 * 60 * 1000;
export const NOTIFICATION_WORKFLOW_RUN_CLEANUP_INTERVAL_MS = 5 * 60 * 1000;

export const NOTIFICATION_WORKFLOW_RUN_TIMEOUT_CODE = 'notification_workflow_timeout';
export const NOTIFICATION_WORKFLOW_LLM_TIMEOUT_CODE = 'notification_workflow_llm_timeout';
export const AI_PROVIDER_ATTEMPT_TIMEOUT_CODE = 'ai_provider_attempt_timeout';
export const NOTIFICATION_WORKFLOW_STALE_TIMEOUT_CODE = 'notification_workflow_stale_timeout';

export function describeNotificationWorkflowTimeout(timeoutMs) {
  const seconds = Math.max(1, Math.round(Number(timeoutMs || 0) / 1000));
  if (seconds % 60 === 0) {
    const minutes = seconds / 60;
    return `${minutes} ${minutes === 1 ? 'minute' : 'minutes'}`;
  }
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}
