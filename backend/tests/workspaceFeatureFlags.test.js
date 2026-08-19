// Phase PA flag split: SKILL_HIERARCHY_WORKSPACE_IDS →
// CANONICAL_CATEGORY_WORKSPACE_IDS + FS_TAXONOMY_SYNC_WORKSPACE_IDS.
// Contract under test:
//  - both new sets fall back to the legacy env var when unset (zero behavior
//    change at deploy), and to '1' when nothing is set at all;
//  - each new var independently overrides only its own set;
//  - isSkillHierarchyWorkspace stays as a deprecated alias of the FS set;
//  - resolution is lazy — env flips take effect without a module reload.
import {
  isCanonicalCategoryWorkspace,
  isFsTaxonomySyncWorkspace,
  isSkillHierarchyWorkspace,
} from '../src/utils/workspaceFeatureFlags.js';

const ENV_KEYS = [
  'SKILL_HIERARCHY_WORKSPACE_IDS',
  'CANONICAL_CATEGORY_WORKSPACE_IDS',
  'FS_TAXONOMY_SYNC_WORKSPACE_IDS',
];

describe('workspaceFeatureFlags (Phase PA split)', () => {
  const saved = {};

  beforeEach(() => {
    for (const key of ENV_KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  test('nothing set: both sets default to workspace 1 only', () => {
    expect(isCanonicalCategoryWorkspace(1)).toBe(true);
    expect(isFsTaxonomySyncWorkspace(1)).toBe(true);
    expect(isCanonicalCategoryWorkspace(2)).toBe(false);
    expect(isFsTaxonomySyncWorkspace(2)).toBe(false);
  });

  test('legacy var alone drives BOTH sets (prod deploy with no env change)', () => {
    process.env.SKILL_HIERARCHY_WORKSPACE_IDS = '1,2';
    for (const ws of [1, 2]) {
      expect(isCanonicalCategoryWorkspace(ws)).toBe(true);
      expect(isFsTaxonomySyncWorkspace(ws)).toBe(true);
      expect(isSkillHierarchyWorkspace(ws)).toBe(true);
    }
    expect(isCanonicalCategoryWorkspace(5)).toBe(false);
    expect(isFsTaxonomySyncWorkspace(5)).toBe(false);
    expect(isSkillHierarchyWorkspace(5)).toBe(false);
  });

  test('the Phase PA target state: ws5 canonical but NOT FS-synced', () => {
    process.env.SKILL_HIERARCHY_WORKSPACE_IDS = '1,2';
    process.env.CANONICAL_CATEGORY_WORKSPACE_IDS = '1,2,5';
    // FS_TAXONOMY_SYNC_WORKSPACE_IDS unset → falls back to legacy '1,2'
    expect(isCanonicalCategoryWorkspace(5)).toBe(true);
    expect(isFsTaxonomySyncWorkspace(5)).toBe(false);
    expect(isCanonicalCategoryWorkspace(2)).toBe(true);
    expect(isFsTaxonomySyncWorkspace(2)).toBe(true);
    // deprecated alias keeps the stricter (FS) semantics
    expect(isSkillHierarchyWorkspace(5)).toBe(false);
    expect(isSkillHierarchyWorkspace(2)).toBe(true);
  });

  test('each new var overrides independently', () => {
    process.env.SKILL_HIERARCHY_WORKSPACE_IDS = '1,2';
    process.env.FS_TAXONOMY_SYNC_WORKSPACE_IDS = '1';
    expect(isFsTaxonomySyncWorkspace(2)).toBe(false); // narrowed
    expect(isCanonicalCategoryWorkspace(2)).toBe(true); // still legacy fallback
  });

  test('empty-string new var means an EMPTY set, not the fallback', () => {
    process.env.SKILL_HIERARCHY_WORKSPACE_IDS = '1,2';
    process.env.FS_TAXONOMY_SYNC_WORKSPACE_IDS = '';
    expect(isFsTaxonomySyncWorkspace(1)).toBe(false);
    expect(isFsTaxonomySyncWorkspace(2)).toBe(false);
    expect(isCanonicalCategoryWorkspace(1)).toBe(true);
  });

  test('tolerates whitespace, string ids, and garbage entries', () => {
    process.env.CANONICAL_CATEGORY_WORKSPACE_IDS = ' 1 , 5 , potato , 2.5 ';
    expect(isCanonicalCategoryWorkspace('5')).toBe(true);
    expect(isCanonicalCategoryWorkspace(1)).toBe(true);
    expect(isCanonicalCategoryWorkspace(2)).toBe(false);
    expect(isCanonicalCategoryWorkspace(NaN)).toBe(false);
  });

  test('lazy resolution: env flips apply without a module reload', () => {
    process.env.CANONICAL_CATEGORY_WORKSPACE_IDS = '1';
    expect(isCanonicalCategoryWorkspace(5)).toBe(false);
    process.env.CANONICAL_CATEGORY_WORKSPACE_IDS = '1,5';
    expect(isCanonicalCategoryWorkspace(5)).toBe(true);
  });
});
