import { jest, describe, expect, test, beforeEach } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * Simorgh Release A — trusted intake + noise veto (their C1/C2/C3, B2/B3).
 *
 * The security agent has already investigated what it files. Production showed
 * Ticket Pulse re-prioritising, re-typing and — 39 times — auto-closing those
 * tickets unassigned on a noise *guess*. A trusted-intake credential's tickets
 * are stamped triage_mode='trusted' at creation, and from then on the pipeline
 * may pick an assignee and nothing else.
 */

const prismaMock = {
  ticket: { findUnique: jest.fn(), update: jest.fn().mockResolvedValue({}) },
  noiseRule: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { default: noiseRuleService } = await import('../src/services/noiseRuleService.js');
const { validateAllowlist, validateDefaultSource } = await import('../src/services/oauthClientService.js');
const { trustedReviewNeeded } = await import('../src/services/ticketService.js');

const src = (rel) => readFileSync(new URL(rel, import.meta.url), 'utf8');

beforeEach(() => {
  jest.clearAllMocks();
  noiseRuleService._rulesCache?.clear?.();
});

describe('C2 — a never_noise rule can be keyed on the sender', () => {
  const rules = (list) => {
    prismaMock.noiseRule.findMany.mockResolvedValue(list);
    // bust the per-workspace cache between cases
    noiseRuleService.invalidateCache?.(1);
  };

  test('text pattern "." + sender "^simorgh@" protects everything that address sends', async () => {
    rules([{ id: 9, name: 'Simorgh veto', mode: 'never_noise', pattern: '.', senderPattern: '^simorgh@', isEnabled: true }]);
    const r = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Threat Intelligence Report — weekly', requesterEmail: 'simorgh@bgcengineering.ca',
    });
    expect(r.vetoed).toBe(true);
    expect(r.ruleName).toBe('Simorgh veto');
  });

  test('...and does NOT protect the same subject from somebody else', async () => {
    rules([{ id: 9, name: 'Simorgh veto', mode: 'never_noise', pattern: '.', senderPattern: '^simorgh@', isEnabled: true }]);
    const r = await noiseRuleService.evaluateNeverNoise(1, {
      subject: 'Threat Intelligence Report — weekly', requesterEmail: 'azure-noreply@microsoft.com',
    });
    expect(r.vetoed).toBe(false);
  });

  test('a rule without a sender pattern behaves exactly as before (text only)', async () => {
    rules([{ id: 79, name: 'Physical packages & shipping', mode: 'never_noise', pattern: 'package|courier', senderPattern: null, isEnabled: true }]);
    const hit = await noiseRuleService.evaluateNeverNoise(1, { subject: 'Courier left a package', requesterEmail: 'anyone@x.com' });
    const miss = await noiseRuleService.evaluateNeverNoise(1, { subject: 'Printer jammed', requesterEmail: 'anyone@x.com' });
    expect(hit.vetoed).toBe(true);
    expect(miss.vetoed).toBe(false);
  });

  test('sender pattern with no sender on the ticket never vetoes (fail closed on the veto, open on the close)', async () => {
    rules([{ id: 9, name: 'Simorgh veto', mode: 'never_noise', pattern: '.', senderPattern: '^simorgh@', isEnabled: true }]);
    const r = await noiseRuleService.evaluateNeverNoise(1, { subject: 'anything', requesterEmail: null });
    expect(r.vetoed).toBe(false);
  });
});

describe('C2 — a trusted credential short-circuits noise evaluation entirely', () => {
  test('evaluate() returns not-noise before touching any rule', async () => {
    prismaMock.noiseRule.findMany.mockResolvedValue([{ id: 3, name: 'Defender for Identity Sensor Alerts', mode: 'noise', pattern: 'Defender for Identity', senderPattern: null, isEnabled: true }]);
    const r = await noiseRuleService.evaluate('Defender for Identity Sensor Alerts: sensor offline', null, 1, {
      requesterEmail: 'simorgh@bgcengineering.ca', trustedIntake: true,
    });
    expect(r.isNoise).toBe(false);
    expect(r.suppressReason).toBe('trusted_intake');
  });
});

describe('C3 — low-confidence tickets are left for a human', () => {
  test('recognises the review flag in either key spelling and as a string', () => {
    expect(trustedReviewNeeded({ simorghReviewNeeded: true })).toBe(true);
    expect(trustedReviewNeeded({ simorgh_review_needed: 'true' })).toBe(true);
    expect(trustedReviewNeeded({ simorghReviewNeeded: false })).toBe(false);
    expect(trustedReviewNeeded({ simorghVerdict: 'TruePositive' })).toBe(false);
    expect(trustedReviewNeeded(null)).toBe(false);
  });
});

describe('A2 / B8 — OAuth client validators', () => {
  test('allowlist accepts IPv4 and CIDR, from an array or a comma/newline string, deduped', () => {
    expect(validateAllowlist(['20.48.204.14', '52.228.84.0/24', '20.48.204.14'])).toEqual(['20.48.204.14', '52.228.84.0/24']);
    expect(validateAllowlist('130.107.159.104, 130.107.159.108\n20.48.204.14')).toEqual(['130.107.159.104', '130.107.159.108', '20.48.204.14']);
    expect(validateAllowlist('')).toEqual([]);
    expect(validateAllowlist(null)).toEqual([]);
  });

  test('allowlist rejects anything that is not an IPv4 address or CIDR', () => {
    expect(() => validateAllowlist(['simorgh-api.azurewebsites.net'])).toThrow(/Not an IPv4/);
    expect(() => validateAllowlist(['999.1.1.1'])).toThrow(/Not an IPv4/);
    expect(() => validateAllowlist(['10.0.0.0/33'])).toThrow(/Not an IPv4/);
  });

  test('defaultSource is an optional positive integer', () => {
    expect(validateDefaultSource(104)).toBe(104);
    expect(validateDefaultSource('104')).toBe(104);
    expect(validateDefaultSource(null)).toBeNull();
    expect(validateDefaultSource('')).toBeNull();
    expect(() => validateDefaultSource(0)).toThrow();
    expect(() => validateDefaultSource('portal')).toThrow();
  });
});

describe('C1 — the pipeline honours triage_mode=trusted at every write site', () => {
  const pipeline = src('../src/services/assignmentPipelineService.js');
  const ticketSvc = src('../src/services/ticketService.js');
  const auth = src('../src/middleware/apiKeyAuth.js');
  const api = src('../src/routes/apiV1.routes.js');

  test('assessment-only triggers stop before doing anything', () => {
    expect(pipeline).toMatch(/if \(isClassificationOnly \|\| isPriorityAssessmentOnly\) \{[\s\S]{0,400}triageMode === 'trusted'[\s\S]{0,200}reason: 'trusted_intake'/);
  });

  test('classification and priority/type persistence both refuse a trusted ticket', () => {
    const classify = pipeline.slice(pipeline.indexOf('async _persistInternalClassification('));
    expect(classify.slice(0, 300)).toMatch(/_isTrustedIntake\(ticketId\)/);
    const priority = pipeline.slice(pipeline.indexOf('async _persistPriorityAssessment('));
    expect(priority.slice(0, 300)).toMatch(/_isTrustedIntake\(ticketId\)/);
  });

  test('trusted intake is a noise veto in its own right, and the veto now sees the requester', () => {
    expect(pipeline).toMatch(/triageMode === 'trusted'\) \{\s*return \{ vetoed: true/);
    expect(pipeline).toMatch(/requesterEmail: ticket\.requester\?\.email/);
  });

  test('the ticket is stamped at creation and the credential carries the flag end to end', () => {
    expect(ticketSvc).toMatch(/actor\?\.trustedIntake === true \? \{ triageMode: 'trusted' \}/);
    expect(ticketSvc).toMatch(/trustedIntake: actor\?\.trustedIntake === true,/); // noise context
    expect(auth).toMatch(/trustedIntake: key\.trustedIntake === true/);
    expect(auth).toMatch(/trustedIntake: client\.trustedIntake === true/);
    expect(api).toMatch(/trustedIntake: req\.apiKey\.trustedIntake === true/);
  });

  test('a trusted ticket still gets an assignee — but not when flagged for review', () => {
    expect(ticketSvc).toMatch(/if \(actor\?\.trustedIntake === true\) \{[\s\S]{0,700}!trustedReviewNeeded\(data\.customFields\)[\s\S]{0,120}_startAiTriage/);
  });

  test('OAuth clients can carry an IP allowlist, like API keys', () => {
    expect(auth).toMatch(/ipAllowlist: Array\.isArray\(client\.ipAllowlist\) \? client\.ipAllowlist : \[\]/);
  });
});
