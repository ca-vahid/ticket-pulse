import { analyzeTicketActivities, transformTicket } from '../src/integrations/freshserviceTransformer.js';

/** MEGA 09-01 Phase TU-3d/f — transformer hygiene. */

describe('group_changed parser (TU-3f)', () => {
  const activity = (content) => ({
    id: 1,
    actor: { id: 100, name: 'Ticket Workflow' },
    content,
    created_at: '2026-09-01T10:00:00Z',
  });

  test('strips a chained ", set Type as …" from the group name', () => {
    const { events } = analyzeTicketActivities([activity('Ticket Workflow set Group as Accounts Payable, set Type as Incident')]);
    const group = events.find((e) => e.type === 'group_changed');
    expect(group.groupName).toBe('Accounts Payable');
  });

  test('strips a chained " and set Status as …" too, and keeps "none" → null', () => {
    const chained = analyzeTicketActivities([activity('Kirsten Fanning set Group as Accounts Receivable and set Status as Open')]);
    expect(chained.events.find((e) => e.type === 'group_changed').groupName).toBe('Accounts Receivable');
    const cleared = analyzeTicketActivities([activity('Ticket Workflow set Group as none')]);
    expect(cleared.events.find((e) => e.type === 'group_changed').groupName).toBeNull();
  });

  test('a plain group line is unchanged', () => {
    const { events } = analyzeTicketActivities([activity('Anton K set Group as IT Operations')]);
    expect(events.find((e) => e.type === 'group_changed').groupName).toBe('IT Operations');
  });
});

describe('transformTicket spam/deleted passthrough (TU-3d)', () => {
  const base = { id: 240001, subject: 'x', status: 2, priority: 2, created_at: '2026-09-01T10:00:00Z' };

  test('explicit flags ride through; absent flags stay undefined (list payloads)', () => {
    expect(transformTicket({ ...base, spam: false, deleted: false })).toEqual(expect.objectContaining({ spam: false, deleted: false, status: 'Open' }));
    expect(transformTicket({ ...base, spam: true })).toEqual(expect.objectContaining({ spam: true, status: 'Spam' }));
    const fromList = transformTicket(base);
    expect(fromList.spam).toBeUndefined();
    expect(fromList.deleted).toBeUndefined();
  });
});
