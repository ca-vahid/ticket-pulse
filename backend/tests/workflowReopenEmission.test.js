import { jest, describe, expect, test } from '@jest/globals';
import { readFileSync } from 'node:fs';

/**
 * FR 09-11 #4 (review) — the seeded "Reopen on requester reply" workflow
 * reopens a TP-born ticket through a direct prisma.ticket.update and then
 * emits only ticket.fields_updated with status excluded. So the brand-new
 * ticket.reopened trigger never fired for the one case QA actually tested.
 *
 * The fix emits exactly ticket.reopened from that write, loop-guarded by
 * workflowId like fields_updated. It deliberately does NOT start emitting
 * status_changed from workflow writes — that is a standing decision that
 * keeps status-setting workflows from cascading into one another.
 */

// The engine imports half the codebase; mock the edges so the module loads.
jest.unstable_mockModule('../src/services/prisma.js', () => ({ default: {} }));
jest.unstable_mockModule('../src/utils/logger.js', () => ({
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const { isWorkflowReopen } = await import('../src/services/notificationWorkflowEngine.js');
const src = readFileSync(new URL('../src/services/notificationWorkflowEngine.js', import.meta.url), 'utf8');

describe('isWorkflowReopen — closed → open, on BASES not names', () => {
  test.each([
    ['Closed', 'Open'],
    ['Resolved', 'Open'],
    ['Closed', 'Pending'],
  ])('%s -> %s is a reopen', (from, to) => {
    expect(isWorkflowReopen(from, to)).toBe(true);
  });

  test.each([
    ['Open', 'Pending'],
    ['Pending', 'Open'],
    ['Open', 'Closed'],
    ['Resolved', 'Closed'],
    ['Closed', 'Closed'],
  ])('%s -> %s is NOT a reopen', (from, to) => {
    expect(isWorkflowReopen(from, to)).toBe(false);
  });

  test('missing bases never count as a reopen (fail closed)', () => {
    expect(isWorkflowReopen(null, 'Open')).toBe(false);
    expect(isWorkflowReopen('Closed', null)).toBe(false);
    expect(isWorkflowReopen(undefined, undefined)).toBe(false);
  });

  test('honours the registry\'s terminal list, so a custom terminal base counts', () => {
    expect(isWorkflowReopen('Signed off', 'In progress', ['Signed off', 'Closed'])).toBe(true);
    expect(isWorkflowReopen('In progress', 'With client', ['Signed off', 'Closed'])).toBe(false);
  });
});

describe('the update_ticket node is wired to it', () => {
  test('the reopen emission runs right after the direct status write', () => {
    // Order matters: the ticket row must already say Open when the trigger
    // hydrates it, otherwise conditions on ticket.status see the OLD value.
    const write = src.indexOf('await prisma.ticket.update({ where: { id: ticket.id }, data: patch });');
    const emit = src.indexOf('await emitWorkflowReopened({ ticket, patch, workflowId });');
    expect(write).toBeGreaterThan(-1);
    expect(emit).toBeGreaterThan(write);
    expect(emit - write).toBeLessThan(1200); // same function, not somewhere else by coincidence
  });

  test('it emits ticket.reopened, loop-guarded by the originating workflow', () => {
    expect(src).toMatch(/emitTicketEvent\('ticket\.reopened', ticket\.id, \{[\s\S]{0,300}source: workflowId \? `workflow:\$\{workflowId\}` : 'workflow'/);
    expect(src).toMatch(/reopened: true,[\s\S]{0,80}actorKind: 'workflow'/);
  });

  test('status_changed is still NOT emitted from workflow writes (standing decision)', () => {
    const fn = src.slice(src.indexOf('async function emitWorkflowReopened'), src.indexOf('async function emitWorkflowFieldsUpdated'));
    expect(fn).not.toContain("'ticket.status_changed'");
    expect(fn).not.toContain("'ticket.resolved_closed'");
  });

  test('the base lookup is per workspace, not the canonical names', () => {
    expect(src).toMatch(/statusService\.baseStatusOf\(ticket\.workspaceId, from\)/);
    expect(src).toMatch(/statusService\.baseStatusOf\(ticket\.workspaceId, to\)/);
  });
});
