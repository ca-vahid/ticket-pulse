import { describe, expect, test } from 'vitest';
import { CANONICAL_STATUS_NAMES, fsBornStatusNames } from './statusDefs';

describe('fsBornStatusNames', () => {
  test('canonical 4 plus FreshService-linked customs, in display order', () => {
    const defs = [
      { name: 'Open' }, { name: 'Pending' }, { name: 'Pending Response', freshserviceStatusId: 6 },
      { name: 'Waiting on vendor', freshserviceStatusId: null }, { name: 'Resolved' }, { name: 'Closed' },
    ];
    expect(fsBornStatusNames(defs)).toEqual(['Open', 'Pending', 'Pending Response', 'Resolved', 'Closed']);
  });

  test('defs not loaded → the canonical 4', () => {
    expect(fsBornStatusNames(null)).toEqual(CANONICAL_STATUS_NAMES);
    expect(fsBornStatusNames([])).toEqual(CANONICAL_STATUS_NAMES);
  });

  test('a canonical status missing from the registry is still offered', () => {
    expect(fsBornStatusNames([{ name: 'Open' }, { name: 'Closed' }])).toEqual(['Open', 'Closed', 'Pending', 'Resolved']);
  });
});
