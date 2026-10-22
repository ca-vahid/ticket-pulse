/**
 * QA 10-21: the small pure pieces.
 *  #1 vacationTrackerState — how a request reached Vacation Tracker, in words.
 *  #2 the survey line on the agent's Teams card.
 *  #4 {{ requester.firstName }}.
 *  #10 one base font for workflow e-mail; {{ agent.name }} flagged as not a variable.
 */
import { jest } from '@jest/globals';

const prismaMock = {
  avRequest: { findMany: jest.fn(), findUnique: jest.fn() },
  avPerson: { findMany: jest.fn() },
};
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: prismaMock, prisma: prismaMock }));

const { requesterFirstName, requesterContextFromSource } = await import('../src/services/requesterProfileService.js');
const { lintWorkflowDefinition, suggestVariable } = await import('../src/services/notificationWorkflowWatchService.js');
const { withBaseFont, bulletproofButtons } = await import('../src/utils/emailHtmlHardening.js');
const { eventText, EVENTS, EVENT_MAP } = await import('../src/services/teamsNotificationService.js');
const { vacationTrackerState } = await import('../src/services/availability/availabilityService.js');
const { notificationVariableCatalog } = await import('../src/services/notificationWorkflowDefinition.js');

describe('requester first name (#4)', () => {
  test.each([
    [{ name: 'Sam Khadem' }, 'Sam'],
    [{ name: 'Khadem, Sam' }, 'Sam'],
    [{ name: 'Sam Khadem (Contractor)' }, 'Sam'],
    [{ name: '', email: 'sam.khadem@example.com' }, 'Sam'],
    [{ name: null, email: null }, null],
  ])('%j → %s', (requester, expected) => {
    expect(requesterFirstName(requester)).toBe(expected);
  });

  test('rides on the requester context and is in the variable picker', () => {
    expect(requesterContextFromSource({ id: 1, name: 'Maria Lopez', email: 'm@example.com' }).firstName).toBe('Maria');
    const row = notificationVariableCatalog().find((v) => v.path === 'requester.firstName');
    expect(row).toMatchObject({ label: 'Requester first name', group: 'Requester', token: '{{ requester.firstName }}' });
  });
});

describe('unknown variables (#10)', () => {
  const def = (html) => ({ nodes: [{ id: 'send', type: 'send_email', data: { label: 'Send email', html } }] });

  test('{{ agent.name }} is flagged with the variable it most likely meant', () => {
    const [finding, ...rest] = lintWorkflowDefinition(def('<td>{{ agent.name }}</td>'));
    expect(rest).toEqual([]);
    expect(finding).toMatchObject({ code: 'unknown_variable', nodeId: 'send', variable: 'agent.name', suggestion: 'assignedAgent.name' });
    expect(finding.message).toMatch(/comes out blank\. Did you mean \{\{ assignedAgent\.name \}\}\?/);
  });

  test('real variables, run links, loop variables and Liquid literals are not flagged', () => {
    const html = '{{ ticket.displayRef }} {{ requester.firstName }} {{ assignedAgent.name }} {{ feedbackUrl }} {{ publicStatusUrl }}'
      + ' {% for tag in ticket.tags %}{{ tag }}{{ forloop.index }}{% endfor %} {% assign who = requester.name %}{{ who }} {{ true }}';
    expect(lintWorkflowDefinition(def(html))).toEqual([]);
  });

  test('every variable root the production workflows use (21 Oct 2026) is known', () => {
    const html = '{{ ticket.subject }} {{ requester.name }} {{ afterHoursSupport.message }} {{ assignedAgent.name }} {{ event.extra.actorName }} {{ availability.nextBusinessTimeLocal }}';
    expect(lintWorkflowDefinition(def(html))).toEqual([]);
  });

  test('a name with no likely match still says it prints nothing', () => {
    expect(suggestVariable('foo', '')).toBeNull();
    expect(lintWorkflowDefinition(def('{{ foo }}'))[0].message).toMatch(/\{\{ foo \}\}, which is not a Ticket Pulse variable/);
  });
});

describe('one base font for workflow e-mail (#10)', () => {
  test('wraps a fragment once; a template font still wins inside', () => {
    const once = withBaseFont('<p>Hi</p>');
    expect(once).toBe('<div data-tp-base-font="1" style="font-family:Arial,Helvetica,sans-serif;"><p>Hi</p></div>');
    expect(withBaseFont(once)).toBe(once);
    expect(withBaseFont('<p style="font-family:Georgia">Hi</p>')).toContain('<p style="font-family:Georgia">Hi</p>');
  });

  test('a full document gets the font on its body', () => {
    expect(withBaseFont('<html><body><p>x</p></body></html>')).toBe('<html><body style="font-family:Arial,Helvetica,sans-serif;" data-tp-base-font="1"><p>x</p></body></html>');
    expect(withBaseFont('<body style="margin:0"><p>x</p></body>')).toContain('<body style="font-family:Arial,Helvetica,sans-serif;margin:0" data-tp-base-font="1">');
    expect(withBaseFont('<body style="font-family:Verdana"><p>x</p></body>')).toContain('<body style="font-family:Verdana" data-tp-base-font="1">');
  });

  test('empty stays empty and buttons are still made bulletproof', () => {
    expect(withBaseFont('')).toBe('');
    const html = bulletproofButtons(withBaseFont('<a href="https://x" style="background-color:#123456;padding:10px 16px;color:#fff">Go</a>'));
    expect(html).toContain('data-tp-base-font="1"');
    expect(html).toMatch(/<td[^>]*bgcolor="#123456"/);
  });
});

describe('survey responses in Teams (#2)', () => {
  test('a new row in "What am I told about", on by default, mapped to the agent', () => {
    expect(EVENTS.find((e) => e.key === 'survey_response')).toMatchObject({ group: 'My tickets', mode: 'teams' });
    expect(EVENT_MAP['ticket.feedback_received']).toEqual([['survey_response', 'assignee']]);
  });

  test('the card line names the requester, the rating and the comment', () => {
    const ctx = { requester: { name: 'Sam Khadem' }, ticket: {}, event: { extra: { score: 5, label: 'Great', comment: 'Quick fix, thanks' } } };
    expect(eventText('survey_response', ctx)).toBe('Sam Khadem: Rated it Great (5 of 5) — "Quick fix, thanks"');
    const changed = { requester: null, ticket: {}, event: { extra: { score: 2, label: null, comment: '', updated: true } } };
    expect(eventText('survey_response', changed)).toBe('Changed the rating to 2 of 5.');
  });
});

describe('Vacation Tracker state of a request (#1)', () => {
  const base = { status: 'approved', source: 'app', externalId: null, events: [] };
  test.each([
    [{ ...base, source: 'vacation_tracker' }, 'imported', /Came from Vacation Tracker/],
    [{ ...base, externalId: 'vt:leave-1' }, 'written', /Added to Vacation Tracker/],
    [{ ...base, events: [{ kind: 'vt_write_skipped', details: { reason: 'No Vacation Tracker leave type matches "Banked time"' } }] }, 'skipped', /it has no "Banked time" leave type/],
    [{ ...base, events: [{ kind: 'vt_write_skipped', details: { reason: 'Not a Vacation Tracker user' } }] }, 'skipped', /not a user there/],
    [{ ...base, events: [{ kind: 'vt_write_failed', details: { error: '422 LEAVE_OVERLAP' } }] }, 'failed', /refused it: 422 LEAVE_OVERLAP/],
    [{ ...base, externalId: 'vt:leave-1', status: 'cancelled', events: [{ kind: 'vt_written' }, { kind: 'vt_cancelled' }] }, 'cancelled', /Cancelled in Vacation Tracker too/],
    [{ ...base, status: 'pending' }, 'not_sent', /Only approved requests/],
    [{ ...base }, 'waiting', /Not sent to Vacation Tracker yet/],
  ])('%#', (request, state, label) => {
    const out = vacationTrackerState(request);
    expect(out.state).toBe(state);
    expect(out.label).toMatch(label);
  });
});
