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
