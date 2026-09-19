import { readFileSync } from 'node:fs';

/** The roll-up hooks sit where a status or a parent changes (Simorgh B8). */
const svc = readFileSync(new URL('../src/services/ticketService.js', import.meta.url), 'utf8');
const links = readFileSync(new URL('../src/services/ticketLinkService.js', import.meta.url), 'utf8');

describe('changeStatus', () => {
  const body = svc.slice(svc.indexOf('async changeStatus('), svc.indexOf('async assignTicket('));

  test('blocks a terminal move over open children BEFORE anything is written', () => {
    const block = body.indexOf('assertNoOpenChildren(ticket.id, workspaceId)');
    const write = body.indexOf('await prisma.ticket.update(');
    expect(block).toBeGreaterThan(-1);
    expect(block).toBeLessThan(write);
    expect(body).toContain('if (isTerminal && !wasTerminal) await ticketRollUpService.assertNoOpenChildren');
  });

  test('a closing ticket drops its own ready-to-close mark', () => {
    expect(body).toContain('if (isTerminal) patch.readyToCloseAt = null;');
  });

  test('after the write, the parent is recomputed; a reopening parent recomputes itself', () => {
    expect(body).toContain('await ticketRollUpService.afterChildStatusChange(ticket.id, workspaceId, { actor });');
    expect(body).toContain('if (wasTerminal && !isTerminal) await ticketRollUpService.recomputeReadiness(ticket.id, workspaceId, { actor });');
  });
});

describe('assignTicket hands open unassigned tasks to the new owner', () => {
  const body = svc.slice(svc.indexOf('async assignTicket('), svc.indexOf('async _isAiOverride('));
  test('fire-and-forget, only when somebody was assigned', () => {
    expect(body).toContain("if (targetId !== null && updated.assignedTech?.email)");
    expect(body).toContain('notifyOwnerOfOpenTasks(ticket.id, workspaceId, updated.assignedTech)');
  });
});

describe('attaching or detaching a child recomputes the parent(s)', () => {
  test('setParent covers the new parent and a replaced one; removeParent the old parent', () => {
    expect(links).toContain("await this._recomputeRollUp(workspaceId, [parentId, existing && existing.ticketId !== parentId ? existing.ticketId : null], actor);");
    expect(links).toContain('await this._recomputeRollUp(workspaceId, [link.ticketId], actor);');
  });
});
