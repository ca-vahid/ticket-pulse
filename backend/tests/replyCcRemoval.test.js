import { describe, expect, test } from '@jest/globals';
import { unionReplyCc } from '../src/services/ticketService.js';

/**
 * QA 09-09 #6 — Marcus removed mblackstock@ from a reply's Cc and the mail was
 * sent to him anyway, because the same address is on the ticket's "Also for"
 * list and unionReplyCc put it straight back.
 *
 * The union is a deliberate safety net (an address added to the ticket after
 * the draft was opened must still be reached), so the fix is not to drop it —
 * it is to let the composer name what the agent deliberately removed.
 */

const ticket = (ccEmails, requesterEmail = 'requester@bgcengineering.ca') => ({
  ccEmails,
  requester: { email: requesterEmail },
});

describe('unionReplyCc — the reported bug', () => {
  test('an address the agent removed is NOT mailed, even though it is an additional requester', () => {
    const t = ticket(['mblackstock@bgcengineering.ca']);
    // What the composer sends after Marcus clicks the × on the chip.
    expect(unionReplyCc(t, [], ['mblackstock@bgcengineering.ca'])).toEqual([]);
  });

  test('without the removal list the old behaviour is unchanged (the bug reproduces)', () => {
    const t = ticket(['mblackstock@bgcengineering.ca']);
    expect(unionReplyCc(t, [])).toEqual(['mblackstock@bgcengineering.ca']);
  });
});

describe('unionReplyCc — the safety net still works', () => {
  test('an additional requester added AFTER the draft opened is still reached', () => {
    const t = ticket(['late@bgcengineering.ca']);
    // The agent removed someone else entirely; the late arrival is untouched.
    expect(unionReplyCc(t, [], ['someone.else@bgcengineering.ca']))
      .toEqual(['late@bgcengineering.ca']);
  });

  test('API v1 replies, which never seed and never send removals, behave as before', () => {
    const t = ticket(['a@x.com', 'b@x.com']);
    expect(unionReplyCc(t, ['c@x.com'])).toEqual(['a@x.com', 'b@x.com', 'c@x.com']);
  });

  test('removing one additional requester does not remove the others', () => {
    const t = ticket(['a@x.com', 'b@x.com', 'c@x.com']);
    expect(unionReplyCc(t, [], ['b@x.com'])).toEqual(['a@x.com', 'c@x.com']);
  });
});

describe('unionReplyCc — details that must not regress', () => {
  test('the requester is never Cc\'d (they are the To)', () => {
    const t = ticket(['requester@bgcengineering.ca', 'other@x.com']);
    expect(unionReplyCc(t, [])).toEqual(['other@x.com']);
  });

  test('removal is case-insensitive — the chip shows what FS stored', () => {
    const t = ticket(['MBlackstock@bgcengineering.ca']);
    expect(unionReplyCc(t, [], ['mblackstock@BGCENGINEERING.ca'])).toEqual([]);
  });

  test('a removal also beats an address typed into the composer', () => {
    // Defensive: the composer should never send both, but if it does the
    // explicit removal is the newer, more deliberate signal.
    const t = ticket([]);
    expect(unionReplyCc(t, ['x@y.com'], ['x@y.com'])).toEqual([]);
  });

  test('empty / malformed removal lists are ignored, not fatal', () => {
    const t = ticket(['a@x.com']);
    expect(unionReplyCc(t, [], [])).toEqual(['a@x.com']);
    expect(unionReplyCc(t, [], null)).toEqual(['a@x.com']);
    expect(unionReplyCc(t, [], ['', '   '])).toEqual(['a@x.com']);
  });
});
