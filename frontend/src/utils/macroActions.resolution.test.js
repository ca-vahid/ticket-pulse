import { describe, expect, test } from 'vitest';
import { describeStep, stepsForSave } from './macroActions';

// 6 Nov 2026: a "Set status" step can carry a resolution reason (a Security
// ticket cannot close without one).
describe('status step resolution reason', () => {
  test('saved when set, dropped when empty', () => {
    const [kept] = stepsForSave([{ type: 'status', status: 'Closed', resolutionReason: 'false_positive', resolutionNote: '' }]);
    expect(kept).toEqual({ type: 'status', status: 'Closed', resolutionReason: 'false_positive' });
    const [plain] = stepsForSave([{ type: 'status', status: 'Closed', resolutionReason: '', resolutionNote: 'x' }]);
    expect(plain).toEqual({ type: 'status', status: 'Closed' });
  });

  test('the list line names the reason', () => {
    expect(describeStep({ type: 'status', status: 'Closed', resolutionReason: 'false_positive' })).toBe('Set status to Closed · False positive');
    expect(describeStep({ type: 'status', status: 'Pending' })).toBe('Set status to Pending');
  });
});
