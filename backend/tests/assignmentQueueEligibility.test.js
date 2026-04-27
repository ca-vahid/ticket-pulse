import {
  getFreshServiceTicketQueueBlocker,
  getLocalTicketQueueBlocker,
} from '../src/services/assignmentQueueEligibility.js';

describe('assignment queue eligibility', () => {
  test('blocks missing, terminal, and locally assigned tickets', () => {
    expect(getLocalTicketQueueBlocker(null).reason).toBe('Ticket no longer exists');
    expect(getLocalTicketQueueBlocker({ status: 'Deleted', assignedTechId: null }).reason)
      .toBe('Ticket already Deleted');
    expect(getLocalTicketQueueBlocker({ status: 'Open', assignedTechId: 12 }).reason)
      .toBe('Ticket already assigned to a technician');
    expect(getLocalTicketQueueBlocker({ status: 'Open', assignedTechId: null })).toBeNull();
  });

  test('blocks FreshService hard deletes and soft deletes as local Deleted', () => {
    expect(getFreshServiceTicketQueueBlocker(null)).toMatchObject({
      valid: false,
      localStatus: 'Deleted',
    });
    expect(getFreshServiceTicketQueueBlocker({ deleted: true, status: 5 })).toMatchObject({
      valid: false,
      localStatus: 'Deleted',
    });
  });

  test('blocks FreshService spam, terminal status, inaccessible, and externally assigned tickets', () => {
    expect(getFreshServiceTicketQueueBlocker({ spam: true })).toMatchObject({
      valid: false,
      localStatus: 'Spam',
    });
    expect(getFreshServiceTicketQueueBlocker({ status: 5 })).toMatchObject({
      valid: false,
      localStatus: 'Closed',
    });
    expect(getFreshServiceTicketQueueBlocker({ __forbidden: true })).toMatchObject({
      valid: false,
      shouldUpdateTicket: false,
    });
    expect(getFreshServiceTicketQueueBlocker({ status: 2, responder_id: 123 })).toMatchObject({
      valid: false,
      freshserviceResponderId: 123,
    });
    expect(getFreshServiceTicketQueueBlocker({ status: 2, responder_id: null })).toBeNull();
  });
});
