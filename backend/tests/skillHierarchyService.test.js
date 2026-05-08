import { normalizeSkillState, buildLegacyMappings } from '../src/services/skillHierarchyService.js';
import { transformTicket } from '../src/integrations/freshserviceTransformer.js';

describe('skill hierarchy migration helpers', () => {
  test('summit import removes placeholders and preserves valid skill/subskill structure', () => {
    const { state, warnings } = normalizeSkillState({
      categories: [
        { id: 'cat-1', name: 'Identity', description: 'Access work', subcategories: [{ id: 'sub-1', name: 'MFA' }] },
        { id: 'cat-2', name: 'New top category', subcategories: [{ id: 'sub-2', name: 'Ignore me' }] },
        { id: 'cat-3', name: 'Identity', subcategories: [] },
      ],
    });

    expect(state.skills).toHaveLength(1);
    expect(state.skills[0]).toMatchObject({ id: 'cat-1', name: 'Identity', description: 'Access work' });
    expect(state.skills[0].subskills).toEqual([{ id: 'sub-1', name: 'MFA', description: '', sortOrder: 0 }]);
    expect(warnings.map((warning) => warning.type)).toEqual(['placeholder_removed', 'duplicate_removed']);
  });

  test('legacy mappings mark exact and ambiguous rows before publish', () => {
    const mappings = buildLegacyMappings(
      [
        { id: 1, name: 'Identity', parentId: null },
        { id: 2, name: 'Mailbox access', parentId: null },
        { id: 3, name: 'Totally unrelated', parentId: null },
      ],
      {
        skills: [
          { id: 'skill-identity', name: 'Identity', subskills: [{ id: 'sub-mailbox', name: 'Mailbox permissions' }] },
        ],
      },
    );

    expect(mappings[0]).toMatchObject({ legacyCategoryId: 1, targetSkillTempId: 'skill-identity', confidence: 'exact', status: 'mapped' });
    expect(mappings[1]).toMatchObject({ legacyCategoryId: 2, targetSubskillTempId: 'sub-mailbox', confidence: 'weak', status: 'review' });
    expect(mappings[2]).toMatchObject({ legacyCategoryId: 3, confidence: 'unmapped', status: 'unmapped' });
  });

  test('Freshservice transformer reads legacy and Ticket Pulse custom fields', () => {
    const ticket = transformTicket({
      id: 123,
      subject: 'Need access',
      status: 2,
      priority: 2,
      created_at: '2026-05-01T12:00:00Z',
      updated_at: '2026-05-01T12:05:00Z',
      custom_fields: {
        security: 'Legacy security',
        tp_skill: 'Identity',
        tp_subskill: 'MFA',
      },
    });

    expect(ticket.ticketCategory).toBe('Legacy security');
    expect(ticket.tpSkill).toBe('Identity');
    expect(ticket.tpSubskill).toBe('MFA');
  });
});
