import { classifyIntake, INTAKE_LABELS } from '../src/services/analyticsService.js';

/**
 * QA 09-18 #2 — intake method: who created the ticket and how it arrived,
 * not the source an agent picked. Field Equipment's 341 "Email" tickets were
 * mostly agents logging by hand with Source = Email.
 */
describe('classifyIntake', () => {
  const fs = (over = {}) => ({ origin: 'freshservice', source: 1, toEmails: [], ...over });

  test('FreshService creation activity is the truth when synced', () => {
    expect(classifyIntake(fs(), true)).toBe('agent');            // agent created it, picked Email
    expect(classifyIntake(fs(), false)).toBe('emailed');         // the requester's own mail
    expect(classifyIntake(fs({ source: 2 }), false)).toBe('portal');
    expect(classifyIntake(fs({ source: 3 }), true)).toBe('agent');
  });

  test('without the activity feed, the To: header decides an Email ticket; other sources are agent-logged', () => {
    expect(classifyIntake(fs({ toEmails: ['fieldequipment@bgcengineering.ca'] }), null)).toBe('emailed');
    expect(classifyIntake(fs(), null)).toBe('unknown');
    expect(classifyIntake(fs({ source: 3 }), null)).toBe('agent');
    expect(classifyIntake(fs({ source: 15 }), null)).toBe('agent');
    expect(classifyIntake(fs({ source: 2 }), null)).toBe('portal');
  });

  test('integration sources never count as agents or e-mail', () => {
    expect(classifyIntake(fs({ source: 1001 }), true)).toBe('integration');
    expect(classifyIntake(fs({ source: 1002 }), null)).toBe('integration');
  });

  test('Ticket Pulse–born tickets carry their own lane on the source code', () => {
    const tp = (source) => ({ origin: 'ticketpulse', source, toEmails: [] });
    expect(classifyIntake(tp(1), null)).toBe('emailed');       // mailbox intake
    expect(classifyIntake(tp(103), null)).toBe('agent');       // logged in the app
    expect(classifyIntake(tp(3), null)).toBe('agent');
    expect(classifyIntake(tp(105), null)).toBe('integration'); // ContinuIT
    expect(classifyIntake(tp(104), null)).toBe('integration'); // Simorgh
    expect(classifyIntake(tp(2), null)).toBe('portal');
  });

  test('every bucket has a label', () => {
    for (const key of ['emailed', 'agent', 'portal', 'integration', 'unknown']) expect(INTAKE_LABELS[key]).toBeTruthy();
  });
});
