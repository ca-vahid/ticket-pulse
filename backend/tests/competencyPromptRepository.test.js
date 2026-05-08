import {
  DEFAULT_COMPETENCY_PROMPT,
  DEFAULT_LEGACY_COMPETENCY_PROMPT,
} from '../src/services/competencyPromptRepository.js';

describe('competency prompt default', () => {
  test('contains required tool references', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_profile');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_existing_competency_categories');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_canonical_category_evidence');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_ticket_history');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_category_distribution');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('submit_competency_assessment');
  });

  test('contains proficiency level guidelines', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('basic');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('intermediate');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('expert');
  });

  test('instructs model to review assignment-agent category suggestions', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('taxonomySuggestionBreakdown');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('suggestedInternalCategoryName');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('suggestedInternalSubcategoryName');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('categoryAction "create_new"');
  });

  test('instructs to reuse existing taxonomy entries', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('Reuse existing category/subcategory IDs whenever they fit');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('parent categories and subcategories');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('categoryId is required');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('Legacy Freshservice fields are supporting evidence only');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('legacyFreshserviceCategoryBreakdown');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('clean canonical Ticket Pulse ticket evidence');
  });

  test('does not reference removed tools', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).not.toContain('check_business_hours');
    expect(DEFAULT_COMPETENCY_PROMPT).not.toContain('deferUntil');
  });

  test('keeps a legacy prompt for workspaces not migrated to Ticket Pulse categories yet', () => {
    expect(DEFAULT_LEGACY_COMPETENCY_PROMPT).toContain('legacy category mode');
    expect(DEFAULT_LEGACY_COMPETENCY_PROMPT).toContain('categoryBreakdown');
    expect(DEFAULT_LEGACY_COMPETENCY_PROMPT).toContain('do not require it');
  });
});
