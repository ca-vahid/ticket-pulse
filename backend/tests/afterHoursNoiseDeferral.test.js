import { describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';
import { deriveIsNoise as deriveIsNoiseRule, resolvePipelineDecision } from '../src/services/assignmentDecisionRules.js';

/**
 * Sep 10 2026 — after-hours priority passes were auto-closing live tickets.
 *
 * A priority-assessment-only run defers assignment ranking by design, so it
 * returns `recommendations: []` EVERY time. The pipeline read that empty array
 * as the noise verdict, and because `isNoise` is checked before
 * `isPriorityAssessmentOnly` in resolvePipelineDecision, the run finalized as
 * noise_dismissed and (ws1 has autoCloseNoise on) closed the ticket in
 * FreshService.
 *
 * Two real casualties, both reopened by hand:
 *   run 24101 — #241481 "Issue with Oasis Montaj license"
 *   run 24080 — #241462 "Darktrace: 92.0 — Possible SSL Command and Control"
 * Both recorded overallReasoning saying, in as many words, "This ticket is
 * actionable — not noise". Neither set nonActionable.
 *
 * The fix keeps the branch ORDER (an after-hours pass is still allowed to
 * dismiss noise — that is deliberate and covered below) and instead stops the
 * empty array from being read as a verdict for those runs. The model must say
 * noise positively via `nonActionable`.
 *
 * 27 Sep 2026: even that was too much. An explicit nonActionable on a
 * priority pass still closed real work overnight (HR notices, a Darktrace
 * review) and skipped the business-hours run that would have routed it. A
 * priority pass now NEVER closes; nonActionable is only a label there.
 */

// The derivation assignmentPipelineService._executeRun uses.
const deriveIsNoise = (recommendation, isPriorityAssessmentOnly) => deriveIsNoiseRule({ recommendation, isPriorityAssessmentOnly });

const decide = (recommendation, { isPriorityAssessmentOnly = false, ...rest } = {}) =>
  resolvePipelineDecision({
    recommendation,
    triggerSource: isPriorityAssessmentOnly ? 'priority_assessment_after_hours' : 'poll',
    isPriorityAssessmentOnly,
    isNoise: deriveIsNoise(recommendation, isPriorityAssessmentOnly),
    autoAssign: true,
    ...rest,
  });

describe('the tickets that were auto-closed', () => {
  test('run 24101 — "actionable, ranking deferred" now defers instead of dismissing', () => {
    const recommendation = {
      recommendations: [],
      overallReasoning:
        'Priority-assessment-only pass (after-hours, 04:08 AM PT). This ticket is actionable — not noise '
        + '— but full assignment ranking is deferred to the business-hours run per workspace policy.',
    };
    expect(decide(recommendation, { isPriorityAssessmentOnly: true })).toBe('priority_only');
  });

  test('run 24080 — the Darktrace security alert survives too', () => {
    const recommendation = {
      recommendations: [],
      overallReasoning: 'Priority-assessment-only mode (after-hours run). This ticket is a genuine, '
        + 'actionable security escalation — a Darktrace AI Analyst alert (score 92, "critical").',
    };
    expect(decide(recommendation, { isPriorityAssessmentOnly: true })).toBe('priority_only');
  });
});

describe('priority passes never dismiss noise (27 Sep 2026)', () => {
  test('an explicit nonActionable verdict is a label, not a close', () => {
    expect(decide(
      { recommendations: [], nonActionable: true, nonActionableReason: 'Automated backup success notice' },
      { isPriorityAssessmentOnly: true },
    )).toBe('priority_only');
  });

  test('priority_changed and priority_assessment_only behave the same way', () => {
    for (const triggerSource of ['priority_changed', 'priority_assessment_only']) {
      expect(resolvePipelineDecision({
        recommendation: { recommendations: [], nonActionable: true },
        triggerSource,
        isPriorityAssessmentOnly: true,
        isNoise: deriveIsNoise({ recommendations: [], nonActionable: true }, true),
        autoAssign: true,
      })).toBe('priority_only');
    }
  });

  test('nonActionable: false is not a noise verdict', () => {
    expect(decide({ recommendations: [], nonActionable: false }, { isPriorityAssessmentOnly: true }))
      .toBe('priority_only');
  });

  test('the branch order itself is unchanged — noise still outranks priority-only', () => {
    // Guards the deliberate rule this fix deliberately did NOT touch.
    expect(resolvePipelineDecision({
      recommendation: { recommendations: [] },
      triggerSource: 'priority_assessment_after_hours',
      isPriorityAssessmentOnly: true,
      isNoise: true,
      autoAssign: true,
    })).toBe('noise_dismissed');
  });
});

describe('ordinary runs are completely unaffected', () => {
  test('an empty array on a normal run is still the noise verdict', () => {
    expect(decide({ recommendations: [] })).toBe('noise_dismissed');
    expect(deriveIsNoise({ recommendations: [] }, false)).toBe(true);
  });

  test('a ranked recommendation still auto-assigns', () => {
    expect(decide({ recommendations: [{ techId: 17 }] })).toBe('auto_assigned');
  });

  test('a normal run does NOT need nonActionable to dismiss noise', () => {
    // The auto-close path for ordinary runs must not move (v3.8.42 promise).
    expect(deriveIsNoise({ recommendations: [], nonActionable: undefined }, false)).toBe(true);
  });

  test('observe-only groups still outrank everything', () => {
    expect(decide({ recommendations: [] }, { isPriorityAssessmentOnly: true, groupObserved: true }))
      .toBe('pending_review');
    expect(decide({ recommendations: [] }, { groupObserved: true })).toBe('pending_review');
  });
});

describe('the source still reads the way this test assumes', () => {
  test('the derivation in the pipeline is gated on isPriorityAssessmentOnly', () => {
    const src = readFileSync(new URL('../src/services/assignmentPipelineService.js', import.meta.url), 'utf8');
    expect(src).toMatch(/const isNoise = deriveIsNoise\(\{ recommendation, isPriorityAssessmentOnly \}\)/);
    // The priority-only prompt no longer invites an empty-array noise verdict.
    expect(src).not.toMatch(/If the ticket is non-actionable noise\/FYI, submit an empty recommendations array/);
    expect(src).toMatch(/This run never closes a ticket\./);
  });
});
