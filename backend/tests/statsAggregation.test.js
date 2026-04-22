import { tallyGroupedRuns, adjustForHandledInFs } from '../src/services/assignmentStatsAggregation.js';

const row = (status, decision, count) => ({
  status,
  decision,
  _count: { _all: count },
});

describe('tallyGroupedRuns — empty / null inputs', () => {
  test('handles empty array', () => {
    expect(tallyGroupedRuns([])).toEqual({
      totalRuns: 0,
      autoAssigned: 0,
      approved: 0,
      noiseDismissed: 0,
      manualReviewRequired: 0,
      inProgress: 0,
      queuedForLater: 0,
    });
  });

  test('handles null input without crashing', () => {
    const t = tallyGroupedRuns(null);
    expect(t.totalRuns).toBe(0);
  });

  test('handles undefined input without crashing', () => {
    const t = tallyGroupedRuns(undefined);
    expect(t.totalRuns).toBe(0);
  });

  test('skips rows with non-finite or non-positive counts', () => {
    const t = tallyGroupedRuns([
      row('completed', 'auto_assigned', 0),
      row('completed', 'auto_assigned', -1),
      row('completed', 'auto_assigned', NaN),
      row('completed', 'auto_assigned', 5),
    ]);
    expect(t.autoAssigned).toBe(5);
    expect(t.totalRuns).toBe(5);
  });
});

describe('tallyGroupedRuns — bucket assignment', () => {
  test('auto_assigned counts go to autoAssigned bucket', () => {
    const t = tallyGroupedRuns([row('completed', 'auto_assigned', 10)]);
    expect(t.autoAssigned).toBe(10);
    expect(t.totalRuns).toBe(10);
  });

  test('approved AND modified both count as "approved"', () => {
    // Both decision values represent admin-confirmed assignments — the only
    // difference is whether the admin overrode the LLM's top pick. From the
    // empty-state stats perspective they're the same kind of event.
    const t = tallyGroupedRuns([
      row('completed', 'approved', 4),
      row('completed', 'modified', 3),
    ]);
    expect(t.approved).toBe(7);
    expect(t.totalRuns).toBe(7);
  });

  test('noise_dismissed goes to its own bucket', () => {
    const t = tallyGroupedRuns([row('completed', 'noise_dismissed', 6)]);
    expect(t.noiseDismissed).toBe(6);
  });

  test('pending_review goes to manualReviewRequired (caller adjusts later for handled-in-FS)', () => {
    const t = tallyGroupedRuns([row('completed', 'pending_review', 8)]);
    expect(t.manualReviewRequired).toBe(8);
  });

  test('status=running goes to inProgress regardless of decision', () => {
    const t = tallyGroupedRuns([
      row('running', null, 2),
      row('running', 'pending_review', 1),
    ]);
    expect(t.inProgress).toBe(3);
    expect(t.manualReviewRequired).toBe(0);
  });

  test('status=queued goes to queuedForLater regardless of decision', () => {
    const t = tallyGroupedRuns([
      row('queued', null, 4),
      row('queued', 'pending_review', 1),
    ]);
    expect(t.queuedForLater).toBe(5);
    expect(t.manualReviewRequired).toBe(0);
  });

  test('status=failed/skipped_stale/superseded counts toward totalRuns but no bucket', () => {
    // Failure modes shouldn't pollute the success-oriented buckets, but they
    // ARE pipeline runs that happened today, so totalRuns should include them
    // for the "out of N total" context line.
    const t = tallyGroupedRuns([
      row('failed', null, 2),
      row('skipped_stale', null, 1),
      row('superseded', 'pending_review', 1),
    ]);
    expect(t.totalRuns).toBe(4);
    expect(t.autoAssigned + t.approved + t.noiseDismissed + t.manualReviewRequired).toBe(0);
  });

  test('unknown decision values inside completed runs are tolerated', () => {
    // Defensive: if someone adds a new decision type without updating this
    // helper, totalRuns still counts it (so "out of N total" stays honest)
    // but it lands in no specific bucket.
    const t = tallyGroupedRuns([
      row('completed', 'some_future_decision', 3),
      row('completed', 'auto_assigned', 5),
    ]);
    expect(t.totalRuns).toBe(8);
    expect(t.autoAssigned).toBe(5);
  });

  test('realistic mixed day', () => {
    const t = tallyGroupedRuns([
      row('completed', 'auto_assigned', 23),
      row('completed', 'approved', 4),
      row('completed', 'modified', 1),
      row('completed', 'noise_dismissed', 6),
      row('completed', 'pending_review', 5),
      row('completed', 'rejected', 2),
      row('running', null, 1),
      row('queued', null, 3),
    ]);
    expect(t.autoAssigned).toBe(23);
    expect(t.approved).toBe(5);
    expect(t.noiseDismissed).toBe(6);
    expect(t.manualReviewRequired).toBe(5);
    expect(t.inProgress).toBe(1);
    expect(t.queuedForLater).toBe(3);
    expect(t.totalRuns).toBe(45);
  });
});

describe('adjustForHandledInFs', () => {
  test('subtracts handledInFs from manualReviewRequired', () => {
    const t = { manualReviewRequired: 10 };
    adjustForHandledInFs(t, 7);
    expect(t.manualReviewRequired).toBe(3);
  });

  test('clamps to 0 if handledInFs would push it negative', () => {
    // Possible during a small race between the groupBy + count queries
    // (e.g. a new pending_review run lands in handledInFs but is still
    // working its way into the groupBy snapshot). Don't show negative
    // numbers in the UI.
    const t = { manualReviewRequired: 3 };
    adjustForHandledInFs(t, 7);
    expect(t.manualReviewRequired).toBe(0);
  });

  test('handles missing manualReviewRequired field defensively', () => {
    const t = {};
    adjustForHandledInFs(t, 5);
    expect(t.manualReviewRequired).toBe(0);
  });

  test('handles null/undefined handledInFs defensively', () => {
    const t = { manualReviewRequired: 5 };
    adjustForHandledInFs(t, null);
    expect(t.manualReviewRequired).toBe(5);
    adjustForHandledInFs(t, undefined);
    expect(t.manualReviewRequired).toBe(5);
  });

  test('returns the tally for chaining', () => {
    const t = { manualReviewRequired: 10 };
    const result = adjustForHandledInFs(t, 3);
    expect(result).toBe(t);
  });
});
