import { buildUserMessage } from '../src/services/assignmentUserMessage.js';

const baseArgs = {
  ticketId: 12345,
  dayOfWeek: 'Tuesday',
  localDate: '2026-04-21',
  localTime: '14:32',
  wsTz: 'America/Los_Angeles',
};

describe('buildUserMessage — non-rebound runs', () => {
  test('omits Rebound Context when reboundFrom is undefined', () => {
    const msg = buildUserMessage(baseArgs);
    expect(msg).toContain('Analyze ticket ID 12345');
    expect(msg).toContain('Current date/time: Tuesday, 2026-04-21 at 14:32');
    expect(msg).not.toContain('Rebound Context');
  });

  test('omits Rebound Context when reboundFrom is null', () => {
    const msg = buildUserMessage({ ...baseArgs, reboundFrom: null });
    expect(msg).not.toContain('Rebound Context');
  });

  test('omits Rebound Context when reboundFrom is empty object', () => {
    // Defensive: an empty object can sneak in if syncService partially populated
    // the snapshot. We treat "no useful fields" as "not a rebound" rather than
    // emitting a half-blank context block to the LLM.
    const msg = buildUserMessage({ ...baseArgs, reboundFrom: {} });
    expect(msg).not.toContain('Rebound Context');
  });
});

describe('buildUserMessage — rebound runs', () => {
  test('injects Rebound Context with previous tech name and ordinal', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      reboundFrom: {
        previousTechName: 'Andrew Smith',
        unassignedAt: '2026-04-21T20:14:00.000Z',
        reboundCount: 1,
      },
    });

    expect(msg).toContain('## Rebound Context');
    expect(msg).toContain('1st attempt');
    expect(msg).toContain('returned by Andrew Smith');
    // The unassigned timestamp gets formatted into the workspace timezone (PT
    // here), so 20:14 UTC should render as 13:14 PDT (April is daylight time).
    expect(msg).toMatch(/2026-04-21 13:14/);
  });

  test('uses correct ordinals for 2nd / 3rd attempts', () => {
    const m2 = buildUserMessage({
      ...baseArgs,
      reboundFrom: { previousTechName: 'Bob', reboundCount: 2 },
    });
    expect(m2).toContain('2nd attempt');

    const m3 = buildUserMessage({
      ...baseArgs,
      reboundFrom: { previousTechName: 'Carol', reboundCount: 3 },
    });
    expect(m3).toContain('3rd attempt');

    const m5 = buildUserMessage({
      ...baseArgs,
      reboundFrom: { previousTechName: 'Dee', reboundCount: 5 },
    });
    expect(m5).toContain('5th attempt');
  });

  test('falls back gracefully when previousTechName is missing', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      reboundFrom: { reboundCount: 2 },
    });
    expect(msg).toContain('## Rebound Context');
    expect(msg).toContain('a previous assignee');
    // Should still emit the "recently" placeholder when unassignedAt is absent
    expect(msg).toContain('returned by a previous assignee at recently');
  });

  test('instructs the LLM to avoid prior rejecters and acknowledge re-routing in the briefing', () => {
    const msg = buildUserMessage({
      ...baseArgs,
      reboundFrom: {
        previousTechName: 'Andrew',
        unassignedAt: '2026-04-21T20:14:00.000Z',
        reboundCount: 1,
      },
    });
    // Decision-rule guidance for find_matching_agents
    expect(msg).toContain('previouslyRejectedThisTicket');
    expect(msg).toMatch(/Avoid recommending any agent flagged as a prior rejecter/);
    // Briefing-tone guidance
    expect(msg).toContain('agentBriefingHtml');
    expect(msg).toMatch(/Do NOT name the previous assignee/);
    // Sanity: the briefing-tone guidance must NOT itself name the previous tech
    // (the LLM will see this in its prompt — only the higher up "returned by" line
    // mentions the name, which is fine because it's metadata for the LLM, not
    // text the LLM should copy verbatim).
    const briefingSection = msg.split('agentBriefingHtml')[1] || '';
    expect(briefingSection).not.toContain('Andrew');
  });
});
