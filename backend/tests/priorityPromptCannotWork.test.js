import { jest } from '@jest/globals';

/**
 * QA 11-23 item 3 (Live): one person who cannot work at all is High. E.g. run
 * 1001 noted the requester could not sign in at all and still chose Medium
 * because nothing else looked urgent. These tests pin the
 * prompt text and the auto-upgrade that carries it to every workspace prompt.
 */

const promptVersionMock = {
  findFirst: jest.fn(),
  findUnique: jest.fn(),
  create: jest.fn(),
  update: jest.fn(),
  updateMany: jest.fn(),
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: { assignmentPromptVersion: promptVersionMock, $transaction: jest.fn(async (ops) => Promise.all(ops)) },
}));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { debug: jest.fn(), error: jest.fn(), info: jest.fn(), warn: jest.fn() },
}));

const {
  default: promptRepository,
  DEFAULT_SYSTEM_PROMPT,
  PRIORITY_CANNOT_WORK_RULE,
  needsPromptUpgrade,
  needsPriorityRulesUpgrade,
  upgradeLegacyPrompt,
  patchPriorityRules,
  isCustomizedPrompt,
} = await import('../src/services/promptRepository.js');

const RULE_TEXT = "One person who can't work at all (can't sign in to Teams, Outlook or their PC, or is locked out) is High, even with no outage. Medium is for work that's slowed but still possible. Use the Urgent tests only to decide Urgent; their absence never rules out High.";

// The priority section exactly as it shipped before QA 11-23.
const OLD_SECTION = `## Priority Definitions (PRIORITY_OUTPUT_V1)
Ticket Pulse is the source of truth for priority assessment. Assess priority from the ticket's business impact, time sensitivity, affected scope, requester context, and evidence quality. FreshService's imported priority is historical input only; do not copy it blindly.

Use exactly one normalized value:
- \`Low\`: routine request, no meaningful time pressure, single-user inconvenience, or informational work that is still actionable.
- \`Medium\`: normal operational support, limited user impact, standard access/software/help request, or unclear urgency with no outage or deadline signals.
- \`High\`: significant user/team impact, blocked work, time-sensitive operational deadline, escalated requester context, or credible security/production-risk language that needs priority handling.
- \`Urgent\`: active outage, broad business disruption, safety/security incident, executive-critical interruption, or immediate deadline where delay materially increases risk.

Always populate \`assessedPriority\`, \`priorityRationale\`, and \`priorityConfidence\` when calling \`submit_recommendation\`. Add concise \`prioritySignals\` when useful. If evidence is thin, choose the best supported value and set confidence to \`low\` or \`medium\`; do not inflate priority just because the requester used vague urgency language.`;

function sectionOf(prompt) {
  const start = prompt.indexOf('## Priority Definitions (PRIORITY_OUTPUT_V1)');
  const end = prompt.indexOf('\n## Step 2:');
  return prompt.slice(start, end);
}

function staleDefault() {
  const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Priority Definitions (PRIORITY_OUTPUT_V1)');
  const end = DEFAULT_SYSTEM_PROMPT.indexOf('\n## Step 2:');
  return `${DEFAULT_SYSTEM_PROMPT.slice(0, start)}${OLD_SECTION}\n${DEFAULT_SYSTEM_PROMPT.slice(end)}`;
}

describe('the default prompt carries the cannot-work rule', () => {
  test('rule text, word for word, inside the priority section', () => {
    expect(PRIORITY_CANNOT_WORK_RULE).toBe(`Rule (PRIORITY_CANNOT_WORK_V1): ${RULE_TEXT}`);
    expect(sectionOf(DEFAULT_SYSTEM_PROMPT)).toContain(PRIORITY_CANNOT_WORK_RULE);
  });

  test('the "do not inflate" caution is kept for vague words only', () => {
    const section = sectionOf(DEFAULT_SYSTEM_PROMPT);
    expect(section).toContain('do not inflate priority just because the requester used vague urgency language ("ASAP", "urgent" with nothing behind it).');
    expect(section).toContain('That caution is about vague words only: a requester who says they cannot work at all is stating impact, so judge it by the cannot-work rule, not as vague urgency.');
  });

  test('Medium and High bullets agree with the rule', () => {
    const section = sectionOf(DEFAULT_SYSTEM_PROMPT);
    expect(section).toContain('- `Medium`: normal operational support, limited user impact, work that is slowed but still possible,');
    expect(section).toContain('- `High`: significant user/team impact, blocked work (including one person who cannot work at all),');
  });

  test('the current default needs no upgrade and is not "customized"', () => {
    expect(needsPromptUpgrade(DEFAULT_SYSTEM_PROMPT)).toBe(false);
    expect(isCustomizedPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });
});

describe('auto-upgrade brings the rule to existing prompts (Live)', () => {
  test('an unedited old default becomes the current default exactly', () => {
    const stale = staleDefault();
    expect(isCustomizedPrompt(stale)).toBe(false);
    expect(needsPriorityRulesUpgrade(stale)).toBe(true);
    expect(needsPromptUpgrade(stale)).toBe(true);
    expect(upgradeLegacyPrompt(stale)).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('an edited priority section keeps every admin line, gains the rule, softens the old sentence', () => {
    const edited = staleDefault().replace(
      '- `Urgent`: active outage',
      '- Tickets from the Kelowna site office are always at least High.\n- `Urgent`: active outage',
    );
    expect(isCustomizedPrompt(edited)).toBe(true);
    const upgraded = upgradeLegacyPrompt(edited);
    expect(upgraded).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(upgraded).toContain('- Tickets from the Kelowna site office are always at least High.');
    expect(upgraded).toContain(PRIORITY_CANNOT_WORK_RULE);
    expect(upgraded).not.toContain('do not inflate priority just because the requester used vague urgency language.');
    expect(upgraded).toContain('That caution is about vague words only');
    // The rule lands inside the priority section, before Step 2.
    expect(upgraded.indexOf(PRIORITY_CANNOT_WORK_RULE)).toBeLessThan(upgraded.indexOf('## Step 2:'));
    expect(needsPromptUpgrade(upgraded)).toBe(false);
  });

  test('a custom prompt that names the marker without the section gets the rule at the end', () => {
    const custom = 'You are the Accounting assignment assistant. AFTER_HOURS_PRIORITY_QUEUE_V2 PRIORITY_OUTPUT_V1\n\n## Step 1: Read the Ticket\nKeep this.';
    const upgraded = upgradeLegacyPrompt(custom);
    expect(upgraded.startsWith(custom)).toBe(true);
    expect(upgraded.endsWith(PRIORITY_CANNOT_WORK_RULE)).toBe(true);
  });

  test('idempotent', () => {
    const once = patchPriorityRules(staleDefault());
    expect(patchPriorityRules(once)).toBe(once);
    expect(upgradeLegacyPrompt(once)).toBe(once);
  });

  test('the new version note says what changed', async () => {
    const stale = staleDefault();
    promptVersionMock.findFirst
      .mockResolvedValueOnce({ id: 30, workspaceId: 4, version: 12, status: 'published', systemPrompt: stale, toolConfig: null })
      .mockResolvedValueOnce({ version: 12 });
    promptVersionMock.create.mockImplementation(({ data }) => Promise.resolve({ id: 31, workspaceId: 4, version: 13, ...data }));
    promptVersionMock.update.mockResolvedValue({});
    promptVersionMock.updateMany.mockResolvedValue({ count: 1 });
    promptVersionMock.findUnique.mockImplementation(() => Promise.resolve({ id: 31, workspaceId: 4, version: 13, status: 'published', systemPrompt: DEFAULT_SYSTEM_PROMPT }));

    await promptRepository.getPublished(4);

    const { data } = promptVersionMock.create.mock.calls[0][0];
    expect(data.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(data.notes).toBe("auto-upgrade: Added the rule: one person who can't work at all is High. (from v12, system-applied, previous version preserved)");
    expect(data.createdBy).toBe('system');
  });

  test('a prompt with no priority scaffolding gets the whole current section', () => {
    const noPriority = DEFAULT_SYSTEM_PROMPT.replace(/\n## Priority Definitions \(PRIORITY_OUTPUT_V1\)[\s\S]*?(?=\n## Step 2: Classify the Ticket)/, '');
    expect(noPriority).not.toContain('PRIORITY_OUTPUT_V1');
    const upgraded = upgradeLegacyPrompt(noPriority);
    expect(upgraded).toContain(PRIORITY_CANNOT_WORK_RULE);
  });
});
