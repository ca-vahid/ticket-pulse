import { inferParentCompetenciesForSkillHierarchy } from '../src/services/competencyRepository.js';

describe('competencyRepository parent inference', () => {
  const categories = [
    { id: 10, parentId: null },
    { id: 11, parentId: 10 },
    { id: 12, parentId: 10 },
    { id: 13, parentId: 10 },
  ];

  test('adds basic parent when any subcategory exists and parent is missing', () => {
    const result = inferParentCompetenciesForSkillHierarchy([
      { competencyCategoryId: 11, proficiencyLevel: 'advanced' },
    ], categories);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ competencyCategoryId: 10, proficiencyLevel: 'basic' }),
    ]));
  });

  test('adds comfortable parent when two subcategories are comfortable or higher', () => {
    const result = inferParentCompetenciesForSkillHierarchy([
      { competencyCategoryId: 11, proficiencyLevel: 'intermediate' },
      { competencyCategoryId: 12, proficiencyLevel: 'advanced' },
    ], categories);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ competencyCategoryId: 10, proficiencyLevel: 'intermediate' }),
    ]));
  });

  test('adds advanced parent when two subcategories are advanced or higher', () => {
    const result = inferParentCompetenciesForSkillHierarchy([
      { competencyCategoryId: 11, proficiencyLevel: 'advanced' },
      { competencyCategoryId: 12, proficiencyLevel: 'expert' },
    ], categories);

    expect(result).toEqual(expect.arrayContaining([
      expect.objectContaining({ competencyCategoryId: 10, proficiencyLevel: 'advanced' }),
    ]));
  });

  test('keeps an existing parent mapping as facilitator override', () => {
    const result = inferParentCompetenciesForSkillHierarchy([
      { competencyCategoryId: 10, proficiencyLevel: 'basic' },
      { competencyCategoryId: 11, proficiencyLevel: 'advanced' },
      { competencyCategoryId: 12, proficiencyLevel: 'advanced' },
    ], categories);

    const parentMappings = result.filter((mapping) => mapping.competencyCategoryId === 10);
    expect(parentMappings).toHaveLength(1);
    expect(parentMappings[0].proficiencyLevel).toBe('basic');
  });
});
