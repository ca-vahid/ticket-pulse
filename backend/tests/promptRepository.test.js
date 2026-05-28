import {
  DEFAULT_SYSTEM_PROMPT,
  needsPromptUpgrade,
  upgradeLegacyPrompt,
} from '../src/services/promptRepository.js';

describe('prompt upgrade helpers', () => {
  test('detects legacy prompt markers', () => {
    const legacy = `## Step 1: Check Business Hours\nCall **check_business_hours** first.\nUse deferUntil if needed.`;
    expect(needsPromptUpgrade(legacy)).toBe(true);
  });

  test('does not flag current default prompt as legacy', () => {
    expect(needsPromptUpgrade(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });

  test('default prompt includes risk and routing-boundary tool guidance', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('get_requester_site_context');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('get_assignment_risk_signals');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('get_routing_boundary_context');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('same-subcategory rejection');
  });

  test('detects and upgrades prompts with stale after-hours queue guidance', () => {
    const stale = DEFAULT_SYSTEM_PROMPT.replace(
      /Note \(AFTER_HOURS_PRIORITY_QUEUE_V2\):[\s\S]*?\n\n## Step 1:/,
      'Note: The pipeline only runs during business hours. After-hours tickets are automatically queued and processed when business hours resume. You do not need to check business hours.\n\n## Step 1:',
    );

    const upgraded = upgradeLegacyPrompt(stale);

    expect(needsPromptUpgrade(stale)).toBe(true);
    expect(upgraded).toContain('AFTER_HOURS_PRIORITY_QUEUE_V2');
    expect(upgraded).toContain('priority-assessment-only pass immediately');
    expect(upgraded).toContain('workspace noise-dismissal policy');
    expect(upgraded).toContain('queued business-hours run reassesses the ticket');
    expect(upgraded).not.toContain('After-hours tickets are automatically queued and processed when business hours resume');
  });

  test('detects prompts missing structured priority output marker', () => {
    const stale = DEFAULT_SYSTEM_PROMPT.replace(/\n## Priority Definitions \(PRIORITY_OUTPUT_V1\)[\s\S]*?(?=\n## Step 2: Classify the Ticket)/, '');
    expect(needsPromptUpgrade(stale)).toBe(true);
    expect(upgradeLegacyPrompt(stale)).toContain('PRIORITY_OUTPUT_V1');
  });

  test('detects prompts missing assignment risk signal tooling', () => {
    const stale = DEFAULT_SYSTEM_PROMPT
      .replace(/.*get_assignment_risk_signals.*\n/g, '')
      .replace(/.*same-subcategory rejection.*\n/g, '');

    expect(needsPromptUpgrade(stale)).toBe(true);
    expect(upgradeLegacyPrompt(stale)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('injects priority instructions into custom workspace prompts without replacing custom content', () => {
    const custom = `You are the Accounting assignment assistant.

## Step 1: Read the Ticket
Preserve this workspace-specific routing guidance.

## Step 2: Submit Recommendation
Call **submit_recommendation** with the chosen technician.`;

    const upgraded = upgradeLegacyPrompt(custom);

    expect(needsPromptUpgrade(custom)).toBe(true);
    expect(upgraded).toContain('You are the Accounting assignment assistant.');
    expect(upgraded).toContain('Preserve this workspace-specific routing guidance.');
    expect(upgraded).toContain('PRIORITY_OUTPUT_V1');
    expect(upgraded).toContain('Always populate `assessedPriority`, `priorityRationale`, and `priorityConfidence`');
  });

  test('upgrades old default-style prompts to the current default prompt', () => {
    const legacyDefault = `You are an IT helpdesk ticket assignment assistant.\n\n## Step 1: Check Business Hours\nCall **check_business_hours** first.\n\n## Step 2: Read the Ticket`;
    expect(upgradeLegacyPrompt(legacyDefault)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('upgrades prompts that predate fixed top-level category guidance', () => {
    const stale = DEFAULT_SYSTEM_PROMPT.replace(
      '- Do not propose new top-level categories. The top-level category list is fixed for this migration. When a gap exists, choose the closest existing top-level category and populate `suggestedInternalSubcategoryName` only. Leave `suggestedInternalCategoryName` null unless you are naming the existing parent category for context.',
      '- You may populate `suggestedInternalCategoryName` and/or `suggestedInternalSubcategoryName` as review notes only. These are not active categories and must not be used as if they already exist.',
    );

    expect(needsPromptUpgrade(stale)).toBe(true);
    expect(upgradeLegacyPrompt(stale)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('removes deprecated tool references from custom prompts', () => {
    const custom = `
## Step 1: Check Business Hours
Call **check_business_hours** first.
Set deferUntil when needed.

## Step 2: Read the Ticket
Read it.

## Step 3: Classify the Ticket
Classify it.
`;

    const upgraded = upgradeLegacyPrompt(custom);

    expect(upgraded).not.toContain('check_business_hours');
    expect(upgraded).not.toContain('deferUntil');
    expect(upgraded).toContain('Step 1: Read the Ticket');
    expect(upgraded).toContain('Step 2: Classify the Ticket');
  });
});
