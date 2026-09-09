import { jest } from '@jest/globals';

/**
 * Per-workspace noise guidance in the assignment prompt (QA 09-05, option 2).
 *
 * The built-in prompt learned "noise" in an IT queue, where a no-reply sender
 * usually IS noise. In an Accounts Payable mailbox that reads backwards — the
 * vendor robots are the customers — and the pipeline called 1,535 ordinary AP
 * tickets non-actionable in 180 days while a person worked 844 of them.
 *
 * The prompt is assembled inline in assignmentPipelineService, so rather than
 * boot that whole module these pin the CONTRACT the injection has to satisfy:
 * the guidance must be present, must be marked as overriding, and must
 * specifically neutralise the automated-sender heuristic.
 */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// The exact assembly used by assignmentPipelineService (kept in step by the
// shape assertions below — if the wording there changes, this fails loudly).
function buildNoiseGuidanceSection(assignmentConfig) {
  const noiseGuidance = String(assignmentConfig?.noiseGuidance || '').trim();
  if (!noiseGuidance) return '';
  return `\n\n## Workspace Noise Guidance\nThis workspace has defined what counts as non-actionable noise in ITS mailbox. This guidance OVERRIDES the general noise heuristics above wherever they disagree — in particular, do not treat an automated or no-reply sender as evidence of noise if this guidance says such mail is the work.\n\n${noiseGuidance.slice(0, 4000)}`;
}

describe('workspace noise guidance injection', () => {
  test('no guidance configured means the prompt is untouched', () => {
    expect(buildNoiseGuidanceSection({})).toBe('');
    expect(buildNoiseGuidanceSection({ noiseGuidance: null })).toBe('');
    expect(buildNoiseGuidanceSection({ noiseGuidance: '   ' })).toBe('');
  });

  test('guidance is injected under its own heading', () => {
    const out = buildNoiseGuidanceSection({ noiseGuidance: 'Invoices are real work.' });
    expect(out).toContain('## Workspace Noise Guidance');
    expect(out).toContain('Invoices are real work.');
  });

  test('the guidance is declared to OVERRIDE the general heuristics', () => {
    // Without this the model has two conflicting instructions and no ordering.
    const out = buildNoiseGuidanceSection({ noiseGuidance: 'AP mailbox.' });
    expect(out).toMatch(/OVERRIDES the general noise heuristics/);
  });

  test('it specifically neutralises the automated-sender heuristic', () => {
    // This is the whole point: in AP, "no-reply" is not evidence of noise.
    const out = buildNoiseGuidanceSection({ noiseGuidance: 'AP mailbox.' });
    expect(out).toMatch(/do not treat an automated or no-reply sender as evidence of noise/);
  });

  test('a long guidance block is capped so it cannot bloat every run', () => {
    const long = 'x'.repeat(9000);
    const out = buildNoiseGuidanceSection({ noiseGuidance: long });
    expect(out).toContain('x'.repeat(4000));
    expect(out).not.toContain('x'.repeat(4001));
  });

  test('the real service still assembles the section the same way', async () => {
    // Guards against the service drifting from the contract above.
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(new URL('../src/services/assignmentPipelineService.js', import.meta.url), 'utf8');
    expect(src).toContain('## Workspace Noise Guidance');
    expect(src).toContain('OVERRIDES the general noise heuristics');
    expect(src).toContain('noiseGuidance.slice(0, 4000)');
  });
});
