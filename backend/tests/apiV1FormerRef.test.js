import { jest } from '@jest/globals';

/**
 * FreshService switch (25 Nov 2026): a ticket adopted from FreshService carries
 * `formerRef: '#<old FS number>'` in the public v1 ticket shape and in the
 * lifecycle webhook payload. Every other ticket has formerRef null. Additive only.
 */

jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { ticketShape, formerRefOf } = await import('../src/routes/apiV1.routes.js');
const { webhookPayloadFromContext, buildEventContext } = await import('../src/services/ticketLifecycleNotificationService.js');

const adopted = {
  id: 900, displayRef: 'TP-1500', origin: 'ticketpulse', nativeNumber: 1500, mirrorState: 'adopted',
  freshserviceTicketId: 245123n, subject: 'Invoice question', status: 'Open', priority: 2, workspaceId: 5,
};
const tpBorn = { ...adopted, id: 901, nativeNumber: 1501, displayRef: 'TP-1501', mirrorState: 'mirrored', freshserviceTicketId: 245200n };
const fsBorn = { ...adopted, id: 902, origin: 'freshservice', nativeNumber: null, displayRef: '#245300', mirrorState: null, freshserviceTicketId: 245300n };

describe('v1 ticket shape', () => {
  test('an adopted ticket carries its old FreshService reference', () => {
    expect(ticketShape(adopted).formerRef).toBe('#245123');
    expect(ticketShape(adopted).ref).toBe('TP-1500');
  });

  test('TP-born and FS-born tickets carry none', () => {
    expect(ticketShape(tpBorn).formerRef).toBeNull();
    expect(ticketShape(fsBorn).formerRef).toBeNull();
    expect(formerRefOf({ mirrorState: 'adopted', freshserviceTicketId: null })).toBeNull();
  });
});

describe('lifecycle webhook payload', () => {
  test('formerRef rides the event context into the payload for an adopted ticket only', () => {
    const ctx = buildEventContext({ event: { type: 'ticket.status_changed', occurredAt: new Date().toISOString() }, ticket: adopted, source: 'ticketpulse' });
    expect(ctx.ticket.formerRef).toBe('#245123');
    expect(webhookPayloadFromContext(ctx).ticket.formerRef).toBe('#245123');

    const other = buildEventContext({ event: { type: 'ticket.status_changed', occurredAt: new Date().toISOString() }, ticket: tpBorn, source: 'ticketpulse' });
    expect(other.ticket.formerRef).toBeNull();
    expect(webhookPayloadFromContext(other).ticket.formerRef).toBeNull();
  });
});
