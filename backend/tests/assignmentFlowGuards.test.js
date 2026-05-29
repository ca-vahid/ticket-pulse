import {
  shouldCloseNoiseDismissedRun,
  shouldTriggerAssignmentForLatestRun,
  shouldTriggerClassificationForLatestRun,
} from '../src/services/assignmentFlowGuards.js';

describe('assignment flow guards', () => {
  test('only closes dismissed runs that have no recommendations', () => {
    expect(shouldCloseNoiseDismissedRun(null)).toBe(true);
    expect(shouldCloseNoiseDismissedRun({ recommendation: null })).toBe(true);
    expect(shouldCloseNoiseDismissedRun({ recommendation: { recommendations: [] } })).toBe(true);
    expect(
      shouldCloseNoiseDismissedRun({
        recommendation: {
          recommendations: [{ techId: 4, techName: 'Alexey Lavrenyuk' }],
        },
      }),
    ).toBe(false);
  });

  test('allows assignment polling only when the latest run is missing or retryable', () => {
    expect(shouldTriggerAssignmentForLatestRun(null)).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'failed' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'cancelled' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'skipped_stale' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'superseded' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'failed_schema_validation' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'completed', decision: 'priority_only' })).toBe(true);
    expect(shouldTriggerAssignmentForLatestRun({
      status: 'completed',
      decision: 'auto_assigned',
      assignedTechId: null,
      syncStatus: 'skipped',
      syncError: 'missing_fs_agent_id',
    })).toBe(true);

    expect(shouldTriggerAssignmentForLatestRun({ status: 'queued' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'running' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'completed', decision: 'pending_review' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'completed', decision: 'approved' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({
      status: 'completed',
      decision: 'auto_assigned',
      assignedTechId: 648411,
      syncStatus: 'skipped',
      syncError: 'missing_fs_agent_id',
    })).toBe(false);
  });

  test('allows classification polling only when the latest run is missing or retryable', () => {
    expect(shouldTriggerClassificationForLatestRun(null)).toBe(true);
    expect(shouldTriggerClassificationForLatestRun({ status: 'failed' })).toBe(true);
    expect(shouldTriggerClassificationForLatestRun({ status: 'cancelled' })).toBe(true);

    expect(shouldTriggerClassificationForLatestRun({ status: 'queued' })).toBe(false);
    expect(shouldTriggerClassificationForLatestRun({ status: 'running' })).toBe(false);
    expect(shouldTriggerClassificationForLatestRun({ status: 'completed', decision: 'classified_only' })).toBe(false);
    expect(shouldTriggerClassificationForLatestRun({ status: 'completed', decision: 'auto_assigned' })).toBe(false);
  });
});
