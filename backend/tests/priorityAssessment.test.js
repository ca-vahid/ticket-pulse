import {
  buildPriorityTicketUpdateFields,
  normalizePriority,
  priorityMeetsThreshold,
  validateRecommendationPriorityFields,
} from '../src/services/priorityAssessment.js';

describe('priority assessment helpers', () => {
  test('normalizes Ticket Pulse priority labels and FreshService priority IDs', () => {
    expect(normalizePriority('Low')).toEqual({ label: 'Low', id: 1 });
    expect(normalizePriority('medium')).toEqual({ label: 'Medium', id: 2 });
    expect(normalizePriority('HIGH')).toEqual({ label: 'High', id: 3 });
    expect(normalizePriority('critical')).toEqual({ label: 'Urgent', id: 4 });
  });

  test('rejects missing or invalid assessed priority schema fields', () => {
    expect(() => validateRecommendationPriorityFields({
      priorityRationale: 'Blocked requester work',
      priorityConfidence: 'high',
    })).toThrow(/assessedPriority/);

    expect(() => validateRecommendationPriorityFields({
      assessedPriority: 'Severe',
      priorityRationale: 'Blocked requester work',
      priorityConfidence: 'high',
    })).toThrow(/assessedPriority/);

    expect(() => validateRecommendationPriorityFields({
      assessedPriority: 'High',
      priorityRationale: '',
      priorityConfidence: 'high',
    })).toThrow(/priorityRationale/);
  });

  test('builds persistence fields for successful assessments', () => {
    const assessedAt = new Date('2026-05-26T16:30:00.000Z');
    expect(buildPriorityTicketUpdateFields({
      assessedPriority: 'Urgent',
      priorityRationale: 'Active outage for a project team',
      priorityConfidence: 'medium',
      prioritySignals: ['outage language', 'team impact'],
    }, 44, assessedAt)).toEqual({
      assessedPriority: 'Urgent',
      assessedPriorityId: 4,
      priorityRationale: 'Active outage for a project team',
      priorityConfidence: 'medium',
      priorityEvidence: ['outage language', 'team impact'],
      priorityAssessedAt: assessedAt,
      priorityAssessedByRunId: 44,
    });
  });

  test('matches notification thresholds for High, Urgent, and disabled states', () => {
    expect(priorityMeetsThreshold('High', 'high_urgent')).toBe(true);
    expect(priorityMeetsThreshold('Urgent', 'high_urgent')).toBe(true);
    expect(priorityMeetsThreshold('Medium', 'high_urgent')).toBe(false);
    expect(priorityMeetsThreshold('Urgent', 'urgent_only')).toBe(true);
    expect(priorityMeetsThreshold('High', 'urgent_only')).toBe(false);
    expect(priorityMeetsThreshold('Urgent', 'disabled')).toBe(false);
  });
});
