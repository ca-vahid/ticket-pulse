import { describe, expect, test } from 'vitest';
import { groupMoveFor } from './assigneeGroupMove';

const GROUPS = [
  { id: 1, freshserviceId: '1000205455', name: 'Everyone IT', origin: 'freshservice' },
  { id: 2, freshserviceId: '1000206163', name: 'Coreshack', origin: 'freshservice' },
  { id: 3, freshserviceId: null, name: 'Local', origin: 'local' },
];
const REID = { id: 40, name: 'Reid Laird', assignableOnly: true, homeGroup: { id: '1000206163', name: 'Coreshack', memberOf: ['1000206163'] } };

describe('groupMoveFor (2 Oct 2026)', () => {
  test('Other teams person on an Everyone IT ticket → Group: Everyone IT → Coreshack', () => {
    expect(groupMoveFor(REID, '1000205455', GROUPS)).toEqual({ field: 'Group', from: 'Everyone IT', to: 'Coreshack' });
  });
  test('already in one of their groups → nothing', () => {
    expect(groupMoveFor(REID, '1000206163', GROUPS)).toBeNull();
  });
  test('no group on the ticket → nothing', () => {
    expect(groupMoveFor(REID, null, GROUPS)).toBeNull();
  });
  test('IT team members and people without a known group → nothing', () => {
    expect(groupMoveFor({ id: 7, name: 'Terry' }, '1000205455', GROUPS)).toBeNull();
    expect(groupMoveFor({ ...REID, homeGroup: undefined }, '1000205455', GROUPS)).toBeNull();
  });
  test('unknown current group still previews the move', () => {
    expect(groupMoveFor(REID, '42', GROUPS)).toEqual({ field: 'Group', from: 'Current group', to: 'Coreshack' });
  });
});
