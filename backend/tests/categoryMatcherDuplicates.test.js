import { findDuplicateGroups } from '../src/utils/categoryMatcher.js';

/**
 * Per-parent name uniqueness: the duplicates report must never pair rows that
 * live under different parents — same-named subs under different parents are
 * legitimate siblings, not duplicates — and labels must carry the parent so
 * admins can tell "Project Setup > Quebec" from "Accounting > Quebec".
 */
describe('findDuplicateGroups with parent scoping', () => {
  test('never pairs same-named rows under different parents', () => {
    const groups = findDuplicateGroups([
      { id: 1, name: 'Quebec', parentId: 10, parentName: 'Project Setup' },
      { id: 2, name: 'Quebec', parentId: 20, parentName: 'Accounting' },
    ]);
    expect(groups).toEqual([]);
  });

  test('pairs near-duplicates within the same parent and labels them', () => {
    const groups = findDuplicateGroups([
      { id: 1, name: 'Quebec', parentId: 10, parentName: 'Project Setup' },
      { id: 2, name: 'Quebec', parentId: 20, parentName: 'Accounting' },
      { id: 3, name: 'Quebec Setup', parentId: 10, parentName: 'Project Setup' },
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      keepId: 1,
      keepName: 'Quebec',
      keepLabel: 'Project Setup > Quebec',
      keepParentId: 10,
      keepParentName: 'Project Setup',
    });
    expect(groups[0].duplicates).toHaveLength(1);
    expect(groups[0].duplicates[0]).toMatchObject({
      id: 3,
      label: 'Project Setup > Quebec Setup',
      parentId: 10,
      parentName: 'Project Setup',
    });
  });

  test('top-level rows (no parentId) still group together with bare labels', () => {
    const groups = findDuplicateGroups([
      { id: 1, name: 'Printers', parentId: null, parentName: null },
      { id: 2, name: 'Printing', parentId: null, parentName: null },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].keepLabel).toBe('Printers');
    expect(groups[0].duplicates[0].label).toBe('Printing');
  });

  test('rows without parent fields behave as top-level (legacy call shape)', () => {
    const groups = findDuplicateGroups([
      { id: 1, name: 'Printers' },
      { id: 2, name: 'Printing' },
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0].duplicates[0].id).toBe(2);
  });
});
