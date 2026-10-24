// QA 10-23 #3: the Field Equipment category map showed every ticket as
// "Uncategorized". Its tickets carry Ticket Pulse categories, but the workspace
// was not canonical, so analytics read the empty FreshService category string.
// Analytics and dashboards now have their own set: every canonical workspace
// plus CATEGORY_ANALYTICS_WORKSPACE_IDS, without touching the competency rules.
import { isCanonicalCategoryWorkspace, isCategoryAnalyticsWorkspace } from '../src/utils/workspaceFeatureFlags.js';
import { getCategoryMode, normalizeTicketCategory } from '../src/utils/ticketCategoryNormalizer.js';

const ENV_KEYS = ['SKILL_HIERARCHY_WORKSPACE_IDS', 'CANONICAL_CATEGORY_WORKSPACE_IDS', 'FS_TAXONOMY_SYNC_WORKSPACE_IDS', 'CATEGORY_ANALYTICS_WORKSPACE_IDS'];
const saved = {};
beforeEach(() => {
  for (const key of ENV_KEYS) { saved[key] = process.env[key]; delete process.env[key]; }
  process.env.CANONICAL_CATEGORY_WORKSPACE_IDS = '1,2,4,5';
});
afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

const ticket = {
  ticketCategory: null,
  internalCategoryId: 30,
  internalCategory: { id: 30, name: 'HASP' },
  internalSubcategoryId: null,
  internalSubcategory: null,
};

test('every canonical workspace reads the tree in analytics', () => {
  expect(isCategoryAnalyticsWorkspace(4)).toBe(true);
  expect(getCategoryMode(4)).toBe('canonical');
});

test('an analytics-only workspace reads the tree in analytics but keeps its competency rules', () => {
  expect(getCategoryMode(3)).toBe('legacy');
  expect(normalizeTicketCategory(ticket, 3).categoryLabel).toBeNull();

  process.env.CATEGORY_ANALYTICS_WORKSPACE_IDS = '3';
  expect(getCategoryMode(3)).toBe('canonical');
  expect(isCanonicalCategoryWorkspace(3)).toBe(false);
  expect(normalizeTicketCategory(ticket, 3)).toMatchObject({ categoryLabel: 'HASP', categorySource: 'canonical', categoryId: 30 });
});

test('junk in the list is ignored', () => {
  process.env.CATEGORY_ANALYTICS_WORKSPACE_IDS = ' 3, x, , -2 ';
  expect(isCategoryAnalyticsWorkspace(3)).toBe(true);
  expect(isCategoryAnalyticsWorkspace(-2)).toBe(false);
  expect(isCategoryAnalyticsWorkspace(6)).toBe(false);
});
