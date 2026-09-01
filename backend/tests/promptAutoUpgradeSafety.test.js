import { jest } from '@jest/globals';

/**
 * NT-6 + NT-9 — prompt auto-upgrade safety.
 *
 * The auto-upgrader used to return DEFAULT_SYSTEM_PROMPT wholesale, silently
 * destroying customized workspace prompts (fired 4x on ws1 historically).
 * New contract:
 *   - uncustomized default-lineage prompts still upgrade (wholesale is fine —
 *     nothing admin-authored can be lost);
 *   - customized prompts are NEVER wholesale-replaced: they get targeted
 *     section patches or no upgrade at all, and getPublished() skips version
 *     churn when the upgrader was a no-op;
 *   - every applied upgrade is a NEW version row labeled "auto-upgrade" (the
 *     admin's version is preserved and visible in prompt history).
 * NT-6 rides on this: the decision-notes step (adminDecisions vs
 * automatedOutcomes) is swapped only when the section is the verbatim legacy
 * scaffold.
 */

const prismaMock = {
  assignmentPromptVersion: {
    findMany: jest.fn(),
    findFirst: jest.fn(),
    findUnique: jest.fn(),
    create: jest.fn(),
    update: jest.fn(),
    updateMany: jest.fn(),
  },
  $transaction: jest.fn(async (ops) => Promise.all(ops)),
};

jest.unstable_mockModule('../src/services/prisma.js', () => ({
  default: prismaMock,
}));

jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: {
    debug: jest.fn(),
    error: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
  },
}));

const {
  default: promptRepository,
  DEFAULT_SYSTEM_PROMPT,
  needsPromptUpgrade,
  upgradeLegacyPrompt,
  isCustomizedPrompt,
} = await import('../src/services/promptRepository.js');

const LEGACY_DECISION_NOTES_SECTION = `## Step 5b: Check Decision History (optional but valuable)
Call **search_decision_notes** with keywords from the ticket (e.g., category name, key terms) to find past admin decisions on similar tickets. Look for:
- Has an admin left notes about how tickets like this should be routed?
- Were previous recommendations overridden? Why?
- Are there routing preferences or patterns the admin has established?

Admin decision notes carry high weight — if an admin has explicitly stated a routing preference, follow it unless circumstances have changed.`;

// The current default with its decision-notes section reverted to the legacy
// scaffold — i.e. what a workspace on the previous default looks like.
function staleDefaultWithLegacyDecisionNotes() {
  const start = DEFAULT_SYSTEM_PROMPT.indexOf('## Step 5b: Check Decision History');
  const end = DEFAULT_SYSTEM_PROMPT.indexOf('\n## Step 6:');
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  return `${DEFAULT_SYSTEM_PROMPT.slice(0, start)}${LEGACY_DECISION_NOTES_SECTION}\n${DEFAULT_SYSTEM_PROMPT.slice(end)}`;
}

describe('NT-6: decision-notes precedent split in prompt scaffolding', () => {
  test('default prompt instructs on both buckets', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('adminDecisions');
    expect(DEFAULT_SYSTEM_PROMPT).toContain('automatedOutcomes');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/binding precedent/);
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/NEVER dismiss a ticket as noise solely because/);
    expect(needsPromptUpgrade(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });

  test('flags a prompt whose decision-notes step is the verbatim legacy scaffold', () => {
    const stale = staleDefaultWithLegacyDecisionNotes();
    expect(stale).not.toContain('automatedOutcomes');
    expect(needsPromptUpgrade(stale)).toBe(true);
    const upgraded = upgradeLegacyPrompt(stale);
    expect(upgraded).toContain('automatedOutcomes');
    expect(upgraded).toContain('adminDecisions');
    expect(needsPromptUpgrade(upgraded)).toBe(false);
  });

  test('does NOT flag a prompt whose decision-notes step was edited by an admin', () => {
    const stale = staleDefaultWithLegacyDecisionNotes();
    const edited = stale.replace(
      'Admin decision notes carry high weight',
      'NEVER treat package or shipping-room tickets as noise. Admin decision notes carry high weight',
    );
    // The tool result labels its own buckets, so an edited step is safe to
    // leave alone — and leaving it alone is what protects the admin's text.
    expect(needsPromptUpgrade(edited)).toBe(false);
    expect(upgradeLegacyPrompt(edited)).toBe(edited);
  });

  test('swaps only the decision-notes section in a customized prompt with the verbatim legacy scaffold', () => {
    const custom = `You are the Accounting assignment assistant. AFTER_HOURS_PRIORITY_QUEUE_V2 PRIORITY_OUTPUT_V1

## Step 1: Read the Ticket
Preserve this workspace-specific routing guidance.

${LEGACY_DECISION_NOTES_SECTION}

## Step 7: Submit Recommendation
Call **submit_recommendation** using search_decision_notes context.`;

    expect(needsPromptUpgrade(custom)).toBe(true);
    const upgraded = upgradeLegacyPrompt(custom);
    expect(upgraded).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(upgraded).toContain('Preserve this workspace-specific routing guidance.');
    expect(upgraded).toContain('automatedOutcomes');
    expect(upgraded).not.toContain('Admin decision notes carry high weight');
  });
});

describe('NT-9: customization detection', () => {
  test('current default is not customized', () => {
    expect(isCustomizedPrompt(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });

  test('a default with lines removed is not customized (stale lineage)', () => {
    const stale = DEFAULT_SYSTEM_PROMPT.replace(/.*get_assignment_risk_signals.*\n/g, '');
    expect(isCustomizedPrompt(stale)).toBe(false);
  });

  test('any admin-authored line marks the prompt customized', () => {
    const custom = `${DEFAULT_SYSTEM_PROMPT}\n\n## Step 9: Shipping Room Handling\nNever treat package/shipping tickets as noise.`;
    expect(isCustomizedPrompt(custom)).toBe(true);
  });

  test('upgradeLegacyPrompt never returns the stock default for a customized prompt', () => {
    // Customized prompt that trips a marker check with no targeted patch
    // available (missing taxonomy guidance) — the old code nuked these to
    // DEFAULT_SYSTEM_PROMPT wholesale.
    const custom = `You are an IT helpdesk ticket assignment assistant. AFTER_HOURS_PRIORITY_QUEUE_V2 PRIORITY_OUTPUT_V1

## Step 1: Read the Ticket
Our workspace triages hardware tickets to the Vancouver bench first.

## Step 7: Submit Recommendation
Use search_decision_notes, get_technician_ad_profile, get_requester_site_context, get_assignment_risk_signals, get_routing_boundary_context, agentBriefingHtml, Rebound Context, automatedOutcomes, pendingReviewSuggestions, competencyCoverage, internal category/subcategory.`;

    expect(needsPromptUpgrade(custom)).toBe(true); // missing taxonomyReviewNeeded etc.
    const upgraded = upgradeLegacyPrompt(custom);
    expect(upgraded).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(upgraded).toContain('Vancouver bench');
  });
});

describe('NT-9: getPublished auto-upgrade path', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    prismaMock.$transaction.mockImplementation(async (ops) => Promise.all(ops));
    prismaMock.assignmentPromptVersion.updateMany.mockResolvedValue({ count: 1 });
  });

  test('customized prompt with no safe patch survives getPublished untouched (no new version)', async () => {
    const customPrompt = `You are an IT helpdesk ticket assignment assistant. AFTER_HOURS_PRIORITY_QUEUE_V2 PRIORITY_OUTPUT_V1

## Step 1: Read the Ticket
Our workspace triages hardware tickets to the Vancouver bench first.

## Step 7: Submit Recommendation
Use search_decision_notes, get_technician_ad_profile, get_requester_site_context, get_assignment_risk_signals, get_routing_boundary_context, agentBriefingHtml, Rebound Context, automatedOutcomes, pendingReviewSuggestions, competencyCoverage, internal category/subcategory.`;

    const publishedRow = {
      id: 55, workspaceId: 1, version: 34, status: 'published',
      systemPrompt: customPrompt, toolConfig: null,
    };
    prismaMock.assignmentPromptVersion.findFirst.mockResolvedValue(publishedRow);

    const result = await promptRepository.getPublished(1);

    expect(result).toBe(publishedRow);
    expect(result.systemPrompt).toBe(customPrompt);
    expect(prismaMock.assignmentPromptVersion.create).not.toHaveBeenCalled();
    expect(prismaMock.assignmentPromptVersion.updateMany).not.toHaveBeenCalled();
  });

  test('uncustomized stale default still upgrades, as a new labeled version row', async () => {
    // Default lineage with a scaffolding block deleted — provably nothing
    // admin-authored to lose, so wholesale refresh is allowed.
    const stalePrompt = DEFAULT_SYSTEM_PROMPT.replace(/.*get_assignment_risk_signals.*\n/g, '');
    const publishedRow = {
      id: 10, workspaceId: 2, version: 3, status: 'published',
      systemPrompt: stalePrompt, toolConfig: null,
    };
    const createdRow = {
      id: 11, workspaceId: 2, version: 4, status: 'draft',
      systemPrompt: DEFAULT_SYSTEM_PROMPT, toolConfig: null,
    };
    // 1st findFirst: published lookup; 2nd: latest-version lookup in createVersion.
    prismaMock.assignmentPromptVersion.findFirst
      .mockResolvedValueOnce(publishedRow)
      .mockResolvedValueOnce({ version: 3 });
    prismaMock.assignmentPromptVersion.create.mockResolvedValue(createdRow);
    prismaMock.assignmentPromptVersion.update.mockResolvedValue({ ...createdRow, status: 'published' });
    prismaMock.assignmentPromptVersion.findUnique.mockResolvedValue({ ...createdRow, status: 'published' });

    const result = await promptRepository.getPublished(2);

    expect(prismaMock.assignmentPromptVersion.create).toHaveBeenCalledTimes(1);
    const createArgs = prismaMock.assignmentPromptVersion.create.mock.calls[0][0];
    expect(createArgs.data.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    // Audit trail: new row, system author, explicit auto-upgrade label.
    expect(createArgs.data.createdBy).toBe('system');
    expect(createArgs.data.notes).toContain('auto-upgrade');
    expect(createArgs.data.notes).toContain('v3');
    expect(result.systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
    expect(result.status).toBe('published');
  });

  test('customized prompt with a safe targeted patch upgrades without losing custom text', async () => {
    const customPrompt = `You are the Accounting assignment assistant. AFTER_HOURS_PRIORITY_QUEUE_V2 PRIORITY_OUTPUT_V1

## Step 1: Read the Ticket
Preserve this workspace-specific routing guidance.

${LEGACY_DECISION_NOTES_SECTION}

## Step 7: Submit Recommendation
Call **submit_recommendation** using search_decision_notes context.`;

    const publishedRow = {
      id: 20, workspaceId: 3, version: 7, status: 'published',
      systemPrompt: customPrompt, toolConfig: null,
    };
    prismaMock.assignmentPromptVersion.findFirst
      .mockResolvedValueOnce(publishedRow)
      .mockResolvedValueOnce({ version: 7 });
    prismaMock.assignmentPromptVersion.create.mockImplementation(({ data }) => Promise.resolve({
      id: 21, workspaceId: 3, version: 8, status: 'draft', systemPrompt: data.systemPrompt, toolConfig: null,
    }));
    prismaMock.assignmentPromptVersion.update.mockResolvedValue({});
    prismaMock.assignmentPromptVersion.findUnique.mockImplementation(() => Promise.resolve({
      id: 21,
      workspaceId: 3,
      version: 8,
      status: 'published',
      systemPrompt: prismaMock.assignmentPromptVersion.create.mock.calls[0][0].data.systemPrompt,
      toolConfig: null,
    }));

    const result = await promptRepository.getPublished(3);

    const newPrompt = prismaMock.assignmentPromptVersion.create.mock.calls[0][0].data.systemPrompt;
    expect(newPrompt).not.toBe(DEFAULT_SYSTEM_PROMPT);
    expect(newPrompt).toContain('Preserve this workspace-specific routing guidance.');
    expect(newPrompt).toContain('automatedOutcomes');
    expect(result.version).toBe(8);
  });
});
