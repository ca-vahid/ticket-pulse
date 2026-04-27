import {
  buildCorrectionFeedbackEntry,
  findRecommendationByRank,
  isCorrectableAssignmentRun,
  validateCorrectionInput,
} from '../src/services/assignmentCorrectionService.js';

describe('assignment correction helpers', () => {
  test('requires a target technician and a meaningful reason', () => {
    expect(validateCorrectionInput({ reason: 'too short' })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'assignedTechId must be a positive integer',
        'reason must be at least 15 characters',
      ]),
    });
  });

  test('requires recommendation rank when selecting from LLM recommendations', () => {
    expect(validateCorrectionInput({
      assignedTechId: 12,
      selectionSource: 'recommendation',
      reason: 'The network context belongs with this specialist.',
    })).toMatchObject({
      valid: false,
      errors: expect.arrayContaining([
        'recommendationRank is required when selectionSource is recommendation',
      ]),
    });
  });

  test('normalizes manual correction input', () => {
    expect(validateCorrectionInput({
      assignedTechId: '42',
      selectionSource: 'manual',
      reason: 'Requester location and device stack match this technician.',
    })).toMatchObject({
      valid: true,
      normalized: {
        assignedTechId: 42,
        recommendationRank: null,
        selectionSource: 'manual',
      },
    });
  });

  test('finds recommendation by one-based rank', () => {
    const recommendations = [
      { techId: 1, techName: 'First' },
      { techId: 2, techName: 'Second' },
    ];

    expect(findRecommendationByRank(recommendations, 2)).toEqual({ techId: 2, techName: 'Second' });
    expect(findRecommendationByRank(recommendations, 0)).toBeNull();
    expect(findRecommendationByRank(recommendations, 3)).toBeNull();
  });

  test('builds feedback text with source and reason for AI training', () => {
    const feedback = buildCorrectionFeedbackEntry({
      timestamp: '2026-04-27 08:00:00 PDT',
      ticket: { freshserviceTicketId: 220089, subject: 'Storage alert' },
      fromTech: { name: 'Old Owner' },
      toTech: { name: 'New Owner' },
      selectionSource: 'recommendation',
      recommendationRank: 2,
      reason: 'This is tied to the storage platform New Owner maintains.',
    });

    expect(feedback).toContain('Ticket #220089 (Storage alert)');
    expect(feedback).toContain('Original: Old Owner');
    expect(feedback).toContain('Corrected: New Owner');
    expect(feedback).toContain('LLM recommendation #2');
    expect(feedback).toContain('storage platform');
  });

  test('allows reassignment for completed runs and legacy synced assignment runs', () => {
    expect(isCorrectableAssignmentRun({
      status: 'completed',
      decision: 'auto_assigned',
      assignedTechId: 38,
      syncStatus: 'synced',
    })).toBe(true);

    expect(isCorrectableAssignmentRun({
      status: 'failed',
      decision: 'auto_assigned',
      assignedTechId: 38,
      syncStatus: 'synced',
    })).toBe(true);

    expect(isCorrectableAssignmentRun({
      status: 'failed',
      decision: 'auto_assigned',
      assignedTechId: 38,
      syncStatus: 'failed',
    })).toBe(false);
  });
});
