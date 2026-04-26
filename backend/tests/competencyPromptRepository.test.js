import { DEFAULT_COMPETENCY_PROMPT } from '../src/services/competencyPromptRepository.js';

describe('competency prompt default', () => {
  test('contains required tool references', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_profile');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_existing_competency_categories');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_ticket_history');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('get_technician_category_distribution');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('submit_competency_assessment');
  });

  test('contains proficiency level guidelines', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('basic');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('intermediate');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('expert');
  });

  test('instructs to reuse existing taxonomy entries', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('Reuse existing category/subcategory IDs whenever they fit');
    expect(DEFAULT_COMPETENCY_PROMPT).toContain('parent categories and subcategories');
  });

  test('does not reference removed tools', () => {
    expect(DEFAULT_COMPETENCY_PROMPT).not.toContain('check_business_hours');
    expect(DEFAULT_COMPETENCY_PROMPT).not.toContain('deferUntil');
  });
});
