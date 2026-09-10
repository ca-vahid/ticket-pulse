import { describe, expect, test } from '@jest/globals';

/**
 * QA 09-09 #5 — merge notes written on the FreshService side never showed up in
 * Ticket Pulse.
 *
 * Kirsten merged in FreshService with the Ticket Pulse page already open, so
 * the on-open thread refresh never fired, and the background preheat could not
 * help either:
 *
 *   1. The cohort only admitted tickets whose created/assigned/resolved/closed
 *      moved today. Merging writes two notes onto the TARGET and touches none
 *      of those, so an older target never entered the cohort at all.
 *   2. Even inside the cohort, conversation freshness was judged against those
 *      same four fields. Once a thread was fully synced, a later note with no
 *      status change was never re-read.
 *
 * Both now key off FreshService's own updated_at, which it does bump when a
 * conversation is added, bounded by a per-ticket cursor so a ticket whose
 * updated_at moved for an unrelated reason is not re-fetched for ever.
 *
 * This is the decision table, extracted so it can be asserted directly.
 */

const startOfDay = new Date('2026-09-09T07:00:00Z');

/** Cohort admission (the `OR` in the preheat query). */
function inCohort(t) {
  return [t.createdAt, t.assignedAt, t.resolvedAt, t.closedAt, t.freshserviceUpdatedAt]
    .filter(Boolean)
    .some((d) => d >= startOfDay);
}

/** Conversation staleness (the `conversationsStale` test). */
function conversationsStale(t, latestConversations) {
  const fsChangeCandidates = [t.createdAt, t.assignedAt, t.resolvedAt, t.closedAt]
    .filter(Boolean).map((d) => d.getTime());
  const fsChange = fsChangeCandidates.length ? new Date(Math.max(...fsChangeCandidates)) : null;
  const fsUpdated = t.freshserviceUpdatedAt || null;
  const cursor = t.conversationsSyncFreshserviceUpdatedAt || null;
  return Boolean(
    !latestConversations
    || (fsUpdated && (!cursor || cursor < fsUpdated))
    || (fsChange && latestConversations < fsChange),
  );
}

describe('the reported case: merged into an OLDER ticket', () => {
  // The target was created last week; today it received only merge notes.
  const target = {
    createdAt: new Date('2026-09-02T18:00:00Z'),
    assignedAt: null,
    resolvedAt: null,
    closedAt: null,
    freshserviceUpdatedAt: new Date('2026-09-09T21:44:51Z'),
    conversationsSyncFreshserviceUpdatedAt: new Date('2026-09-02T18:05:00Z'),
  };

  test('it now enters the cohort at all', () => {
    expect(inCohort(target)).toBe(true);
    // Without the FS updated_at clause it never would have:
    const withoutFsUpdated = { ...target, freshserviceUpdatedAt: null };
    expect(inCohort(withoutFsUpdated)).toBe(false);
  });

  test('its conversations are judged stale, so the notes get read', () => {
    const latest = new Date('2026-09-02T18:05:00Z'); // fully synced last week
    expect(conversationsStale(target, latest)).toBe(true);
  });
});

describe('the second bug: a fully-synced thread never re-read', () => {
  test('a later FS note with no status change is now picked up', () => {
    const t = {
      createdAt: new Date('2026-09-09T14:00:00Z'),
      assignedAt: null,
      resolvedAt: new Date('2026-09-09T14:38:00Z'),
      closedAt: null,
      freshserviceUpdatedAt: new Date('2026-09-09T23:00:00Z'), // the new note
      conversationsSyncFreshserviceUpdatedAt: new Date('2026-09-09T22:00:00Z'),
    };
    // Thread was fully synced at 22:00 — later than every status timestamp, so
    // the OLD test (latestConversations < fsChange) was false and the note was lost.
    const latest = new Date('2026-09-09T22:00:00Z');
    expect(latest > t.resolvedAt).toBe(true); // the old test would say "fresh"
    expect(conversationsStale(t, latest)).toBe(true); // the new one says "read it"
  });
});

describe('the cursor keeps it bounded', () => {
  const base = {
    createdAt: new Date('2026-09-09T14:00:00Z'),
    assignedAt: null,
    resolvedAt: null,
    closedAt: null,
  };

  test('once the cursor has caught up, the ticket stops re-fetching', () => {
    const t = {
      ...base,
      freshserviceUpdatedAt: new Date('2026-09-09T21:44:51Z'),
      conversationsSyncFreshserviceUpdatedAt: new Date('2026-09-09T21:44:51Z'),
    };
    const latest = new Date('2026-09-09T21:44:00Z');
    expect(conversationsStale(t, latest)).toBe(false);
  });

  test('a ticket never checked before is always read once', () => {
    const t = { ...base, freshserviceUpdatedAt: new Date('2026-09-09T21:44:51Z'), conversationsSyncFreshserviceUpdatedAt: null };
    expect(conversationsStale(t, new Date('2026-09-09T21:00:00Z'))).toBe(true);
  });

  test('no conversations cached yet is always stale', () => {
    const t = { ...base, freshserviceUpdatedAt: null, conversationsSyncFreshserviceUpdatedAt: null };
    expect(conversationsStale(t, null)).toBe(true);
  });

  test('a ticket with no FS updated_at behaves exactly as before', () => {
    const t = {
      ...base,
      resolvedAt: new Date('2026-09-09T14:38:00Z'),
      freshserviceUpdatedAt: null,
      conversationsSyncFreshserviceUpdatedAt: null,
    };
    expect(conversationsStale(t, new Date('2026-09-09T14:26:00Z'))).toBe(true);  // older than resolvedAt
    expect(conversationsStale(t, new Date('2026-09-09T15:00:00Z'))).toBe(false); // newer
  });
});
