import {
  DEFAULT_SYSTEM_PROMPT,
  needsPromptUpgrade,
  upgradeLegacyPrompt,
} from '../src/services/promptRepository.js';

/**
 * Tests for the v1.9.73-preview rebound additions:
 *  - DEFAULT_SYSTEM_PROMPT mentions Rebound Context in Step 8
 *  - Step 4 instructs the LLM to exclude prior rejecters
 *  - needsPromptUpgrade flags older prompts that have Step 8 but no Rebound Context
 *  - upgradeLegacyPrompt patches just Step 8 without disturbing other custom steps
 */
describe('rebound prompt content', () => {
  test('default prompt mentions Rebound Context in Step 8', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('Rebound Context');
    // The neutral acknowledgement guidance should be there too
    expect(DEFAULT_SYSTEM_PROMPT).toContain('returned to the queue');
  });

  test('default prompt instructs Step 4 to exclude prior rejecters', () => {
    expect(DEFAULT_SYSTEM_PROMPT).toContain('previouslyRejectedThisTicket');
    expect(DEFAULT_SYSTEM_PROMPT).toMatch(/exclude those candidates/i);
  });

  test('default prompt is not flagged as needing upgrade', () => {
    expect(needsPromptUpgrade(DEFAULT_SYSTEM_PROMPT)).toBe(false);
  });
});

describe('rebound prompt upgrade detector', () => {
  test('flags a v1.9.71-shape prompt (has Step 8 but no Rebound Context)', () => {
    // Simulated v1.9.71 prompt: has agentBriefingHtml step but predates rebound bullet
    const v1_71 = `You are an IT helpdesk ticket assignment assistant.

## Step 1: Read the Ticket
Call get_ticket_details and search_decision_notes.

## Step 4: Find Matching Agents
Call find_matching_agents to get a ranked list. Use get_technician_ad_profile for seniority.

## Step 8: Write the Agent-Facing Briefing (CRITICAL)
The submit_recommendation tool takes TWO separate write-ups, and you must populate both correctly:

**\`overallReasoning\` — INTERNAL audit log.** Mention scores, ranks, candidates considered.

**\`agentBriefingHtml\` — PUBLIC note posted to the ticket.** This is what the assigned technician will read.

For the briefing, never include scores, ranks, percentages, or names of OTHER technicians.

Do include:
- A 1-2 sentence recap of what the requester needs
- A short, plain-language reason this is being routed to them
- Any directly relevant KB links or related ticket IDs surfaced during research

Format with simple HTML.`;

    expect(needsPromptUpgrade(v1_71)).toBe(true);
  });

  test('does not flag a prompt that already contains Rebound Context', () => {
    const upToDate = `You are an IT helpdesk ticket assignment assistant.

## Step 1: Read the Ticket
Call get_ticket_details and search_decision_notes.

## Step 4: Find Matching Agents
Call find_matching_agents. Use get_technician_ad_profile.

## Step 8: Write the Agent-Facing Briefing
agentBriefingHtml — public note. If a Rebound Context block was present in the user message, include a brief acknowledgement.`;

    // This passes ONLY because we explicitly added the marker — proves the
    // detector keys on the literal "Rebound Context" string, not on a regex
    // that would false-positive on similar text.
    expect(needsPromptUpgrade(upToDate)).toBe(false);
  });
});

describe('rebound prompt upgrade transformer', () => {
  test('upgrades a v1.9.71-shape prompt to include Rebound Context guidance', () => {
    const v1_71 = `You are an IT helpdesk ticket assignment assistant.

## Step 1: Read the Ticket
Call get_ticket_details. Use search_decision_notes for past admin choices.

## Step 4: Find Matching Agents
Call find_matching_agents to get the ranked list. Use get_technician_ad_profile when needed.

## Step 5b: Check Decision History
search_decision_notes finds past admin overrides.

## Step 8: Write the Agent-Facing Briefing (CRITICAL)
The submit_recommendation tool takes TWO separate write-ups.

**\`overallReasoning\` — INTERNAL audit log.**

**\`agentBriefingHtml\` — PUBLIC note posted to the ticket.**

For the briefing, never include:
- Numerical scores, ranks, percentages, or confidence values
- Names of OTHER technicians who were considered or ruled out

Do include:
- A 1-2 sentence recap of what the requester needs
- A short, plain-language reason this is being routed to them
- Any directly relevant KB links or related ticket IDs surfaced during research

Format with simple HTML.`;

    const upgraded = upgradeLegacyPrompt(v1_71);

    expect(upgraded).toContain('Rebound Context');
    expect(upgraded).toContain('returned to the queue');
    // The other custom steps must still be intact — the upgrade replaces just
    // Step 8, not the whole prompt body.
    expect(upgraded).toContain('## Step 1: Read the Ticket');
    expect(upgraded).toContain('## Step 5b: Check Decision History');
    // And the briefing rules block now contains the new Do-include bullet
    expect(upgraded).toMatch(/Do NOT name the previous assignee/);
  });

  test('idempotent — running upgrade twice produces the same output', () => {
    // Realistic v1.9.71-shape prompt that has all the markers we care about
    // EXCEPT Rebound Context. Without this completeness the unrelated
    // detector branches (missing get_technician_ad_profile / search_decision_notes)
    // would force a second upgrade pass and break idempotence.
    const v1_71 = `You are an IT helpdesk ticket assignment assistant.

## Step 1: Read the Ticket
Call get_ticket_details.

## Step 4: Find Matching Agents
Call find_matching_agents. Use get_technician_ad_profile for seniority.

## Step 5b: Check Decision History
Use search_decision_notes for past admin choices.

## Step 8: Write the Agent-Facing Briefing
agentBriefingHtml is the public note. Do not include scores or names of OTHER technicians.

Do include:
- A 1-2 sentence recap of what the requester needs
- A short, plain-language reason this is being routed to them
- Any directly relevant KB links or related ticket IDs surfaced during research`;

    expect(needsPromptUpgrade(v1_71)).toBe(true);
    const once = upgradeLegacyPrompt(v1_71);
    expect(needsPromptUpgrade(once)).toBe(false);
    const twice = upgradeLegacyPrompt(once);
    expect(twice).toBe(once);
  });
});
