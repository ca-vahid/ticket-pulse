import {
  shouldCloseNoiseDismissedRun,
  shouldTriggerAssignmentForLatestRun,
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

    expect(shouldTriggerAssignmentForLatestRun({ status: 'queued' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'running' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'completed', decision: 'pending_review' })).toBe(false);
    expect(shouldTriggerAssignmentForLatestRun({ status: 'completed', decision: 'approved' })).toBe(false);
  });
});
