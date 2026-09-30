import { jest } from '@jest/globals';

// Knowledge v3 (30 Sep 2026): every switched-on playbook is a candidate; the
// ticket's category only ranks them. Word lists a playbook switched on stay
// hard rules.
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { routeCandidates } = await import('../src/services/autoHelpPlaybookService.js');

const pb = (over) => ({
  id: 1, workspaceId: 1, name: 'P', enabled: true, mode: 'shadow', categoryId: 10, subcategoryIds: [], priority: 100,
  match: { useWords: false, keywords: [], excludeKeywords: [], whenToHelp: '' }, allowedTools: [], ...over,
});
const ticket = { subject: 'Password reset please', descriptionText: 'I forgot my password', internalCategoryId: 10, internalSubcategoryId: 101 };

describe('routeCandidates', () => {
  test('own subcategory first, then same category, then everything else; priority inside a scope', () => {
    const list = routeCandidates(ticket, [
      pb({ id: 1, name: 'Other area', categoryId: 40, priority: 900 }),
      pb({ id: 2, name: 'Same category, other sub', subcategoryIds: [102] }),
      pb({ id: 3, name: 'Exact, low priority', subcategoryIds: [101], priority: 50 }),
      pb({ id: 4, name: 'Exact, high priority', subcategoryIds: [101], priority: 200 }),
      pb({ id: 5, name: 'Off', enabled: false }),
    ]);
    expect(list.map((c) => [c.playbook.id, c.scope])).toEqual([[4, 'exact'], [3, 'exact'], [2, 'category'], [1, 'other']]);
  });

  test('an uncategorised ticket still gets every switched-on playbook as a candidate', () => {
    const list = routeCandidates({ ...ticket, internalCategoryId: null, internalSubcategoryId: null }, [pb({ id: 1 }), pb({ id: 2, categoryId: 40 })]);
    expect(list.map((c) => c.scope)).toEqual(['other', 'other']);
  });

  test('switched-on word lists are hard rules: a missing required word or an excluded word removes the playbook', () => {
    const list = routeCandidates(ticket, [
      pb({ id: 1, match: { useWords: true, keywords: ['printer'], excludeKeywords: [] } }),
      pb({ id: 2, match: { useWords: true, keywords: [], excludeKeywords: ['password'] } }),
      pb({ id: 3, match: { useWords: true, keywords: ['password'], excludeKeywords: [] } }),
    ]);
    expect(list.map((c) => c.playbook.id)).toEqual([3]);
  });
});
