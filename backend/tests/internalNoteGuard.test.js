import {
  guardNotificationEmailPayload,
  internalNoteVerbatimLeak,
  HARD_BLOCK_GUARD_CHECKS,
} from '../src/services/notificationWorkflowOutputGuard.js';

/**
 * Internal-notes evidence policy (gap plan P5, decision 2026-07-07): notes may
 * inform drafts (quoteAllowed=false in the bundle) but their content must not
 * appear verbatim in requester-facing copy.
 */

const NOTE = 'The vendor confirmed the replacement drive ships Thursday and the requester should not be told the exact cost of the expedited freight until finance signs off on it';

const bundleWith = (entries) => ({ threadSummary: { entries } });
const privateEntry = { evidenceId: 'thread:9', quoteAllowed: false, content: NOTE };
const publicEntry = { evidenceId: 'thread:10', quoteAllowed: true, content: NOTE };

describe('internalNoteVerbatimLeak', () => {
  test('detects a 12-word window lifted from a non-quotable note', () => {
    const draft = `Hi! Quick update: the vendor confirmed the replacement drive ships Thursday and the requester should not be told anything else.`;
    const leak = internalNoteVerbatimLeak(draft, bundleWith([privateEntry]));
    expect(leak).not.toBeNull();
    expect(leak.evidenceId).toBe('thread:9');
  });

  test('paraphrases pass', () => {
    const draft = 'Good news — the replacement part is on its way and should arrive later this week.';
    expect(internalNoteVerbatimLeak(draft, bundleWith([privateEntry]))).toBeNull();
  });

  test('quotable entries are not flagged', () => {
    const draft = `Update: ${NOTE}.`;
    expect(internalNoteVerbatimLeak(draft, bundleWith([publicEntry]))).toBeNull();
  });
});

describe('guardNotificationEmailPayload internal_note_verbatim', () => {
  test('is a registered hard-block check', () => {
    expect(HARD_BLOCK_GUARD_CHECKS).toContain('internal_note_verbatim');
  });

  test('blocks a draft that quotes an internal note verbatim', () => {
    expect(() => guardNotificationEmailPayload(
      { subject: 'Update', text: `FYI — the vendor confirmed the replacement drive ships Thursday and the requester should not be told more.` },
      { contextBundle: bundleWith([privateEntry]) },
    )).toThrow(/internal-note content verbatim/);
  });

  test('allows a paraphrased draft through', () => {
    const result = guardNotificationEmailPayload(
      { subject: 'Update', text: 'The replacement part is ordered and on track for later this week.' },
      { contextBundle: bundleWith([privateEntry]) },
    );
    expect(result.payload.text).toContain('replacement part');
  });
});
