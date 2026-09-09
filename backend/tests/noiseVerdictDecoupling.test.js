import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * Noise verdict decoupled from routing (QA 09-05, Accounting option 3).
 *
 * Before this change a noise verdict and an assignment recommendation were the
 * SAME field: the model signalled "noise" by returning an empty recommendations
 * array, so it was structurally incapable of saying "this looks non-actionable,
 * and if you disagree, here is who should handle it". In Accounting — where
 * nothing auto-closes — that left 1,535 tickets unrouted in 180 days while a
 * person picked up 844 of them by hand.
 *
 * The contract these pin:
 *   1. ws1 (auto-close ON) must not move. At all.
 *   2. Where auto-close is off, the model is told to route AND label.
 *   3. The label never triggers auto-close; only an empty array does.
 */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { resolvePipelineDecision } = await import('../src/services/assignmentDecisionRules.js');

// The two computations the pipeline performs, mirrored exactly.
const computeIsNoise = (rec) => Boolean(rec) && (!rec.recommendations || rec.recommendations.length === 0);
const computeFlagged = (rec) => rec?.nonActionable === true;

const withRecs = { recommendations: [{ rank: 1, techId: 7, techName: 'Ana', score: 0.8, reasoning: 'AP owner' }] };
const emptyRecs = { recommendations: [] };

describe('noise verdict decoupling — ws1 must not move', () => {
  test('an empty recommendations array is still the noise verdict', () => {
    expect(computeIsNoise(emptyRecs)).toBe(true);
    expect(computeIsNoise({ recommendations: undefined })).toBe(true);
    expect(computeIsNoise(withRecs)).toBe(false);
  });

  test('empty recommendations still resolve to noise_dismissed', () => {
    // This is the ws1 auto-close path. If this ever returns anything else,
    // IT stops auto-closing and the release is wrong.
    expect(resolvePipelineDecision({
      recommendation: emptyRecs, isNoise: true, autoAssign: true,
    })).toBe('noise_dismissed');
  });

  test('the new label does NOT make an ordinary ticket look like noise', () => {
    // A run carrying recommendations is routed, label or no label.
    const rec = { ...withRecs, nonActionable: true };
    expect(computeIsNoise(rec)).toBe(false);
    expect(computeFlagged(rec)).toBe(true);
    expect(resolvePipelineDecision({
      recommendation: rec, isNoise: computeIsNoise(rec), autoAssign: false,
    })).toBe('pending_review');
  });

  test('a labelled run with recommendations auto-assigns where autoAssign is on', () => {
    // The whole point: the ticket still reaches somebody.
    const rec = { ...withRecs, nonActionable: true };
    expect(resolvePipelineDecision({
      recommendation: rec, isNoise: false, autoAssign: true,
    })).toBe('auto_assigned');
  });

  test('the label alone can never produce a dismissal', () => {
    // nonActionable is not an input to the decision resolver at all — the only
    // route to noise_dismissed is an empty recommendations array.
    const decision = resolvePipelineDecision({
      recommendation: { ...withRecs, nonActionable: true }, isNoise: false, autoAssign: false,
    });
    expect(decision).not.toBe('noise_dismissed');
  });

  test('observed groups still outrank the noise branch (AR graduation)', () => {
    // Unchanged by this release, and load-bearing for the AR observation
    // window: a noise verdict on an observed group stays a suggestion.
    expect(resolvePipelineDecision({
      recommendation: emptyRecs, isNoise: true, groupObserved: true, autoAssign: true,
    })).toBe('pending_review');
  });
});

describe('noise verdict decoupling — the prompt instruction', () => {
  // The instruction is assembled inline in assignmentPipelineService; these
  // assert the shipped source, so a reword that loses the contract fails here.
  const src = readFileSync(new URL('../src/services/assignmentPipelineService.js', import.meta.url), 'utf8');

  test('only workspaces that do NOT auto-close get the routing instruction', () => {
    expect(src).toContain("assignmentConfig?.autoCloseNoise !== true");
    expect(src).toContain('## Non-actionable Tickets In This Workspace');
  });

  test('the instruction tells the model to route AND label, not one or the other', () => {
    expect(src).toMatch(/still return your best ranked recommendations AND set/);
    expect(src).toMatch(/Do NOT return an empty recommendations array in this workspace/);
  });

  test('the label is read from its own field, never inferred from the array', () => {
    expect(src).toContain('recommendation?.nonActionable === true');
    // isNoise keeps its original definition.
    expect(src).toContain('!recommendation.recommendations || recommendation.recommendations.length === 0');
  });

  test('priority-only and classification-only runs are left alone', () => {
    // Those modes have their own contracts; adding a routing demand would
    // fight them.
    expect(src).toMatch(/!isPriorityAssessmentOnly && triggerSource !== 'classification_only'/);
  });

  test('the tool schema exposes the label to the model', () => {
    const tools = readFileSync(new URL('../src/services/assignmentTools.js', import.meta.url), 'utf8');
    expect(tools).toContain('nonActionable:');
    expect(tools).toMatch(/This is a LABEL, separate from routing/);
  });
});

describe('measurement survives the change', () => {
  test('a verdict counts in EITHER form, so the panel does not read as "the AI stopped"', () => {
    const svc = readFileSync(new URL('../src/services/noiseVerdictOutcomeService.js', import.meta.url), 'utf8');
    expect(svc).toContain("r.decision = 'noise_dismissed' OR r.non_actionable = true");
    // And the two forms stay distinguishable in the payload.
    expect(svc).toContain('asDismissal');
    expect(svc).toContain('asLabel');
  });
});
