import { isGroupExcluded } from '../src/services/assignmentDecisionRules.js';

describe('isGroupExcluded — empty / null cases', () => {
  test('returns false when ticketGroupId is null', () => {
    expect(isGroupExcluded(null, [1, 2, 3])).toBe(false);
  });

  test('returns false when ticketGroupId is undefined', () => {
    expect(isGroupExcluded(undefined, [1, 2, 3])).toBe(false);
  });

  test('returns false when ticketGroupId is 0 (treat as no group)', () => {
    expect(isGroupExcluded(0, [1, 2, 3])).toBe(false);
  });

  test('returns false when excludedGroupIds is null', () => {
    expect(isGroupExcluded(123, null)).toBe(false);
  });

  test('returns false when excludedGroupIds is undefined', () => {
    expect(isGroupExcluded(123, undefined)).toBe(false);
  });

  test('returns false when excludedGroupIds is empty array', () => {
    expect(isGroupExcluded(123, [])).toBe(false);
  });

  test('returns false when excludedGroupIds is not an array', () => {
    // Defensive: if some weird value gets in (e.g. JSON deserialization mishap)
    // we shouldn't crash or false-positive.
    expect(isGroupExcluded(123, 'not an array')).toBe(false);
    expect(isGroupExcluded(123, { 0: 123 })).toBe(false);
  });
});

describe('isGroupExcluded — match cases', () => {
  test('returns true when number ticket group is in number list', () => {
    expect(isGroupExcluded(123, [1, 123, 456])).toBe(true);
  });

  test('returns true when BigInt ticket group matches a number in the list', () => {
    // ticket.groupId comes off Prisma as BigInt; excluded list is INTEGER[].
    // The helper must coerce or this would silently miss every match.
    expect(isGroupExcluded(123n, [1, 123, 456])).toBe(true);
  });

  test('returns true when number ticket group matches a BigInt in the list', () => {
    // Defensive: also handle the inverse.
    expect(isGroupExcluded(123, [1n, 123n, 456n])).toBe(true);
  });

  test('returns false when ticket group is not in the list', () => {
    expect(isGroupExcluded(999, [1, 123, 456])).toBe(false);
  });
});

describe('isGroupExcluded — invalid input handling', () => {
  test('returns false when ticketGroupId is non-numeric', () => {
    expect(isGroupExcluded('not a number', [1, 2, 3])).toBe(false);
    expect(isGroupExcluded(NaN, [1, 2, 3])).toBe(false);
    expect(isGroupExcluded(Infinity, [1, 2, 3])).toBe(false);
  });

  test('handles a single-element exclusion list', () => {
    expect(isGroupExcluded(42, [42])).toBe(true);
    expect(isGroupExcluded(43, [42])).toBe(false);
  });
});
