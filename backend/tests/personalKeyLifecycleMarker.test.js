import { jest } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * Personal API keys (4.4.05), review #10 and #11:
 *   - a status-family event that resolves or closes a ticket through a personal
 *     key carries the additive `extra.resolvedVia: 'personal_key'`, which rides
 *     the webhook payload's `extra`;
 *   - Urgent response and HR lifecycle treat actorKind 'personal_key' as a person.
 */
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({ default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

const { stampResolvedVia, webhookPayloadFromContext } = await import('../src/services/ticketLifecycleNotificationService.js');

describe('stampResolvedVia', () => {
  test('a status change into a Resolved or Closed base, and ticket.resolved_closed, get the marker', () => {
    expect(stampResolvedVia({ type: 'ticket.status_changed', extra: { from: 'Open', to: 'Resolved', toBase: 'Resolved' } }, 'personal_key').extra.resolvedVia).toBe('personal_key');
    expect(stampResolvedVia({ type: 'ticket.status_changed', extra: { from: 'Open', to: 'Done', toBase: 'Closed' } }, 'personal_key').extra.resolvedVia).toBe('personal_key');
    expect(stampResolvedVia({ type: 'ticket.resolved_closed', extra: {} }, 'personal_key').extra.resolvedVia).toBe('personal_key');
  });

  test('never on a move to an open status, on other events, or without a personal key', () => {
    expect(stampResolvedVia({ type: 'ticket.status_changed', extra: { toBase: 'Pending' } }, 'personal_key').extra).not.toHaveProperty('resolvedVia');
    expect(stampResolvedVia({ type: 'ticket.reopened', extra: { toBase: 'Open' } }, 'personal_key').extra).not.toHaveProperty('resolvedVia');
    expect(stampResolvedVia({ type: 'ticket.status_changed', extra: { toBase: 'Resolved' } }, null).extra).not.toHaveProperty('resolvedVia');
  });

  test('the webhook payload carries it in `extra`, with the actor and resolvedByKind unchanged', () => {
    const event = stampResolvedVia({ type: 'ticket.status_changed', extra: { toBase: 'Resolved', actor: { kind: 'human', name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12 } } }, 'personal_key');
    const payload = webhookPayloadFromContext({ event, ticket: { id: 501, status: 'Resolved', resolvedByKind: 'human' }, workspace: { id: 1 } });
    expect(payload.extra.resolvedVia).toBe('personal_key');
    expect(payload.actor).toEqual({ kind: 'human', name: 'Dana Fox', email: 'dana.fox@example.com', technicianId: 12 });
    expect(payload.ticket.resolvedByKind).toBe('human');
  });

  test('the emitter stamps it on the status family and takes resolvedVia from the caller', () => {
    const src = readFileSync(new URL('../src/services/ticketLifecycleNotificationService.js', import.meta.url), 'utf8');
    expect(src).toMatch(/resolvedVia = null,/);
    expect(src).toMatch(/resolvedByKind: ticket\.resolvedByKind \|\| null,\s*\};\s*stampResolvedVia\(event, resolvedVia\);/);
  });
});

describe('a personal-key action is a person to Urgent response and HR lifecycle', () => {
  test('HR lifecycle: a category set through a personal key counts as set by a person', async () => {
    const prisma = (await import('../src/services/prisma.js')).default;
    prisma.ticketActivity = { findMany: jest.fn() };
    const { default: hrLifecycleService } = await import('../src/services/hrLifecycleService.js');
    const row = (actorKind) => ({ performedBy: 'Dana Fox', details: { actorKind, changes: { internalCategoryId: { from: 1, to: 2 } } } });
    prisma.ticketActivity.findMany.mockResolvedValue([row('personal_key')]);
    expect(await hrLifecycleService._categorySetByPerson(501)).toBe(true);
    prisma.ticketActivity.findMany.mockResolvedValue([row('workflow')]);
    expect(await hrLifecycleService._categorySetByPerson(501)).toBe(false);
  });

  test('Urgent response: a personal-key action is an agent touching the ticket', async () => {
    const prisma = (await import('../src/services/prisma.js')).default;
    prisma.ticketActivity = { findMany: jest.fn().mockResolvedValue([{ id: 1, activityType: 'status_changed', performedBy: 'Dana Fox', performedAt: new Date(), details: { actorKind: 'personal_key' } }]) };
    prisma.ticketThreadEntry = { findMany: jest.fn().mockResolvedValue([]) };
    const mod = await import('../src/services/urgentResponse/urgentResponseService.js');
    const svc = mod.default;
    svc._isOurs = async () => () => false;
    const out = await svc._touchedSince({}, { id: 501 }, new Date(Date.now() - 60000));
    expect(out).toEqual(expect.objectContaining({ touched: true, by: 'Dana Fox' }));
  });
});
